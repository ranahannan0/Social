/**
 * Auth client (Phase 2 frontend cutover — design doc §9; Phase 3 refresh).
 *
 * The browser NEVER talks to Supabase directly. Instead it posts credentials
 * to our own Express auth endpoints, which return a Supabase session. The
 * browser stores { accessToken, refreshToken, expiresAt } in sessionStorage
 * and sends `Authorization: Bearer <jwt>` on every subsequent /api call.
 *
 * Storage choice: sessionStorage (NOT localStorage). A persisted cross-tab
 * token is a broader XSS surface; sessionStorage scopes the tokens to the
 * current tab, which is the standard trade-off for SPA auth without an
 * httpOnly cookie backend.
 *
 * Phase 3 token refresh:
 * - GoTrue access JWTs live ~1h. Before an authed request, if the token is
 *   inside the refresh leeway window (or already expired) AND a refresh
 *   token exists, POST /api/auth/refresh silently renews BOTH tokens
 *   (GoTrue rotates the refresh token on every use — the new one is stored).
 * - Refreshes are single-flight: parallel requests share one renewal.
 * - If a request still lands 401, authedFetch force-refreshes once and
 *   retries the request once (safe: the first attempt was rejected at the
 *   auth gate, never executed server-side). Only a second 401 clears the
 *   session and pushes the user to the login screen.
 * - Logout sends the refresh token so the server revokes it GoTrue-side —
 *   a leaked token cannot outlive the logout.
 */

const SESSION_KEY = 'omni_plus_session_v1';
/**
 * Phase 3 multi-org: the caller's ACTIVE workspace id. authedFetch stamps
 * it as `x-org-id` on every API call so CRUD/import land in the workspace
 * the user switched to. null = no preference → server falls back to the
 * first org (pre-P3.2 behaviour). Cleared on sign-out.
 */
const ACTIVE_ORG_KEY = 'omni_plus_active_org_v1';
let activeOrgId: string | null = null;

/** Set the active workspace for all subsequent authed API calls. */
export function setActiveOrgId(orgId: string | null): void {
  activeOrgId = typeof orgId === 'string' && orgId.length > 0 ? orgId : null;
  try {
    if (activeOrgId) sessionStorage.setItem(ACTIVE_ORG_KEY, activeOrgId);
    else sessionStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    // private-browsing mode — the in-memory value still works for this page
  }
}

/** Restore the persisted active workspace (called once during auth boot). */
export function restoreActiveOrgId(): string | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_ORG_KEY);
    activeOrgId = typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    activeOrgId = null;
  }
  return activeOrgId;
}

export function getActiveOrgId(): string | null {
  return activeOrgId;
}

export interface AuthSession {
  accessToken: string;
  /** GoTrue refresh token (Phase 3). Absent in sessions from older builds. */
  refreshToken?: string | null;
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

function authHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers || {});
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (activeOrgId) headers.set('x-org-id', activeOrgId);
  return headers;
}

