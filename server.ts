import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { resolveTrustProxyHops } from './src/utils/proxy';
import { mapWorkspaceImport } from './src/utils/workspaceImportMapper';
import { executeWorkspaceImport, ImportExecutionError } from './src/utils/workspaceImportExec';
import {
  mapBrandPayload,
  mapDraftPayload,
  mapEventPayload,
  CrudValidationError,
} from './src/utils/crudMappers';
import {
  getStorageMode,
  getStorageModeLabel,
  isSupabaseConfigured,
  requireSupabaseAuth,
  requireSupabaseAuthWhenConfigured,
  resolveAuthedUser,
  getAuthedUser,
  getUserScopedClient,
  getAdminClient,
  resolveUserOrgContext,
} from './src/utils/supabaseServer';
import { ASSIGNABLE_MEMBER_ROLES, type OrgRole } from './src/utils/orgRoles';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

// Detect if running inside Google AI Studio preview or standalone production
const isAiStudioPreview = Boolean(
  process.env.APP_URL?.includes('run.app') ||
  process.env.AI_STUDIO ||
  process.env.ALLOW_AI_STUDIO_IFRAME === 'true'
);

// Security: Disable Express fingerprinting
app.disable('x-powered-by');

/**
 * Trust Proxy Configuration: TRUST_PROXY_HOPS
 *
 * Strict hop-count controlled proxy trust to ensure IP-based rate limiting cannot be spoofed.
 *
 * Requirements:
 * - Default to 0 (no trusted proxy: client IP resolved from socket directly).
 * - Never use 'trust proxy = true' globally (which would trust arbitrary client-supplied headers).
 * - Do not hardcode 1 without verifying deployment topology.
 * - Accept an environment-controlled numeric hop count (TRUST_PROXY_HOPS).
 * - Prevent spoofed X-Forwarded-For headers from bypassing IP-based rate limiting.
 *
 * Topology Reference:
 * - 0 hops (default): Directly exposed Node.js or local dev. No reverse proxy trusted.
 * - 1 hop: Single reverse proxy (e.g., standard Google Cloud Run, AWS ALB, Nginx).
 * - 2 hops: Two reverse proxies (e.g., Cloudflare CDN -> Cloud Run -> Node.js).
 * - N hops: N chained reverse proxies.
 */
function configureTrustProxy(appInstance: express.Express): number {
  // Primary setting is TRUST_PROXY_HOPS; fallback to TRUST_PROXY if numeric
  const envVal = process.env.TRUST_PROXY_HOPS || process.env.TRUST_PROXY;
  const hops = resolveTrustProxyHops(envVal);

  if (hops > 0) {
    appInstance.set('trust proxy', hops);
  } else {
    // 0 hops: explicitly disable proxy trust
    appInstance.set('trust proxy', false);
  }

  return hops;
}

const configuredTrustProxyHops = configureTrustProxy(app);

/**
 * Security Headers (Section 2)
 *
 * - In Development: CSP and frameguard are relaxed to prevent breaking Vite SPA
 *   dynamic imports, module scripts, eval tooling, and AI Studio development iframe.
 * - In Production: Strict Content Security Policy (CSP) is enforced.
 * - Clickjacking Protection: Standalone production uses X-Frame-Options: SAMEORIGIN.
 *   In Google AI Studio preview, CSP frame-ancestors limits framing strictly to
 *   Google AI Studio domains and self, preventing arbitrary 3rd-party framing.
 */
app.use(
  helmet({
    contentSecurityPolicy: isDev
      ? false
      : {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: isAiStudioPreview
              ? ["'self'", 'https://aistudio.google.com', 'https://*.google.com', 'https://*.run.app']
              : ["'self'"],
          },
        },
    frameguard: isDev
      ? false
      : isAiStudioPreview
      ? false // In AI Studio preview, CSP frame-ancestors enforces legitimate Google iframe embedding
      : { action: 'sameorigin' }, // Standalone production clickjacking defense
    crossOriginEmbedderPolicy: false,
    xContentTypeOptions: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// ============================================================================
// Authentication endpoints (Phase 2 frontend cutover — design doc §9)
//
// The browser NEVER talks to Supabase directly. Instead it posts credentials
// here; the server uses supabase-js server-side to sign in / sign up, and
// returns the JWT to the browser. The browser stores the JWT in sessionStorage
// and sends it as `Authorization: Bearer <jwt>` on every subsequent /api call.
//
// All four routes are honest in local mode: 501 SUPABASE_UNAVAILABLE.
// Rate limited 30/min per IP to throttle credential probing.
// ============================================================================
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  // 30/min per IP: aggressive enough to throttle credential brute-force
  // (one attempt every 2s) while leaving headroom for legitimate browser
  // flows that fan out across signup/login/me/logout in quick succession.
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many auth attempts. Try again in a minute.' },
});

interface AuthSignupBody {
  email?: unknown;
  password?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validates email + password shape. Email is checked structurally (not by RFC
 * 5322 — Supabase GoTrue does the authoritative validation). Password must be
 * >= 8 chars (Supabase default minimum).
 */
function validateAuthCredentials(body: unknown): { ok: true; email: string; password: string } | { ok: false; status: number; body: { error: string; message: string } } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: 'INVALID_BODY', message: 'Request body must be a JSON object.' } };
  }
  const b = body as AuthSignupBody;
  if (!isNonEmptyString(b.email) || !isNonEmptyString(b.password)) {
    return { ok: false, status: 400, body: { error: 'INVALID_CREDENTIALS', message: 'Email and password are required.' } };
  }
  const email = (b.email as string).trim().toLowerCase();
  const password = b.password as string;
  // Lightweight email shape check; GoTrue will reject anything stranger.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, status: 400, body: { error: 'INVALID_EMAIL', message: 'Email format is invalid.' } };
  }
  if (password.length < 8) {
    return { ok: false, status: 400, body: { error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' } };
  }
  if (password.length > 256) {
    return { ok: false, status: 400, body: { error: 'INVALID_PASSWORD', message: 'Password is too long.' } };
  }
  return { ok: true, email, password };
}

/**
 * Returns a server-side supabase-js client configured with the anon key (no
 * user JWT). Used by the auth signup/login routes to invoke GoTrue directly.
 * Returns null when Supabase is not configured.
 */
async function getAnonClient(): Promise<import('@supabase/supabase-js').SupabaseClient | null> {
  if (!isSupabaseConfigured()) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

app.post('/api/auth/signup', authRateLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  // Validate FIRST so malformed input is rejected with 400 regardless of
  // storage mode — never reaches Supabase, never returns a confusing 501
  // for what is actually a client-side error.
  const parsed = validateAuthCredentials(req.body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  if (getStorageMode() !== 'supabase' || !isSupabaseConfigured()) {
    return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Auth requires STORAGE_MODE=supabase.' });
  }
  try {
    const client = await getAnonClient();
    if (!client) return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    const { data, error } = await client.auth.signUp({
      email: parsed.email,
      password: parsed.password,
    });
    if (error) {
      // GoTrue errors: email already registered, weak password, etc.
      return res.status(400).json({ error: 'SIGNUP_FAILED', message: error.message });
    }
    if (!data.session || !data.user) {
      // Email confirmation required — return a partial response so the client
      // can prompt the user to check their inbox.
      return res.status(200).json({
        user: { id: null, email: parsed.email },
        session: null,
        requiresEmailConfirmation: true,
      });
    }
    return res.status(201).json({
      user: { id: data.user.id, email: data.user.email ?? parsed.email },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
      },
      requiresEmailConfirmation: false,
    });
  } catch (err) {
    console.error('[auth:signup] failed:', err);
    return res.status(500).json({ error: 'AUTH_FAILED', message: 'Signup failed server-side.' });
  }
});

app.post('/api/auth/login', authRateLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  // Validate FIRST (same rationale as signup).
  const parsed = validateAuthCredentials(req.body);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  if (getStorageMode() !== 'supabase' || !isSupabaseConfigured()) {
    return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Auth requires STORAGE_MODE=supabase.' });
  }
  try {
    const client = await getAnonClient();
    if (!client) return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    const { data, error } = await client.auth.signInWithPassword({
      email: parsed.email,
      password: parsed.password,
    });
    if (error || !data.session || !data.user) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    }
    return res.status(200).json({
      user: { id: data.user.id, email: data.user.email ?? parsed.email },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
      },
    });
  } catch (err) {
    console.error('[auth:login] failed:', err);
    return res.status(500).json({ error: 'AUTH_FAILED', message: 'Login failed server-side.' });
  }
});

