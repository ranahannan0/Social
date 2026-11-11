/**
 * Supabase server-side wiring (design doc §9 — server-only DB access).
 *
 * The browser NEVER talks to Supabase in Phase 2: the Express server holds
 * all keys server-side, verifies the user's JWT, and issues queries through
 * a user-scoped client (anon key + user JWT) so RLS is exercised for real.
 * The service-role client exists only for provisioning paths that RLS
 * cannot express (none in the current routes; kept explicit and minimal).
 *
 * STORAGE_MODE resolution:
 * - 'local' (default): exact Phase 1 behaviour, zero Supabase imports at
 *   runtime, health reports the truth.
 * - 'supabase': requires SUPABASE_URL + keys; workspace endpoints activate.
 */

import type { NextFunction, Request, Response } from 'express';

export type StorageMode = 'local' | 'supabase';

export function getStorageMode(): StorageMode {
  return process.env.STORAGE_MODE === 'supabase' ? 'supabase' : 'local';
}

/**
 * Single source of truth for the user-facing storage-mode label (health
 * endpoint + workspace 501 responses). 'localStorage_demo' keeps the honest
 * Phase 1 wording that data is browser-local demo storage.
 */
export function getStorageModeLabel(): string {
  return getStorageMode() === 'supabase' ? 'supabase' : 'localStorage_demo';
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
  );
}

interface LazyClients {
  admin: import('@supabase/supabase-js').SupabaseClient | null;
  factory: ((jwt: string) => import('@supabase/supabase-js').SupabaseClient) | null;
}

const clients: LazyClients = { admin: null, factory: null };

async function ensureClients(): Promise<boolean> {
  if (clients.admin && clients.factory) return true;
  if (!isSupabaseConfigured()) return false;
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL as string;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY as string;
  clients.admin = serviceKey
    ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
  clients.factory = (jwt: string) =>
    createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
  return true;
}

export interface AuthedUser {
  id: string;
  email: string | null;
  token: string;
}

/**
 * Resolves the caller from `Authorization: Bearer <supabase-jwt>`.
 * Returns null when the token is missing/invalid or Supabase is not usable.
 */
export async function resolveAuthedUser(req: Request): Promise<AuthedUser | null> {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (!(await ensureClients())) return null;

  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL as string;
  const anonKey = process.env.SUPABASE_ANON_KEY as string;
  const probe = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await probe.auth.getUser();
  if (error || !data?.user?.id) return null;
  return { id: data.user.id, email: data.user.email ?? null, token };
}

/** Express middleware: workspace endpoints are Supabase-mode + JWT gated. */
export function requireSupabaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (getStorageMode() !== 'supabase' || !isSupabaseConfigured()) {
    res.status(501).json({
      error: 'STORAGE_MODE_LOCAL',
      message:
        'Workspace import/export requires STORAGE_MODE=supabase with configured credentials. The app continues to run in local storage mode.',
      storageMode: getStorageModeLabel(),
    });
    return;
  }
  resolveAuthedUser(req)
    .then(user => {
      if (!user) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' });
        return;
      }
      (req as Request & { authedUser?: AuthedUser }).authedUser = user;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token verification failed.' });
    });
}

export function getAuthedUser(req: Request): AuthedUser {
  const u = (req as Request & { authedUser?: AuthedUser }).authedUser;
  if (!u) throw new Error('authedUser missing — requireSupabaseAuth must run first');
  return u;
}

/**
 * Conditional auth gate: in local mode, passes through (legacy open behaviour
 * for routes like /api/generate that predate Phase 2). In supabase mode,
 * behaves exactly like requireSupabaseAuth.
 *
 * Per design doc §9: "Every Express route gains JWT verification" — but the
 * gate is naturally a no-op when Supabase isn't configured, because there is
 * no JWT to verify and no upstream to verify it against. This keeps the local
 * dev + integration test harness working without auth.
 */
export function requireSupabaseAuthWhenConfigured(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (getStorageMode() !== 'supabase' || !isSupabaseConfigured()) {
    return next();
  }
  requireSupabaseAuth(req, res, next);
}

export async function getUserScopedClient(jwt: string) {
  if (!(await ensureClients())) return null;
  return clients.factory ? clients.factory(jwt) : null;
}

/**
 * Service-role admin client (server-only). Null when only the anon key is
 * configured. Used exclusively for the lookups RLS cannot express — e.g.
 * P3.4 member management needs a user id for an email address, and auth
 * users are invisible to ordinary JWTs by design. Read-only usage only:
 * all writes still flow through the caller's RLS-scoped client.
 */
export async function getAdminClient(): Promise<import('@supabase/supabase-js').SupabaseClient | null> {
  if (!(await ensureClients())) return null;
  return clients.admin;
}

/**
 * Resolves the caller's workspace (organization) through a USER-SCOPED
 * client, so RLS guarantees only member orgs are visible. Default rule
 * (no org requested): the FIRST org by created_at wins — the same rule the
 * workspace import get-or-create uses, so CRUD routes and imports always
 * land in the same workspace.
 *
 * Phase 3 multi-org: when `requestedOrgId` is provided (already validated
 * as a UUID by the caller), the resolver selects THAT org. RLS is the
 * membership gate — a non-member sees zero rows, which the caller maps to
 * 403. This makes the explicit check defense-in-depth, not the only gate.
 *
 * Returns null when the user has no org yet (pre-bootstrap account) or,
 * with a requested id, when the org does not exist or the caller is not a
 * member of it (caller decides 409 vs 403).
 */
export async function resolveUserOrgContext(
  scoped: import('@supabase/supabase-js').SupabaseClient,
  requestedOrgId?: string
): Promise<{ orgId: string; timezone: string } | null> {
  let query = scoped
    .from('organizations')
    .select('id, default_timezone')
    .order('created_at', { ascending: true })
    .limit(1);
  if (requestedOrgId) {
    // RLS scoping applies to this filtered query too: a non-member's
    // filtered select returns zero rows.
    query = query.eq('id', requestedOrgId);
  }
  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;
  const row = data[0] as { id: string; default_timezone?: string | null };
  const tzCandidate = typeof row.default_timezone === 'string' ? row.default_timezone : '';
  let timezone = 'UTC';
  if (tzCandidate) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tzCandidate }).format(new Date());
      timezone = tzCandidate;
    } catch {
      timezone = 'UTC';
    }
  }
  return { orgId: row.id, timezone };
}