/**
 * Fetch with the auth header injected, Phase 3 silent renewal, and a single
 * 401 → force-refresh → retry cycle. If the retry also lands 401 the local
 * session is cleared so the AuthContext can flip the user to the login
 * screen. (Retrying after 401 is safe for every method: the first attempt
 * was rejected at the auth gate and never executed server-side.)
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ensureFreshSession();
  const first = await fetch(input, { ...init, headers: authHeaders(init) });
  if (first.status !== 401) return first;
  const s = readStored();
  if (s?.refreshToken) {
    const renewed = await ensureFreshSession(true);
    if (renewed) {
      const retry = await fetch(input, { ...init, headers: authHeaders(init) });
      if (retry.status !== 401) return retry;
    }
  }
  // Session is bad — drop it so the UI can react.
  clearSession();
  setActiveOrgId(null); // workspace selection belongs to the signed-out session
  return first;
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
    writeStored({
      accessToken: body.session.accessToken,
      refreshToken: typeof body.session.refreshToken === 'string' && body.session.refreshToken ? body.session.refreshToken : null,
      expiresAt: body.session.expiresAt ?? null,
    });
  }
  return {
    user: body?.user ?? { id: null, email },
    session: body?.session
      ? {
          accessToken: body.session.accessToken,
          refreshToken: typeof body.session.refreshToken === 'string' ? body.session.refreshToken : null,
          expiresAt: body.session.expiresAt ?? null,
        }
      : null,
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
  writeStored({
    accessToken: body.session.accessToken,
    refreshToken: typeof body.session.refreshToken === 'string' && body.session.refreshToken ? body.session.refreshToken : null,
    expiresAt: body.session.expiresAt ?? null,
  });
  return {
    user: body.user,
    session: {
      accessToken: body.session.accessToken,
      refreshToken: typeof body.session.refreshToken === 'string' ? body.session.refreshToken : null,
      expiresAt: body.session.expiresAt ?? null,
    },
  };
}

export async function signOut(): Promise<void> {
  const s = readStored();
  if (s?.accessToken) {
    // Best-effort — never block on the network call. Tokens are dropped
    // locally regardless of the response. Sending the refresh token lets the
    // server revoke the GoTrue session so a leaked token cannot outlive
    // this logout (Phase 3).
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: s.refreshToken ?? null }),
      });
    } catch {
      // Network error: tokens still dropped below.
    }
  }
  clearSession();
  setActiveOrgId(null); // the workspace selection dies with the session
}

/**
 * Verifies the current session with the server. Returns the user shape, or
 * null if there is no recoverable session. Expired-but-refreshable sessions
 * are silently renewed first (Phase 3), so a user returning to a stale tab
 * stays logged in instead of being pushed to the login screen.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  const alive = await ensureFreshSession();
  if (!alive) return null;
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
 * Proactive-refresh decision (pure — unit tested).
 * Returns true when the stored access token is expired or will expire within
 * `leewaySeconds`. `expiresAt === null` means unknown expiry: we never
 * proactively refresh (we would not know when), the 401 path handles it.
 */
export function shouldProactiveRefresh(
  expiresAt: number | null,
  nowMs: number,
  leewaySeconds = 60
): boolean {
  if (expiresAt === null) return false;
  return expiresAt * 1000 - nowMs <= leewaySeconds * 1000;
}

/**
 * Renew the session server-side. Returns true on success (tokens replaced).
 * A 401 means the refresh token itself is dead → session cleared, caller
 * should treat the user as logged out. Network/5xx failures keep the
 * existing tokens (the old access token may still work; requests will
 * surface 401 through the normal path if not).
 */
async function doRefresh(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status === 401) {
      clearSession(); // refresh token invalid/revoked — definitively logged out
      return false;
    }
    if (!res.ok) return true; // 500/501 etc — optimistic, keep current tokens
    const body = await parseJsonSafe(res);
    const session = body?.session;
    if (!session?.accessToken || typeof session.accessToken !== 'string') return true;
    writeStored({
      accessToken: session.accessToken,
      refreshToken: typeof session.refreshToken === 'string' && session.refreshToken ? session.refreshToken : null,
      expiresAt: typeof session.expiresAt === 'number' ? session.expiresAt : null,
    });
    return true;
  } catch {
    return true; // network error — optimistic, let the request try
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Make sure a usable session exists before an authed request.
 * - No stored session → false.
 * - Fresh token (outside leeway) → true, no network call.
 * - Expiring/expired with a refresh token → single-flight server renewal.
 * - No refresh token → true (nothing to renew; legacy behaviour applies).
 *
 * `force` skips the freshness check (used by the authedFetch 401 retry).
 */
export function ensureFreshSession(force = false): Promise<boolean> {
  const s = readStored();
  if (!s) return Promise.resolve(false);
  if (!force && !shouldProactiveRefresh(s.expiresAt, Date.now())) return Promise.resolve(true);
  if (!s.refreshToken) return Promise.resolve(true); // cannot renew — proceed as-is
  if (!refreshInFlight) {
    const rt = s.refreshToken;
    refreshInFlight = doRefresh(rt).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