app.post('/api/auth/refresh', authRateLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  // Phase 3: silent session renewal. The browser sends the refresh token it
  // was handed at login/signup; GoTrue rotates it on every use (new refresh
  // token returned), so the client must always replace BOTH tokens.
  const rt = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!rt || rt.length > 512) {
    return res.status(400).json({
      error: 'AUTH_VALIDATION',
      message: 'A valid refreshToken string is required.',
      errors: { refreshToken: !rt ? 'required' : 'too long' },
    });
  }
  if (getStorageMode() !== 'supabase' || !isSupabaseConfigured()) {
    return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Auth requires STORAGE_MODE=supabase.' });
  }
  try {
    const client = await getAnonClient();
    if (!client) return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    const { data, error } = await client.auth.refreshSession({ refresh_token: rt });
    if (error || !data.session) {
      // Invalid/expired/revoked refresh token — the browser must re-login.
      return res.status(401).json({ error: 'INVALID_REFRESH_TOKEN', message: 'Session could not be renewed. Please sign in again.' });
    }
    return res.status(200).json({
      user: { id: data.user?.id ?? null, email: data.user?.email ?? null },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
      },
    });
  } catch (err) {
    console.error('[auth:refresh] failed:', err);
    return res.status(500).json({ error: 'AUTH_FAILED', message: 'Session renewal failed server-side.' });
  }
});

