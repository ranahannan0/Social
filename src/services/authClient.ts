/**
 * Auth client (Phase 2 frontend cutover — design doc §9).
 *
 * The browser NEVER talks to Supabase directly. Instead it posts credentials
 * to our own Express auth endpoints, which return a Supabase access JWT. The
 * browser stores the JWT in sessionStorage and sends it as
 * `Authorization: Bearer <jwt>` on every subsequent /api call.
 *
 * Storage choice: sessionStorage (NOT localStorage). A persisted cross-tab
 * token is a broader XSS surface; sessionStorage scopes the token to the
 * current tab, which is the standard trade-off for SPA auth without an
 * httpOnly cookie backend.
 *
 * Token refresh is intentionally NOT implemented here — the access JWT is
 * used until it expires (Supabase default 1h), after which API calls start
 * returning 401 and the AuthContext will surface a "session expired" state
 * that pushes the user back to the login screen. Refresh-token handling is
 * deferred to Phase 3 (per-resource CRUD release).
 */

const SESSION_KEY = 'omni_plus_session_v1';

export interface AuthSession {
  accessToken: string;
  expiresAt: number | null; // unix seconds, may be null from upstream
}

export interface AuthUser {
  id: string | null;
  email: string;
}

export interface AuthResult {
  user: AuthUser;
  session: AuthSession | null;
  requiresEmailConfirmation?: boolean;
}

class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export { AuthError };

function readStored(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(session: AuthSession | null): void {
  try {
    if (session) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // sessionStorage can throw in private-browsing modes; fail silently —
    // the user will just have to re-login on next page load.
  }
}

/** Returns the current access token, or null if none stored. */
export function getAccessToken(): string | null {
  return readStored()?.accessToken ?? null;
}

/** Returns true if a session is stored AND not past its expiry. */
export function hasValidSession(): boolean {
  const s = readStored();
  if (!s) return false;
  if (s.expiresAt === null) return true; // unknown expiry — trust the token until 401
  // expiresAt is in seconds; Date.now() is in milliseconds.
  return s.expiresAt * 1000 > Date.now();
}

export function clearSession(): void {
  writeStored(null);
}

async function parseJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'PARSE_ERROR', message: text.slice(0, 200) };
  }
}

function throwFromResponse(status: number, body: any): never {
  const code = body?.error || 'AUTH_FAILED';
  const message = body?.message || (status === 401 ? 'Invalid credentials.' : 'Auth request failed.');
  throw new AuthError(message, status, code);
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) throwFromResponse(res.status, body);
  if (body?.session?.accessToken) {
    writeStored({ accessToken: body.session.accessToken, expiresAt: body.session.expiresAt ?? null });
  }
  return {
    user: body?.user ?? { id: null, email },
    session: body?.session ? { accessToken: body.session.accessToken, expiresAt: body.session.expiresAt ?? null } : null,
    requiresEmailConfirmation: body?.requiresEmailConfirmation ?? false,
  };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) throwFromResponse(res.status, body);
  if (!body?.session?.accessToken) {
    throw new AuthError('Login succeeded but no session was returned.', 500, 'NO_SESSION');
  }
  writeStored({ accessToken: body.session.accessToken, expiresAt: body.session.expiresAt ?? null });
  return {
    user: body.user,
    session: { accessToken: body.session.accessToken, expiresAt: body.session.expiresAt ?? null },
  };
}

export async function signOut(): Promise<void> {
  const token = getAccessToken();
  if (token) {
    // Best-effort — never block on the network call. The token is dropped
    // locally regardless of the response.
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Network error: token still dropped below.
    }
  }
  clearSession();
}

/**
 * Verifies the current session with the server. Returns the user shape, or
 * null if the token is missing/invalid/expired.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  const token = getAccessToken();
  if (!token) return null;
  const res = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearSession();
    return null;
  }
  if (!res.ok) return null;
  const body = await parseJsonSafe(res);
  return body?.user ?? null;
}

/**
 * Wrap fetch with the auth header injected. If the server returns 401, the
 * local session is cleared so the AuthContext can flip the user back to the
 * login screen.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // Session is bad — drop it so the UI can react.
    clearSession();
  }
  return res;
}