app.post('/api/auth/logout', authRateLimiter, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
  // Logout is intentionally idempotent: it NEVER returns 401 or 501. If the
  // caller sends its refresh token AND a bearer JWT, we revoke that session
  // GoTrue-side (Phase 3) so a leaked token cannot outlive the logout; if
  // not, we still return 200 OK because the practical "logout" is the
  // browser dropping its local tokens anyway.
  //
  // Revocation mechanics (verified live, scripts/db/probeLogoutScope.mjs):
  // GoTrue's admin.signOut() wrapper sends its argument as a JWT header and
  // silently no-ops on refresh tokens. The endpoint that actually works is
  // POST /auth/v1/logout?scope=local with the refresh_token in the body —
  // it revokes exactly that one session (204), after which the token can
  // no longer renew.
  try {
    const rt = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
    const header = req.headers.authorization || '';
    const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (rt && rt.length <= 512 && jwt && getStorageMode() === 'supabase' && isSupabaseConfigured()) {
      // Best-effort revocation — never block logout on its result; the
      // browser has already dropped its copy.
      await fetch(`${process.env.SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          apikey: process.env.SUPABASE_ANON_KEY as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth:logout] failed:', err);
    return res.status(200).json({ ok: true }); // idempotent — never block logout
  }
});

app.get('/api/auth/me', authRateLimiter, async (req: Request, res: Response) => {
  // Reuses the same JWT verification path as requireSupabaseAuth, but returns
  // the user shape instead of gating a downstream handler.
  const user = await resolveAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Valid bearer token required.' });
  }
  return res.status(200).json({ user: { id: user.id, email: user.email } });
});

// ============================================================================
// Workspaces list (Phase 3 multi-org — P3.2)
// Returns every organization the caller is a member of, with their role.
// The user-scoped client means RLS filters both queries to the caller's own
// memberships; the roles are joined in JS from organization_members.
// 501 in local mode (honest — no Supabase, no orgs), 401 without a JWT.
// ============================================================================
const orgsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many workspace requests. Try again in a minute.' },
});

app.get('/api/orgs', orgsRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const user = getAuthedUser(req);
    const scoped = await getUserScopedClient(user.token);
    if (!scoped) {
      return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    }
    // ONLY the caller's own membership rows feed the role mirror. RLS
    // (members_select) also exposes the full roster, but merging every row
    // would let OTHER members' roles overwrite this caller's role per org
    // (last-row-wins on an unordered read — a real bug the P3.5 live
    // two-user matrix caught: after a transfer the OLD owner's role
    // clobbered the NEW owner's /api/orgs role mirror).
    const [orgsRes, membersRes] = await Promise.all([
      scoped.from('organizations').select('id, name, slug, default_timezone, created_at').order('created_at', { ascending: true }),
      scoped.from('organization_members').select('org_id, role').eq('user_id', user.id),
    ]);
    if (orgsRes.error) {
      console.error('[orgs] list failed:', orgsRes.error.message);
      return res.status(500).json({ error: 'ORGS_FAILED', message: 'Workspace list failed server-side.' });
    }
    const roleByOrg = new Map<string, string>();
    for (const m of (membersRes.data ?? []) as Array<{ org_id: string; role: string }>) {
      roleByOrg.set(m.org_id, m.role);
    }
    const orgs = ((orgsRes.data ?? []) as Array<Record<string, unknown>>).map(o => ({
      id: o.id as string,
      name: o.name as string,
      slug: o.slug as string,
      defaultTimezone: o.default_timezone as string,
      role: roleByOrg.get(o.id as string) ?? 'member',
      createdAt: o.created_at as string,
    }));
    return res.status(200).json({ orgs });
  } catch (err) {
    console.error('[orgs] failed:', err);
    return res.status(500).json({ error: 'ORGS_FAILED', message: 'Workspace list failed server-side.' });
  }
});

// ============================================================================
// Workspace members (Phase 3.4 — roster management)
// Org targeted by PATH param (unlike CRUD's x-org-id header):
//   GET    /api/orgs/:orgId/members            any member sees the roster
//   POST   /api/orgs/:orgId/members            admin/owner adds { email, role }
//   PATCH  /api/orgs/:orgId/members/:userId    admin/owner changes { role }
//   DELETE /api/orgs/:orgId/members/:userId    admin/owner removes a member
// The user-scoped client keeps RLS (members_* policies = can_admin) as the
// REAL gate — the server only maps outcomes to honest status codes. The one
// service-role touch: resolving an email to a user id (auth users are
// invisible to ordinary JWTs by design) and admin-only email enrichment.
// ============================================================================
const MEMBER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function prepareMemberAdmin(
  req: Request,
  res: Response,
  orgId: string
): Promise<{ scoped: import('@supabase/supabase-js').SupabaseClient; callerRole: string } | null> {
  if (!UUID_PARAM_RE.test(orgId)) {
    res.status(400).json({ error: 'INVALID_ORG_ID', message: 'The workspace id in the URL must be a UUID.' });
    return null;
  }
  const user = getAuthedUser(req);
  const scoped = await getUserScopedClient(user.token);
  if (!scoped) {
    res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    return null;
  }
  // RLS members_select exposes the caller's own row; zero rows = not a
  // member (403, existence of the org never leaked).
  const selfRes = await scoped
    .from('organization_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (selfRes.error) {
    console.error('[members] caller role lookup failed:', selfRes.error.message);
    res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Member lookup failed server-side.' });
    return null;
  }
  const role = (selfRes.data as { role?: string } | null)?.role;
  if (role !== 'admin' && role !== 'owner') {
    res.status(403).json({ error: 'MEMBER_MANAGEMENT_FORBIDDEN', message: 'Only admins and owners manage workspace members.' });
    return null;
  }
  return { scoped, callerRole: role };
}

/** Refuse to demote/remove the LAST owner (RLS would allow it — the org
 * would become unmanageable forever). Guard runs before the write. */
async function lastOwnerGuard(
  scoped: import('@supabase/supabase-js').SupabaseClient,
  orgId: string,
  targetUserId: string,
  targetRole: string
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, string> }> {
  if (targetRole !== 'owner') return { ok: true };
  const ownersRes = await scoped
    .from('organization_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('role', 'owner');
  if (ownersRes.error) {
    return { ok: false, status: 500, body: { error: 'MEMBERS_FAILED', message: 'Owner lookup failed server-side.' } };
  }
  const owners = (ownersRes.data ?? []) as Array<{ user_id: string }>;
  if (owners.length <= 1 && owners.some(o => o.user_id === targetUserId)) {
    return {
      ok: false,
      status: 409,
      body: { error: 'LAST_OWNER', message: 'Promote another admin to owner before stepping down.' },
    };
  }
  return { ok: true };
}

/**
 * Resolve an auth user id from an email address. Primary path: a direct
 * service-role read of auth.users (granted on hosted Supabase). Fallback:
 * a bounded admin.listUsers scan — the fully documented API — in case the
 * schema grant is ever unavailable. Emails are stored lowercased by GoTrue.
 */
async function findAuthUserIdByEmail(
  email: string
): Promise<{ id: string } | null | 'LOOKUP_FAILED'> {
  const admin = await getAdminClient();
  if (!admin) return 'LOOKUP_FAILED';
  const lowered = email.toLowerCase();
  try {
    const direct = await admin
      .schema('auth')
      .from('users')
      .select('id')
      .eq('email', lowered)
      .limit(1);
    if (!direct.error) {
      const row = (direct.data ?? []) as Array<{ id?: string }>;
      return row[0]?.id ? { id: row[0].id } : null;
    }
    console.warn('[members] direct auth.users read failed, falling back to listUsers:', direct.error.message);
  } catch (err) {
    console.warn('[members] direct auth.users read threw, falling back to listUsers:', err);
  }
  for (let page = 1; page <= 5; page++) {
    const listRes = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listRes.error) return 'LOOKUP_FAILED';
    const hit = listRes.data.users?.find(u => (u.email ?? '').toLowerCase() === lowered);
    if (hit) return { id: hit.id };
    if ((listRes.data.users?.length ?? 0) < 200) break;
  }
  return null;
}

app.get('/api/orgs/:orgId/members', orgsRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    if (!UUID_PARAM_RE.test(orgId)) {
      return res.status(400).json({ error: 'INVALID_ORG_ID', message: 'The workspace id in the URL must be a UUID.' });
    }
    const user = getAuthedUser(req);
    const scoped = await getUserScopedClient(user.token);
    if (!scoped) {
      return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    }
    // RLS members_select: members see the roster; non-members see zero rows.
    const rowsRes = await scoped
      .from('organization_members')
      .select('user_id, role, invited_at')
      .eq('org_id', orgId)
      .order('invited_at', { ascending: true });
    if (rowsRes.error) {
      console.error('[members] roster failed:', rowsRes.error.message);
      return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Roster lookup failed server-side.' });
    }
    const rows = (rowsRes.data ?? []) as Array<{ user_id: string; role: string; invited_at: string | null }>;
    if (rows.length === 0) {
      return res.status(403).json({ error: 'FORBIDDEN_ORG', message: 'You are not a member of this workspace.' });
    }
    // Email enrichment is admin/owner-only: roster visibility is granted to
    // every member, but email addresses are PII.
    const selfRow = rows.find(r => r.user_id === user.id);
    const canSeeEmails = selfRow?.role === 'admin' || selfRow?.role === 'owner';
    const emailById = new Map<string, string | null>();
    if (canSeeEmails) {
      const admin = await getAdminClient();
      if (admin) {
        await Promise.all(
          rows.map(async r => {
            const g = await admin.auth.admin.getUserById(r.user_id);
            emailById.set(r.user_id, g.data?.user?.email ?? null);
          })
        );
      }
    }
    const members = rows.map(r => ({
      userId: r.user_id,
      email: emailById.get(r.user_id) ?? null,
      role: r.role,
      joinedAt: r.invited_at,
    }));
    return res.status(200).json({ members });
  } catch (err) {
    console.error('[members] roster failed:', err);
    return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Roster lookup failed server-side.' });
  }
});

app.post('/api/orgs/:orgId/members', orgsRateLimiter, requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!MEMBER_EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'A valid email address is required.' });
    }
    if (typeof body.role !== 'string' || !ASSIGNABLE_MEMBER_ROLES.includes(body.role as OrgRole)) {
      return res.status(400).json({ error: 'INVALID_ROLE', message: 'Role must be one of admin, editor, viewer (owner transfer is a dedicated flow).' });
    }
    const ctx = await prepareMemberAdmin(req, res, orgId);
    if (!ctx) return;
    const found = await findAuthUserIdByEmail(email);
    if (found === 'LOOKUP_FAILED') {
      return res.status(502).json({ error: 'USER_LOOKUP_FAILED', message: 'Could not resolve that email right now — try again.' });
    }
    if (!found) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'No account with that email yet — ask them to sign up first (email invites land in a later phase).' });
    }
    const existing = await ctx.scoped
      .from('organization_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', found.id)
      .maybeSingle();
    if (existing.error) {
      console.error('[members] duplicate check failed:', existing.error.message);
      return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Member lookup failed server-side.' });
    }
    if (existing.data) {
      return res.status(409).json({ error: 'ALREADY_MEMBER', message: 'That user is already a member of this workspace.' });
    }
    // RLS members_insert (WITH CHECK can_admin) is the real gate — this
    // insert runs through the CALLER's scoped client.
    const ins = await ctx.scoped
      .from('organization_members')
      .insert({ org_id: orgId, user_id: found.id, role: body.role });
    if (ins.error) {
      console.error('[members] insert refused:', ins.error.message);
      if (ins.error.code === '23503') {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'That account no longer exists.' });
      }
      return res.status(403).json({ error: 'MEMBER_MANAGEMENT_FORBIDDEN', message: 'The server refused this membership change.' });
    }
    return res.status(201).json({ member: { userId: found.id, email, role: body.role, joinedAt: null } });
  } catch (err) {
    console.error('[members] invite failed:', err);
    return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Adding the member failed server-side.' });
  }
});

app.patch('/api/orgs/:orgId/members/:userId', orgsRateLimiter, requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const userId = String(req.params.userId ?? '');
    if (!UUID_PARAM_RE.test(userId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The member id in the URL must be a UUID.' });
    }
    const body = (req.body ?? {}) as { role?: unknown };
    if (typeof body.role !== 'string' || !ASSIGNABLE_MEMBER_ROLES.includes(body.role as OrgRole)) {
      return res.status(400).json({ error: 'INVALID_ROLE', message: 'Role must be one of admin, editor, viewer (owner transfer is a dedicated flow).' });
    }
    const ctx = await prepareMemberAdmin(req, res, orgId);
    if (!ctx) return;
    const rosterRes = await ctx.scoped
      .from('organization_members')
      .select('user_id, role')
      .eq('org_id', orgId);
    if (rosterRes.error) {
      console.error('[members] roster failed:', rosterRes.error.message);
      return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Roster lookup failed server-side.' });
    }
    const roster = (rosterRes.data ?? []) as Array<{ user_id: string; role: string }>;
    const target = roster.find(r => r.user_id === userId);
    if (!target) {
      return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: 'That user is not a member of this workspace.' });
    }
    const guard = await lastOwnerGuard(ctx.scoped, orgId, userId, target.role);
    if (!guard.ok) {
      return res.status(guard.status).json(guard.body);
    }
    const upd = await ctx.scoped
      .from('organization_members')
      .update({ role: body.role })
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (upd.error) {
      console.error('[members] update refused:', upd.error.message);
      return res.status(403).json({ error: 'MEMBER_MANAGEMENT_FORBIDDEN', message: 'The server refused this membership change.' });
    }
    return res.status(200).json({ member: { userId, role: body.role } });
  } catch (err) {
    console.error('[members] role change failed:', err);
    return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Changing the role failed server-side.' });
  }
});

app.delete('/api/orgs/:orgId/members/:userId', orgsRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const userId = String(req.params.userId ?? '');
    if (!UUID_PARAM_RE.test(userId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The member id in the URL must be a UUID.' });
    }
    const ctx = await prepareMemberAdmin(req, res, orgId);
    if (!ctx) return;
    const rosterRes = await ctx.scoped
      .from('organization_members')
      .select('user_id, role')
      .eq('org_id', orgId);
    if (rosterRes.error) {
      console.error('[members] roster failed:', rosterRes.error.message);
      return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Roster lookup failed server-side.' });
    }
    const roster = (rosterRes.data ?? []) as Array<{ user_id: string; role: string }>;
    const target = roster.find(r => r.user_id === userId);
    if (!target) {
      return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: 'That user is not a member of this workspace.' });
    }
    const guard = await lastOwnerGuard(ctx.scoped, orgId, userId, target.role);
    if (!guard.ok) {
      return res.status(guard.status).json(guard.body);
    }
    // RLS members_delete (USING can_admin) is the real gate.
    const del = await ctx.scoped
      .from('organization_members')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (del.error) {
      console.error('[members] delete refused:', del.error.message);
      return res.status(403).json({ error: 'MEMBER_MANAGEMENT_FORBIDDEN', message: 'The server refused this membership change.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[members] removal failed:', err);
    return res.status(500).json({ error: 'MEMBERS_FAILED', message: 'Removing the member failed server-side.' });
  }
});

// ============================================================================
// Workspace lifecycle (Phase 3.5/3.6 — owner powers: rename, ownership
// transfer, delete). Org targeted by PATH param, same as the member routes.
// RLS stays the real gate wherever it can express the rule (orgs_update =
// can_admin, orgs_delete = owner, members_update = can_admin); the tighter
// owner-only checks here are the effective gate because the server is the
// only database client. Same 403 for non-members and non-owners — the
// existence of an org is never leaked. 501 in local mode (honest).
// ============================================================================
async function prepareOrgOwner(
  req: Request,
  res: Response,
  orgId: string
): Promise<{ scoped: import('@supabase/supabase-js').SupabaseClient; callerId: string; callerRole: string } | null> {
  if (!UUID_PARAM_RE.test(orgId)) {
    res.status(400).json({ error: 'INVALID_ORG_ID', message: 'The workspace id in the URL must be a UUID.' });
    return null;
  }
  const user = getAuthedUser(req);
  const scoped = await getUserScopedClient(user.token);
  if (!scoped) {
    res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    return null;
  }
  // RLS members_select exposes the caller's own row; zero rows = not a
  // member. Either way the answer is the same owner-only 403.
  const selfRes = await scoped
    .from('organization_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (selfRes.error) {
    console.error('[orgs] caller role lookup failed:', selfRes.error.message);
    res.status(500).json({ error: 'ORG_ACCESS_FAILED', message: 'Workspace access lookup failed server-side.' });
    return null;
  }
  const role = (selfRes.data as { role?: string } | null)?.role;
  if (role !== 'owner') {
    res.status(403).json({ error: 'ORG_MANAGEMENT_FORBIDDEN', message: 'Only the workspace owner can do this.' });
    return null;
  }
  return { scoped, callerId: user.id, callerRole: role };
}

// Rename a workspace (owner only). The slug is immutable — it exists for
// URLs/housekeeping, not for humans to edit.
app.patch('/api/orgs/:orgId', orgsRateLimiter, requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'Workspace name must be 1-120 characters.' });
    }
    const ctx = await prepareOrgOwner(req, res, orgId);
    if (!ctx) return;
    // RLS orgs_update (USING can_admin) is the real gate behind this write.
    const upd = await ctx.scoped
      .from('organizations')
      .update({ name })
      .eq('id', orgId)
      .select('id, name, slug, default_timezone')
      .single();
    if (upd.error) {
      console.error('[orgs] rename refused:', upd.error.message);
      return res.status(403).json({ error: 'ORG_MANAGEMENT_FORBIDDEN', message: 'The server refused this workspace change.' });
    }
    const row = upd.data as Record<string, unknown>;
    return res.status(200).json({
      org: {
        id: row.id as string,
        name: row.name as string,
        slug: row.slug as string,
        defaultTimezone: row.default_timezone as string,
      },
    });
  } catch (err) {
    console.error('[orgs] rename failed:', err);
    return res.status(500).json({ error: 'ORG_UPDATE_FAILED', message: 'Renaming the workspace failed server-side.' });
  }
});

// Transfer ownership (owner only). The target must ALREADY be an admin —
// no surprise promotions. Implemented as two ordered writes through the
// CALLER's RLS-scoped client (members_update = can_admin):
//   1. promote the admin to owner   (crash here → two owners, SAFE —
//      either one can finish the job from the members list)
//   2. demote the caller to admin   (crash here → caller stays co-owner,
//      also safe; reported honestly via `warning`)
// The reverse order is forbidden by design: demoting the last owner first
// would orphan the workspace if the promotion then failed.
app.post('/api/orgs/:orgId/ownership-transfer', orgsRateLimiter, requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const body = (req.body ?? {}) as { targetUserId?: unknown };
    const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
    if (!UUID_PARAM_RE.test(targetUserId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The target member id must be a UUID.' });
    }
    const ctx = await prepareOrgOwner(req, res, orgId);
    if (!ctx) return;
    if (targetUserId === ctx.callerId) {
      return res.status(400).json({ error: 'INVALID_TARGET', message: 'You already own this workspace.' });
    }
    const targetRes = await ctx.scoped
      .from('organization_members')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .maybeSingle();
    if (targetRes.error) {
      console.error('[orgs] transfer target lookup failed:', targetRes.error.message);
      return res.status(500).json({ error: 'TRANSFER_FAILED', message: 'Ownership transfer failed server-side.' });
    }
    const targetRole = (targetRes.data as { role?: string } | null)?.role;
    if (!targetRole) {
      return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: 'That user is not a member of this workspace.' });
    }
    if (targetRole !== 'admin') {
      return res.status(409).json({ error: 'TARGET_NOT_ADMIN', message: 'Only admins can be promoted to owner — change their role first.' });
    }
    const promote = await ctx.scoped
      .from('organization_members')
      .update({ role: 'owner' })
      .eq('org_id', orgId)
      .eq('user_id', targetUserId);
    if (promote.error) {
      console.error('[orgs] promote refused:', promote.error.message);
      return res.status(403).json({ error: 'ORG_MANAGEMENT_FORBIDDEN', message: 'The server refused the ownership transfer.' });
    }
    const demote = await ctx.scoped
      .from('organization_members')
      .update({ role: 'admin' })
      .eq('org_id', orgId)
      .eq('user_id', ctx.callerId);
    if (demote.error) {
      // The transfer itself succeeded — the new owner must hear that.
      console.error('[orgs] self-demote failed:', demote.error.message);
      return res.status(200).json({
        ok: true,
        warning: 'Ownership moved, but your own role could not be changed to admin. You remain a co-owner — fix it from the members list.',
      });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[orgs] transfer failed:', err);
    return res.status(500).json({ error: 'TRANSFER_FAILED', message: 'Ownership transfer failed server-side.' });
  }
});

// Delete a workspace (owner only). Two honest guards BEFORE the write:
//   ORG_HAS_MEMBERS  — other members must be removed first, because a
//                      deleted org would silently strand any of them whose
//                      only workspace this was (there is no invite-by-email
//                      path yet that could bring them back).
//   LAST_WORKSPACE   — the caller cannot delete their only membership;
//                      the app has no "create workspace" UI yet, so they
//                      would be locked out of cloud mode entirely.
// RLS orgs_delete (org_role_at = 'owner') is the real gate; FK cascades
// remove members, brands, drafts, events, checks and settings.
app.delete('/api/orgs/:orgId', orgsRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const orgId = String(req.params.orgId ?? '');
    const ctx = await prepareOrgOwner(req, res, orgId);
    if (!ctx) return;
    const rosterRes = await ctx.scoped
      .from('organization_members')
      .select('user_id')
      .eq('org_id', orgId);
    if (rosterRes.error) {
      console.error('[orgs] delete roster lookup failed:', rosterRes.error.message);
      return res.status(500).json({ error: 'ORG_DELETE_FAILED', message: 'Workspace deletion failed server-side.' });
    }
    if ((rosterRes.data ?? []).length > 1) {
      return res.status(409).json({ error: 'ORG_HAS_MEMBERS', message: 'Remove all other members before deleting this workspace.' });
    }
    const mineRes = await ctx.scoped
      .from('organization_members')
      .select('org_id')
      .eq('user_id', ctx.callerId);
    if (mineRes.error) {
      console.error('[orgs] delete membership lookup failed:', mineRes.error.message);
      return res.status(500).json({ error: 'ORG_DELETE_FAILED', message: 'Workspace deletion failed server-side.' });
    }
    const myOrgs = ((mineRes.data ?? []) as Array<{ org_id: string }>).map(r => r.org_id);
    if (!myOrgs.some(id => id !== orgId)) {
      return res.status(409).json({ error: 'LAST_WORKSPACE', message: 'This is your only workspace — join or create another one before deleting it.' });
    }
    const del = await ctx.scoped
      .from('organizations')
      .delete()
      .eq('id', orgId);
    if (del.error) {
      console.error('[orgs] delete refused:', del.error.message);
      return res.status(403).json({ error: 'ORG_MANAGEMENT_FORBIDDEN', message: 'The server refused this workspace deletion.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[orgs] delete failed:', err);
    return res.status(500).json({ error: 'ORG_DELETE_FAILED', message: 'Workspace deletion failed server-side.' });
  }
});

// ============================================================================
// Workspace Import/Export (Phase 2 — design doc §8/§9)
// Registered BEFORE the global 64kb parser so the import route can carry its
// own 2MB limit (backup files exceed 64kb with real content).
// Both endpoints are auth-gated: 501 in local mode (honest, actionable),
// 401 without a valid Supabase bearer token, 10 req/min per IP.
// ============================================================================
const workspaceRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many workspace operations. Try again in a minute.' },
});

// Export the user's database workspace (for automation/backup pipelines).
app.get('/api/workspace/export', workspaceRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const user = getAuthedUser(req);
    const scoped = await getUserScopedClient(user.token);
    if (!scoped) {
      return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    }
    const orgs = (await scoped.from('organizations').select('*')).data ?? [];
    const workspaces = [];
    for (const org of orgs as Array<Record<string, unknown>>) {
      const orgId = org.id as string;
      const [brands, drafts, events, settings] = await Promise.all([
        scoped.from('brands').select('*').eq('org_id', orgId),
        scoped.from('content_drafts').select('*').eq('org_id', orgId),
        scoped.from('calendar_events').select('*').eq('org_id', orgId),
        scoped.from('organization_settings').select('*').eq('org_id', orgId).maybeSingle(),
      ]);
      workspaces.push({
        organization: org,
        brands: brands.data ?? [],
        drafts: drafts.data ?? [],
        calendarEvents: events.data ?? [],
        settings: settings.data ?? null,
      });
    }
    return res.json({
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      source: 'database',
      workspaces,
    });
  } catch (err) {
    console.error('[workspace:export] failed:', err);
    return res.status(500).json({ error: 'EXPORT_FAILED', message: 'Workspace export failed server-side.' });
  }
});

// Import a localStorage backup file into a NEW organization for the caller.
app.post(
  '/api/workspace/import',
  workspaceRateLimiter,
  express.json({ limit: '2mb' }),
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const user = getAuthedUser(req);
      const mapped = mapWorkspaceImport(req.body, {});
      if (!mapped.ok) {
        return res.status(400).json({ error: 'INVALID_EXPORT', errors: mapped.errors });
      }
      const scoped = await getUserScopedClient(user.token);
      if (!scoped) {
        return res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
      }
      const exportedAt = typeof req.body?.exportedAt === 'string' ? req.body.exportedAt : new Date().toISOString();
      // Phase 3 multi-org: honor the caller's active workspace. The header is
      // validated (UUID + membership through RLS) before any insert happens.
      const requestedOrgId = requestedOrgIdFrom(req);
      if (requestedOrgId === 'INVALID') {
        return res.status(400).json({ error: 'INVALID_ORG_ID', message: 'The x-org-id header must be a UUID.' });
      }
      let targetOrgId: string | undefined;
      if (requestedOrgId) {
        const orgCtx = await resolveUserOrgContext(scoped, requestedOrgId);
        if (!orgCtx) {
          return res.status(403).json({ error: 'FORBIDDEN_ORG', message: 'You are not a member of that workspace.' });
        }
        targetOrgId = orgCtx.orgId;
      }
      const report = await executeWorkspaceImport(scoped, mapped.value, exportedAt, targetOrgId);
      // 207 = partial success (rows created AND per-row errors reported)
      const status = report.errors.length > 0 ? 207 : 201;
      return res.status(status).json(report);
    } catch (err) {
      if (err instanceof ImportExecutionError) {
        return res.status(422).json({ error: 'IMPORT_FAILED', message: err.message, detail: err.detail });
      }
      console.error('[workspace:import] failed:', err);
      return res.status(500).json({ error: 'IMPORT_FAILED', message: 'Workspace import failed server-side.' });
    }
  }
);

// Security: Reduce JSON request body size limit to 64kb (appropriate for text-only inputs)
app.use(express.json({ limit: '64kb' }));

// ============================================================================
// Per-resource CRUD (Stage B — real-time sync on mutation, design doc §8b)
//
// The browser no longer waits for a manual "Sync now": every create/update/
// delete lands here within moments of the user's action. Security posture is
// identical to the workspace routes:
// - 501 STORAGE_MODE_LOCAL in local mode (honest, actionable)
// - 401 without a valid Supabase bearer token
// - every query runs through a USER-SCOPED client so RLS is exercised for
//   real, PLUS explicit org scoping (defense in depth)
// - payloads validated by src/utils/crudMappers.ts (pure, unit-tested)
//   BEFORE any DB access — client errors are clean 400s, never 23514s
// - UPDATE/DELETE pin org_id; 0 affected rows → 404 (never another tenant's
//   row, even when the id is known — the cross-tenant probe in the audit
//   smoke asserts exactly this)
// ============================================================================
const crudRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Human editing cadence with headroom for batch operations (workspace
  // reset enqueues one delete per brand). Well above any manual rate.
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many sync operations. Try again in a minute.' },
});

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CrudDeps {
  scoped: NonNullable<Awaited<ReturnType<typeof getUserScopedClient>>>;
  orgId: string;
  orgTimezone: string;
}

/**
 * Phase 3 multi-org: the optional `x-org-id` header lets a caller target a
 * specific workspace they are a member of. Absent → the first-org default
 * (backwards compatible with every Stage B client). Malformed (non-UUID)
 * → 400 before any DB work; well-formed but non-member → 403 (RLS returns
 * zero rows, so we never leak whether the org exists).
 */
function requestedOrgIdFrom(req: Request): string | null | 'INVALID' {
  const raw = req.headers['x-org-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!UUID_PARAM_RE.test(trimmed)) return 'INVALID';
  return trimmed;
}

async function prepareCrud(req: Request, res: Response): Promise<CrudDeps | null> {
  const user = getAuthedUser(req);
  const scoped = await getUserScopedClient(user.token);
  if (!scoped) {
    res.status(501).json({ error: 'SUPABASE_UNAVAILABLE', message: 'Supabase client could not be initialized.' });
    return null;
  }
  const requestedOrgId = requestedOrgIdFrom(req);
  if (requestedOrgId === 'INVALID') {
    res.status(400).json({ error: 'INVALID_ORG_ID', message: 'The x-org-id header must be a UUID.' });
    return null;
  }
  const orgCtx = await resolveUserOrgContext(scoped, requestedOrgId ?? undefined);
  if (!orgCtx) {
    if (requestedOrgId) {
      res.status(403).json({
        error: 'FORBIDDEN_ORG',
        message: 'You are not a member of that workspace.',
      });
    } else {
      res.status(409).json({
        error: 'NO_WORKSPACE',
        message: 'No cloud workspace exists for this account yet. Open the app once to bootstrap it, then retry.',
      });
    }
    return null;
  }
  return { scoped, orgId: orgCtx.orgId, orgTimezone: orgCtx.timezone };
}

function crudError(res: Response, err: unknown): Response {
  if (err instanceof CrudValidationError) {
    return res.status(400).json({ error: 'INVALID_ENTITY', errors: err.issues });
  }
  console.error('[crud] failed:', err);
  return res.status(500).json({ error: 'CRUD_FAILED', message: 'Cloud sync operation failed server-side.' });
}

// ── Brands ──────────────────────────────────────────────────────────────────
app.post('/api/brands', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapBrandPayload(req.body, { orgId: deps.orgId, mode: 'create' });
    const { data, error } = await deps.scoped.from('brands').insert(row).select('*').single();
    if (error || !data) {
      return res.status(422).json({ error: 'BRAND_CREATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    return res.status(201).json(data);
  } catch (err) {
    return crudError(res, err);
  }
});

app.patch('/api/brands/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Brand id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapBrandPayload(req.body, { mode: 'update' });
    const { data, error } = await deps.scoped
      .from('brands')
      .update(row)
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('*')
      .single();
    if (error || !data) {
      const notFound = !error || error.code === 'PGRST116';
      if (notFound) return res.status(404).json({ error: 'NOT_FOUND', message: 'Brand not found in your workspace.' });
      return res.status(422).json({ error: 'BRAND_UPDATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    return res.status(200).json(data);
  } catch (err) {
    return crudError(res, err);
  }
});

app.delete('/api/brands/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Brand id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    // DB FKs cascade: drafts, events, checks and jobs references go with it.
    const { data, error } = await deps.scoped
      .from('brands')
      .delete()
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('id');
    if (error) {
      return res.status(422).json({ error: 'BRAND_DELETE_FAILED', message: error.message });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Brand not found in your workspace.' });
    }
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    return crudError(res, err);
  }
});

// ── Drafts ──────────────────────────────────────────────────────────────────
app.post('/api/drafts', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapDraftPayload(req.body, { orgId: deps.orgId, orgTimezone: deps.orgTimezone, mode: 'create' });
    const { compliance, ...draftRow } = row;
    const { data, error } = await deps.scoped.from('content_drafts').insert(draftRow).select('*').single();
    if (error || !data) {
      return res.status(422).json({ error: 'DRAFT_CREATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    // Append-only editorial check (best effort — a check failure must not
    // fail the draft that was already created).
    let checkCreated = false;
    if (compliance) {
      const { error: checkErr } = await deps.scoped.from('compliance_checks').insert({
        org_id: deps.orgId,
        draft_id: (data as { id: string }).id,
        provider: 'rule_local',
        passed: compliance.passed,
        detected_fluff: compliance.detected_fluff,
        char_count: compliance.char_count,
        max_limit: compliance.max_limit,
        warnings: compliance.warnings,
        check_version: compliance.check_version,
      });
      checkCreated = !checkErr;
      if (checkErr) notes.push(`compliance check not stored: ${checkErr.message}`);
    }
    return res.status(201).json({ ...(data as object), ...(checkCreated || notes.length ? { checkCreated, notes } : {}) });
  } catch (err) {
    return crudError(res, err);
  }
});

app.patch('/api/drafts/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Draft id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapDraftPayload(req.body, { orgTimezone: deps.orgTimezone, mode: 'update' });
    const { compliance, ...draftRow } = row;
    const { data, error } = await deps.scoped
      .from('content_drafts')
      .update(draftRow)
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('*')
      .single();
    if (error || !data) {
      const notFound = !error || error.code === 'PGRST116';
      if (notFound) return res.status(404).json({ error: 'NOT_FOUND', message: 'Draft not found in your workspace.' });
      return res.status(422).json({ error: 'DRAFT_UPDATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    let checkCreated = false;
    if (compliance) {
      const { error: checkErr } = await deps.scoped.from('compliance_checks').insert({
        org_id: deps.orgId,
        draft_id: id,
        provider: 'rule_local',
        passed: compliance.passed,
        detected_fluff: compliance.detected_fluff,
        char_count: compliance.char_count,
        max_limit: compliance.max_limit,
        warnings: compliance.warnings,
        check_version: compliance.check_version,
      });
      checkCreated = !checkErr;
      if (checkErr) notes.push(`compliance check not stored: ${checkErr.message}`);
    }
    return res.status(200).json({ ...(data as object), ...(checkCreated || notes.length ? { checkCreated, notes } : {}) });
  } catch (err) {
    return crudError(res, err);
  }
});

app.delete('/api/drafts/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Draft id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    // calendar_events.draft_id and compliance_checks.draft_id both CASCADE.
    const { data, error } = await deps.scoped
      .from('content_drafts')
      .delete()
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('id');
    if (error) {
      return res.status(422).json({ error: 'DRAFT_DELETE_FAILED', message: error.message });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Draft not found in your workspace.' });
    }
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    return crudError(res, err);
  }
});

// ── Calendar events ─────────────────────────────────────────────────────────
app.post('/api/events', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapEventPayload(req.body, { orgId: deps.orgId, orgTimezone: deps.orgTimezone, mode: 'create' });
    const { data, error } = await deps.scoped.from('calendar_events').insert(row).select('*').single();
    if (error || !data) {
      return res.status(422).json({ error: 'EVENT_CREATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    return res.status(201).json(data);
  } catch (err) {
    return crudError(res, err);
  }
});

app.patch('/api/events/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Event id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { row, notes } = mapEventPayload(req.body, { orgTimezone: deps.orgTimezone, mode: 'update' });
    const { data, error } = await deps.scoped
      .from('calendar_events')
      .update(row)
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('*')
      .single();
    if (error || !data) {
      const notFound = !error || error.code === 'PGRST116';
      if (notFound) return res.status(404).json({ error: 'NOT_FOUND', message: 'Event not found in your workspace.' });
      return res.status(422).json({ error: 'EVENT_UPDATE_FAILED', message: error?.message ?? 'no row returned', notes });
    }
    return res.status(200).json(data);
  } catch (err) {
    return crudError(res, err);
  }
});

app.delete('/api/events/:id', crudRateLimiter, requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_PARAM_RE.test(id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: 'Event id must be a UUID.' });
    }
    const deps = await prepareCrud(req, res);
    if (!deps) return;
    const { data, error } = await deps.scoped
      .from('calendar_events')
      .delete()
      .eq('id', id)
      .eq('org_id', deps.orgId)
      .select('id');
    if (error) {
      return res.status(422).json({ error: 'EVENT_DELETE_FAILED', message: error.message });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Event not found in your workspace.' });
    }
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    return crudError(res, err);
  }
});

// Environment configuration
function resolveModelName(): string {
  const envModel = process.env.GEMINI_MODEL?.trim();
  // Ensure GEMINI_MODEL is a valid model identifier and not an accidental credential leak
  if (
    envModel &&
    !envModel.startsWith('AQ.') &&
    !envModel.startsWith('AIza') &&
    envModel.length < 50
  ) {
    return envModel;
  }
  return 'gemini-3.8-flash';
}

const configuredModel = resolveModelName();
const rawApiKey = (process.env.GEMINI_API_KEY || '').trim();

// Treat empty string or default example placeholder as unconfigured
const isKeyConfigured = Boolean(
  rawApiKey && rawApiKey !== '' && rawApiKey !== 'MY_GEMINI_API_KEY'
);

// Initialize Gemini SDK with User-Agent telemetry if real key is configured
const ai = isKeyConfigured
  ? new GoogleGenAI({
      apiKey: rawApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Supported domain enums for validation
const SUPPORTED_PLATFORMS = [
  'linkedin',
  'x',
  'instagram_reels',
  'instagram_feed',
  'youtube',
  'tiktok',
  'pinterest',
  'whatsapp',
  'email',
  'blog_seo',
] as const;

const SUPPORTED_LANGUAGES = [
  'English',
  'Roman Urdu',
  'Urdu (Script)',
  'Hindi',
  'Spanish',
  'Arabic',
] as const;

const SUPPORTED_OBJECTIVES = [
  'Awareness',
  'Lead Gen',
  'Authority',
  'Sales',
  'Engagement',
] as const;

// Banned AI Fluff Phrases as codified in Omni Channel Plus v2.0 Spec Appendix
const BANNED_PHRASES = [
  "in today's fast-paced world",
  "it's important to note",
  "delve into",
  "tapestry",
  "game-changer",
  "revolutionary",
  "cutting-edge",
  "at the forefront",
  "i'm excited to share",
  "thrilled to announce",
  "in the realm of",
  "navigating the complexities of",
  "a testament to",
  "in conclusion",
  "when it comes to",
  "leverage",
];

function detectBannedPhrases(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter(phrase => lower.includes(phrase));
}

// Platform Character & Safe Zone limits per Spec Section 2.1
const PLATFORM_LIMITS: Record<string, { maxChars: number; defaultHashtags: number; safeZoneNote?: string }> = {
  linkedin: { maxChars: 3000, defaultHashtags: 3 },
  x: { maxChars: 280, defaultHashtags: 2 },
  instagram_reels: { maxChars: 2200, defaultHashtags: 8, safeZoneNote: 'Top 180px & bottom 450px reserved for UI' },
  instagram_feed: { maxChars: 2200, defaultHashtags: 8 },
  youtube: { maxChars: 5000, defaultHashtags: 5 },
  tiktok: { maxChars: 2200, defaultHashtags: 4, safeZoneNote: 'Top 150px & bottom 400px reserved for UI' },
  pinterest: { maxChars: 500, defaultHashtags: 4 },
  whatsapp: { maxChars: 1024, defaultHashtags: 0 },
  email: { maxChars: 10000, defaultHashtags: 0 },
  blog_seo: { maxChars: 25000, defaultHashtags: 0 },
};

/**
 * RATE LIMITER SCALABILITY ARCHITECTURE NOTE (Section 5):
 *
 * The current rate limiters (for /api/generate and /api/ai-status) utilize express-rate-limit's
 * default in-memory MemoryStore.
 *
 * Operational Characteristics & Multi-Instance Limitations:
 * 1. Single-Instance / Local / AI Studio Container: MemoryStore is lightweight, has zero external
 *    network/database dependencies, and accurately limits requests per IP.
 * 2. Multi-Instance Deployments (e.g. horizontally auto-scaled Cloud Run instances, multi-pod Kubernetes):
 *    In-memory stores do NOT share state across instances. If N instances are running behind a round-robin
 *    load balancer, an IP could theoretically submit up to N * max requests across different instances
 *    unless sticky sessions or centralized storage is used.
 * 3. Future Scalability Migration (Phase 2):
 *    When Redis is provisioned as specified in the Phase 2 master architecture (for BullMQ queues and schedulers),
 *    express-rate-limit should be upgraded to use 'rate-limit-redis' store backed by the Redis cluster.
 *    Per engineering instructions, Redis is not added in Phase 1 to avoid unnecessary overhead before
 *    the distributed queue layer is implemented.
 */

// Rate limiter: 10 generation requests per minute per IP
const generateRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Maximum 10 generation requests per minute allowed.',
      retryAfterSeconds: 60,
    });
  },
});

// Rate limiter: 15 AI status probe requests per minute per IP (Section 1)
const aiStatusRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      connected: false,
      error: 'Rate limit exceeded for AI status probes. Maximum 15 requests per minute allowed.',
      retryAfterSeconds: 60,
    });
  },
});

// Cache for AI status probe results (60 seconds TTL) (Section 1)
interface CachedAiStatus {
  timestamp: number;
  data: {
    connected: boolean;
    message: string;
    model: string;
    testedAt: string;
    latencyMs: number | null;
    responseSample?: string;
  };
}

let cachedAiStatus: CachedAiStatus | null = null;
const PROBE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Helper with timeout to prevent hanging if external connection experiences latency
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs)),
  ]);
}

// Validation interface
interface ValidationErrorDetail {
  field: string;
  message: string;
}

/**
 * Strict Request Body Validation Middleware for /api/generate (Section 4)
 *
 * Rules:
 * - Reject missing or null body.
 * - Reject null for any supplied field (topic, audience, brandName, customInstructions, platform, language, objective, brandVoice).
 * - Reject non-string in string fields, oversized strings, and non-plain-object in object fields.
 * - Strictly validate arrays and reject null items.
 * - Halts request with HTTP 400 and structured validation errors; never triggers fallback generator for invalid input.
 */
function validateGenerateRequest(req: Request, res: Response, next: NextFunction) {
  const errors: ValidationErrorDetail[] = [];
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: 'Invalid request payload: expected non-null JSON object.',
      validationErrors: [{ field: 'body', message: 'Request body must be a non-null JSON object' }],
    });
  }

  // 1. Topic validation (required, non-null string, 1-300 chars)
  if (!('topic' in body) || body.topic === undefined) {
    errors.push({ field: 'topic', message: 'Topic is required' });
  } else if (body.topic === null) {
    errors.push({ field: 'topic', message: 'Topic cannot be null' });
  } else if (typeof body.topic !== 'string') {
    errors.push({ field: 'topic', message: 'Topic must be a string' });
  } else {
    const trimmed = body.topic.trim();
    if (trimmed.length === 0) {
      errors.push({ field: 'topic', message: 'Topic cannot be empty or whitespace' });
    } else if (trimmed.length > 300) {
      errors.push({ field: 'topic', message: 'Topic cannot exceed 300 characters' });
    }
  }

  // 2. Audience validation (optional string, if present cannot be null, max 300 chars)
  if ('audience' in body && body.audience !== undefined) {
    if (body.audience === null) {
      errors.push({ field: 'audience', message: 'Audience cannot be null' });
    } else if (typeof body.audience !== 'string') {
      errors.push({ field: 'audience', message: 'Audience must be a string' });
    } else if (body.audience.length > 300) {
      errors.push({ field: 'audience', message: 'Audience cannot exceed 300 characters' });
    }
  }

  // 3. Brand name validation (optional string, if present cannot be null, max 100 chars)
  if ('brandName' in body && body.brandName !== undefined) {
    if (body.brandName === null) {
      errors.push({ field: 'brandName', message: 'Brand name cannot be null' });
    } else if (typeof body.brandName !== 'string') {
      errors.push({ field: 'brandName', message: 'Brand name must be a string' });
    } else if (body.brandName.length > 100) {
      errors.push({ field: 'brandName', message: 'Brand name cannot exceed 100 characters' });
    }
  }

  // 4. Custom instructions validation (optional string, if present cannot be null, max 1000 chars)
  if ('customInstructions' in body && body.customInstructions !== undefined) {
    if (body.customInstructions === null) {
      errors.push({ field: 'customInstructions', message: 'Custom instructions cannot be null' });
    } else if (typeof body.customInstructions !== 'string') {
      errors.push({ field: 'customInstructions', message: 'Custom instructions must be a string' });
    } else if (body.customInstructions.length > 1000) {
      errors.push({ field: 'customInstructions', message: 'Custom instructions cannot exceed 1000 characters' });
    }
  }

  // 5. Platform validation (optional, if present cannot be null, must be in SUPPORTED_PLATFORMS)
  if ('platform' in body && body.platform !== undefined) {
    if (body.platform === null) {
      errors.push({ field: 'platform', message: 'Platform cannot be null' });
    } else if (typeof body.platform !== 'string' || !SUPPORTED_PLATFORMS.includes(body.platform as any)) {
      errors.push({
        field: 'platform',
        message: `Platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`,
      });
    }
  }

  // 6. Language validation (optional, if present cannot be null, must be in SUPPORTED_LANGUAGES)
  if ('language' in body && body.language !== undefined) {
    if (body.language === null) {
      errors.push({ field: 'language', message: 'Language cannot be null' });
    } else if (typeof body.language !== 'string' || !SUPPORTED_LANGUAGES.includes(body.language as any)) {
      errors.push({
        field: 'language',
        message: `Language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`,
      });
    }
  }

  // 7. Objective validation (optional, if present cannot be null, must be in SUPPORTED_OBJECTIVES)
  if ('objective' in body && body.objective !== undefined) {
    if (body.objective === null) {
      errors.push({ field: 'objective', message: 'Marketing objective cannot be null' });
    } else if (typeof body.objective !== 'string' || !SUPPORTED_OBJECTIVES.includes(body.objective as any)) {
      errors.push({
        field: 'objective',
        message: `Marketing objective must be one of: ${SUPPORTED_OBJECTIVES.join(', ')}`,
      });
    }
  }

  // 8. Brand voice validation (optional, if present cannot be null, must be a non-null plain object)
  if ('brandVoice' in body && body.brandVoice !== undefined) {
    if (body.brandVoice === null) {
      errors.push({ field: 'brandVoice', message: 'Brand voice cannot be null' });
    } else if (typeof body.brandVoice !== 'object' || Array.isArray(body.brandVoice)) {
      errors.push({ field: 'brandVoice', message: 'Brand voice must be a non-null plain object' });
    } else {
      if ('tone' in body.brandVoice && body.brandVoice.tone !== undefined) {
        if (body.brandVoice.tone === null) {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone cannot be null' });
        } else if (typeof body.brandVoice.tone !== 'string') {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone must be a string' });
        } else if (body.brandVoice.tone.length > 300) {
          errors.push({ field: 'brandVoice.tone', message: 'Brand voice tone cannot exceed 300 characters' });
        }
      }

      if ('styleGuidelines' in body.brandVoice && body.brandVoice.styleGuidelines !== undefined) {
        if (body.brandVoice.styleGuidelines === null) {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines cannot be null' });
        } else if (typeof body.brandVoice.styleGuidelines !== 'string') {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines must be a string' });
        } else if (body.brandVoice.styleGuidelines.length > 500) {
          errors.push({ field: 'brandVoice.styleGuidelines', message: 'Style guidelines cannot exceed 500 characters' });
        }
      }

      if ('bannedWords' in body.brandVoice && body.brandVoice.bannedWords !== undefined) {
        if (body.brandVoice.bannedWords === null) {
          errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words cannot be null' });
        } else if (!Array.isArray(body.brandVoice.bannedWords)) {
          errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words must be an array' });
        } else {
          if (body.brandVoice.bannedWords.length > 50) {
            errors.push({ field: 'brandVoice.bannedWords', message: 'Banned words array cannot exceed 50 items' });
          }
          for (let i = 0; i < body.brandVoice.bannedWords.length; i++) {
            const word = body.brandVoice.bannedWords[i];
            if (word === null || word === undefined || typeof word !== 'string') {
              errors.push({ field: `brandVoice.bannedWords[${i}]`, message: 'Every banned word must be a non-null string' });
              break;
            } else if (word.length > 50) {
              errors.push({ field: `brandVoice.bannedWords[${i}]`, message: 'Banned word entry cannot exceed 50 characters' });
              break;
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed for content generation request.',
      validationErrors: errors,
    });
  }

  next();
}

// API: Health check
app.get('/api/health', (req: Request, res: Response) => {
  const supabaseMode = getStorageMode() === 'supabase' && isSupabaseConfigured();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    aiConfigured: isKeyConfigured,
    model: configuredModel,
    version: '2.0-phase2-db',
    storageMode: getStorageModeLabel(),
    supabaseReady: supabaseMode,
    trustProxyHops: configuredTrustProxyHops,
  });
});

// API: AI Status probe for Settings view (with 15 req/min rate limit and 60-second caching)
app.get('/api/ai-status', aiStatusRateLimiter, async (req: Request, res: Response) => {
  // Return cached probe result if within 60-second TTL
  const now = Date.now();
  if (cachedAiStatus && (now - cachedAiStatus.timestamp < PROBE_CACHE_TTL_MS)) {
    return res.json(cachedAiStatus.data);
  }

  if (!isKeyConfigured || !ai) {
    const unconfiguredResult = {
      connected: false,
      message: 'GEMINI_API_KEY is not configured or contains placeholder value. Content Studio uses local deterministic fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: null,
    };
    cachedAiStatus = {
      timestamp: now,
      data: unconfiguredResult,
    };
    return res.json(unconfiguredResult);
  }

  const start = Date.now();
  try {
    const testRes = await withTimeout(
      ai.models.generateContent({
        model: configuredModel,
        contents: 'Respond with exactly: OMNI_CHANNEL_PLUS_OK',
      }),
      8000,
      'Gemini probe timed out after 8000ms'
    );
    const latency = Date.now() - start;

    const freshResult = {
      connected: true,
      message: `${configuredModel} operational and ready.`,
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: latency,
      responseSample: testRes.text?.trim(),
    };

    // Cache successful probe result
    cachedAiStatus = {
      timestamp: Date.now(),
      data: freshResult,
    };

    return res.json(freshResult);
  } catch (error: any) {
    const sanitizedError = error instanceof Error ? error.message : 'Unknown provider error';
    console.error('[AI Status Probe] Failed to probe Gemini API:', sanitizedError);

    const failResult = {
      connected: false,
      message: 'Upstream AI model probe failed or timed out. Studio will use safe local fallback.',
      model: configuredModel,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };

    // Cache probe result for 60-second TTL to prevent repeated quota consumption
    cachedAiStatus = {
      timestamp: Date.now(),
      data: failResult,
    };

    return res.json(failResult);
  }
});

// API: Hardened Content Generation Endpoint
// Auth-gated per design doc §9: in supabase mode a valid Supabase JWT is
// required; in local mode the gate is a no-op (legacy behaviour, keeps the
// integration test harness green).
app.post(
  '/api/generate',
  generateRateLimiter,
  requireSupabaseAuthWhenConfigured,
  validateGenerateRequest,
  async (req: Request, res: Response) => {
    const {
      topic,
      platform = 'linkedin',
      audience = '',
      objective = 'Awareness',
      language = 'English',
      brandName = 'OmniBrand',
      brandVoice = {},
      customInstructions = '',
    } = req.body;

    const platformMeta = PLATFORM_LIMITS[platform] || { maxChars: 2500, defaultHashtags: 3 };

    // If Gemini API key is configured, invoke Gemini with timeout and error handling
    if (isKeyConfigured && ai) {
      try {
        const prompt = `
You are the Content Studio Engine of OMNI CHANNEL PLUS v2.0.
Generate high-converting, platform-native content according to the master spec.

BRAND CONTEXT:
- Brand Name: ${brandName}
- Target Audience: ${audience || 'General Tech / Business Professionals'}
- Brand Tone: ${brandVoice.tone || 'Authoritative, direct, concise'}
- Preferred Language: ${language}
- Banned Brand Words: ${brandVoice.bannedWords ? brandVoice.bannedWords.join(', ') : 'None'}

CAMPAIGN PARAMETERS:
- Topic / Seed Keyword: "${topic}"
- Target Platform: ${platform}
- Marketing Objective: ${objective}
- Platform Character Limit: ${platformMeta.maxChars}
- Custom Instructions: ${customInstructions || 'Follow platform best practices'}

CRITICAL COMPLIANCE RULES:
- STRICTLY DO NOT use any of these banned AI fluff phrases:
  "In today's fast-paced world", "It's important to note", "Delve into", "Tapestry", "Game-changer",
  "Revolutionary", "Cutting-edge", "At the forefront", "I'm excited to share", "Thrilled to announce",
  "In the realm of", "Navigating the complexities of", "A testament to", "In conclusion", "When it comes to", "Leverage".
- Produce 3 distinct hook variations:
  1. Pattern Interrupt (challenges status quo or stops the scroll)
  2. Curiosity Gap (provocative question or unseen dilemma)
  3. Direct Benefit (actionable promise or tangible outcome)
- Output must be in ${language}. If Roman Urdu is selected, write natural conversational Roman Urdu suitable for Pakistani/South Asian digital audiences without robotic phrasing.

Respond with strict JSON matching this schema.
`;

        const response = await withTimeout(
          ai.models.generateContent({
            model: configuredModel,
            contents: prompt,
            config: {
              systemInstruction: `You are the Omni Channel Plus AI Content Studio Engine. You craft human-sounding, punchy, platform-optimized marketing assets. Never use AI fluff phrases. Output strict valid JSON only.`,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: 'Short descriptive title for this project' },
                  hooks: {
                    type: Type.OBJECT,
                    properties: {
                      patternInterrupt: { type: Type.STRING, description: 'Pattern Interrupt hook variation' },
                      curiosityGap: { type: Type.STRING, description: 'Curiosity Gap hook variation' },
                      directBenefit: { type: Type.STRING, description: 'Direct Benefit hook variation' },
                    },
                    required: ['patternInterrupt', 'curiosityGap', 'directBenefit'],
                  },
                  primaryCaption: { type: Type.STRING, description: 'Complete body caption using the best hook' },
                  callToAction: { type: Type.STRING, description: 'High-converting platform CTA' },
                  hashtags: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Relevant non-spammy hashtags without #'
                  },
                  keyTakeaways: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '3 core insights from the content'
                  },
                  targetAudienceNote: { type: Type.STRING, description: 'Why this resonates with the chosen audience' },
                  visualDirection: { type: Type.STRING, description: 'Visual or B-roll recommendation' },
                },
                required: ['title', 'hooks', 'primaryCaption', 'callToAction', 'hashtags', 'keyTakeaways'],
              },
            },
          }),
          14000,
          'Gemini generation timed out'
        );

        const parsed = JSON.parse(response.text || '{}');
        const detectedFluff = detectBannedPhrases(parsed.primaryCaption || '');

        return res.json({
          success: true,
          source: configuredModel,
          isFallback: false,
          data: {
            ...parsed,
            detectedFluff,
            platformLimit: platformMeta.maxChars,
            charCount: (parsed.primaryCaption || '').length,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (err: any) {
        // Sanitize error logging: never log API keys or raw tokens
        const sanitizedMsg = err instanceof Error ? err.message : 'Unknown generation error';
        console.error('[Gemini Generation] Upstream error, engaging local deterministic fallback:', sanitizedMsg);

        // Safe client message without leaking internal URLs or credentials
        const fallbackReason = sanitizedMsg.toLowerCase().includes('timed out')
          ? 'upstream_timeout'
          : sanitizedMsg.toLowerCase().includes('quota') || sanitizedMsg.toLowerCase().includes('429')
          ? 'quota_exceeded'
          : 'upstream_unavailable';

        const fallback = generateIntelligentFallback({
          topic,
          platform,
          audience: audience || 'Professional decision makers',
          objective,
          language,
          brandName,
        });

        return res.json({
          success: true,
          source: 'local_deterministic_engine',
          isFallback: true,
          fallbackReason,
          note: 'Content generated using local deterministic engine. Upstream Gemini API call was unavailable or timed out.',
          data: fallback,
        });
      }
    }

    // Deterministic Intelligent Fallback when no API key is configured
    const fallback = generateIntelligentFallback({
      topic,
      platform,
      audience: audience || 'Professional decision makers',
      objective,
      language,
      brandName,
    });

    return res.json({
      success: true,
      source: 'local_deterministic_engine',
      isFallback: true,
      fallbackReason: 'missing_api_key',
      note: 'Content generated using local deterministic engine. Configure GEMINI_API_KEY in the Secrets panel to enable live Gemini AI generation.',
      data: fallback,
    });
  }
);

// Fallback generator matching Omni Channel Plus specification
function generateIntelligentFallback(params: {
  topic: string;
  platform: string;
  audience: string;
  objective: string;
  language: string;
  brandName: string;
}) {
  const { topic, platform, audience, objective, language, brandName } = params;
  const isUrdu = language.toLowerCase().includes('urdu');

  let hookA = `Most teams get ${topic} completely backwards.`;
  let hookB = `There's a subtle bottleneck in ${topic} that cost us weeks to identify.`;
  let hookC = `Here is the step-by-step breakdown to master ${topic} this quarter.`;

  if (isUrdu) {
    hookA = `${topic} ke baray mein 90% log wahi purani ghalti dohra rahe hain.`;
    hookB = `Agar aap ${topic} se results chahte hain, toh yeh ek choti si change zaroori hai.`;
    hookC = `${topic} ko master karne ka seedha aur practical tareeqa — baghair kisi faltu complexity ke.`;
  }

  let body = isUrdu
    ? `${hookA}\n\nJab aap ${topic} par kaam karte hain, toh sab se pehle clear context aur intent zaroori hota hai.\n\n3 Bunyadi baten:\n1. Problem ko root level par identify karein.\n2. Over-automation se bachein aur real value deliver karein.\n3. Har metric ko measurable outcomes ke sath align karein.\n\nAap is par kya approach letay hain?`
    : `${hookA}\n\nWhen optimizing for ${topic}, surface-level tweaks rarely move the needle.\n\nHere are 3 core fundamentals we focus on at ${brandName}:\n\n1. Strip away bloated processes before adding new tooling.\n2. Measure outcomes, not just task completion rates.\n3. Keep the feedback loop under 48 hours for rapid iteration.\n\nWhat is your biggest friction point with ${topic} right now?`;

  const cta = isUrdu
    ? `Comments mein batayein: aap ka current workflow kaisa chal raha hai?`
    : `Drop your thoughts below or bookmark this framework for your next strategy session.`;

  const cleanTopic = topic.replace(/[^a-zA-Z0-9]/g, '');
  const hashtags = [cleanTopic, 'GrowthEngine', 'SaaS', 'Strategy', 'OmniChannel'].slice(0, 4);

  return {
    title: `${topic} - ${objective} Campaign`,
    hooks: {
      patternInterrupt: hookA,
      curiosityGap: hookB,
      directBenefit: hookC,
    },
    primaryCaption: body,
    callToAction: cta,
    hashtags,
    keyTakeaways: [
      `Prioritize foundational clarity before scaling ${topic}`,
      `Eliminate redundant workflow steps to speed up delivery`,
      `Maintain continuous measurement against actual business KPIs`
    ],
    targetAudienceNote: `Tailored for ${audience} focusing on ${objective}.`,
    visualDirection: platform.includes('reels') || platform.includes('tiktok')
      ? 'Vertical 9:16 talking-head with fast-cut b-roll overlays and high-contrast word subtitles.'
      : 'Crisp minimal infographic card or clean branded screenshot with subtle dark gradient border.',
    detectedFluff: [],
    platformLimit: PLATFORM_LIMITS[platform]?.maxChars || 2500,
    charCount: body.length,
    generatedAt: new Date().toISOString(),
  };
}

// Setup Vite middleware in dev or static files in production
async function startServer() {
  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, () => {
    console.log(`OMNI CHANNEL PLUS Server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
