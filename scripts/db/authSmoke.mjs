/**
 * Frontend cutover smoke test — live Supabase end-to-end.
 *
 * Boots the Express server with STORAGE_MODE=supabase, then exercises the
 * NEW auth endpoints (/api/auth/signup, /login, /me, /logout) exactly the way
 * the browser will, plus a workspace export→import→re-export round-trip.
 * Asserts the JWT-gated /api/generate path returns 401 without a token.
 *
 * Strategy:
 * - Validation paths (malformed email, weak password, missing fields) hit the
 *   server's pre-GoTrue validator → 400s. No Supabase rate-limit impact.
 * - The signup-with-existing-email path verifies the GoTrue integration.
 * - The full login → me → workspace → import → re-export flow uses the
 *   pre-confirmed test user (set up in an earlier session), so we don't have
 *   to click a confirmation email link.
 *
 * Env: loads .env (SUPABASE_URL, keys, STORAGE_MODE=supabase).
 *       Optional: AUTH_SMOKE_PORT, AUTH_SMOKE_EMAIL, AUTH_SMOKE_PASSWORD.
 */
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const PORT = String(process.env.AUTH_SMOKE_PORT || '3181');
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = process.env.AUTH_SMOKE_EMAIL || 'omni-admin-test@omnichannelplus.dev';
const TEST_PASSWORD = process.env.AUTH_SMOKE_PASSWORD || 'OmniTest#2026x';

let serverProc = null;
let serverProcExitCode = null;
const assertions = [];
const createdTestUserIds = [];

function assert(name, cond, actual) {
  assertions.push({ name, passed: !!cond, actual: String(actual) });
  if (!cond) console.error(`  ✗ FAIL: ${name}  →  ${actual}`);
  else console.log(`  ✓ PASS: ${name}`);
}

async function startServer() {
  console.log(`\n[boot] spawning server on port ${PORT} (STORAGE_MODE=${process.env.STORAGE_MODE || '(unset)'})`);
  serverProc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write(`  [server] ${d}`.replace(/\n$/, '\n')));
  serverProc.stderr.on('data', d => process.stderr.write(`  [server:err] ${d}`.replace(/\n$/, '\n')));
  serverProc.on('exit', code => { serverProcExitCode = code; });

  // Wait for health to report supabase-ready
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.storageMode === 'supabase' && j.supabaseReady === true) return;
      }
    } catch { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Server did not become supabase-ready within 30s');
}

async function stopServer() {
  if (serverProc && serverProcExitCode === null) {
    serverProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 800));
    if (serverProcExitCode === null) serverProc.kill('SIGKILL');
  }
}

async function cleanup() {
  // Delete any test users created during the run (cascades to their org + rows
  // via FK ON DELETE CASCADE). The pre-confirmed test user is preserved.
  if (createdTestUserIds.length > 0) {
    try {
      const admin = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      for (const id of createdTestUserIds) {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) console.warn(`  [cleanup] admin.deleteUser(${id}) failed: ${error.message}`);
        else console.log(`  [cleanup] deleted test user ${id}`);
      }
    } catch (e) {
      console.warn(`  [cleanup] error: ${e.message}`);
    }
  }
  await stopServer();
}

async function jsonSafe(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return body;
}

async function main() {
  await startServer();

  console.log('\n─── Test 1: validation rejects malformed email with 400 (pre-GoTrue) ───');
  {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('error INVALID_EMAIL', body.error === 'INVALID_EMAIL', `error=${body.error}`);
  }

  console.log('\n─── Test 2: validation rejects short password with 400 (pre-GoTrue) ───');
  {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valid@example.com', password: 'short' }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('error WEAK_PASSWORD', body.error === 'WEAK_PASSWORD', `error=${body.error}`);
  }

  console.log('\n─── Test 3: validation rejects missing fields with 400 (pre-GoTrue) ───');
  {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valid@example.com' }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('error INVALID_CREDENTIALS', body.error === 'INVALID_CREDENTIALS', `error=${body.error}`);
  }

  console.log('\n─── Test 4: signup with EXISTING email returns 200 (no session, requires confirmation) ───');
  // With email confirmation ON, GoTrue intentionally does NOT leak which
  // emails are already registered. It returns the same shape as a fresh
  // signup-without-confirmation: 200 + requiresEmailConfirmation=true, no
  // session. Our server surfaces that shape verbatim.
  {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    const body = await jsonSafe(res);
    assert('status 200 (GoTrue anti-enumeration)', res.status === 200, `status=${res.status}`);
    assert('requiresEmailConfirmation is true', body.requiresEmailConfirmation === true, `requiresEmailConfirmation=${body.requiresEmailConfirmation}`);
    assert('session is null (no JWT leaked for unconfirmed signup)', body.session === null, `session=${body.session}`);
    assert('user.email matches input', body.user?.email === TEST_EMAIL, `email=${body.user?.email}`);
  }

  console.log('\n─── Test 5: login with confirmed user returns 200 + session ───');
  let jwt = null;
  let userId = null;
  let rt = null; // current (latest rotated) refresh token — tracked Phase 3
  {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('user.id is a uuid', body.user?.id && body.user.id.length === 36, `id=${body.user?.id}`);
    assert('user.email matches input', body.user?.email === TEST_EMAIL, `email=${body.user?.email}`);
    assert('session.accessToken is a string', typeof body.session?.accessToken === 'string' && body.session.accessToken.length > 50, `len=${body.session?.accessToken?.length}`);
    assert('session.refreshToken is present (Phase 3)', typeof body.session?.refreshToken === 'string' && body.session.refreshToken.length > 10, `len=${body.session?.refreshToken?.length ?? 0}`);
    jwt = body.session?.accessToken;
    rt = body.session?.refreshToken ?? null;
    userId = body.user?.id;
  }

  console.log('\n─── Test 6: login with wrong password returns 401 INVALID_CREDENTIALS ───');
  {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'wrong-password-xyz' }),
    });
    const body = await jsonSafe(res);
    assert('status 401', res.status === 401, `status=${res.status}`);
    assert('error INVALID_CREDENTIALS', body.error === 'INVALID_CREDENTIALS', `error=${body.error}`);
  }

  console.log('\n─── Test 7: GET /api/auth/me with JWT returns user ───');
  {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('user.id matches login', body.user?.id === userId, `id=${body.user?.id}`);
    assert('user.email matches login', body.user?.email === TEST_EMAIL, `email=${body.user?.email}`);
  }

  console.log('\n─── Test 8: GET /api/auth/me without JWT returns 401 ───');
  {
    const res = await fetch(`${BASE}/api/auth/me`);
    const body = await jsonSafe(res);
    assert('status 401', res.status === 401, `status=${res.status}`);
    assert('error UNAUTHORIZED', body.error === 'UNAUTHORIZED', `error=${body.error}`);
  }

  console.log('\n─── Test 9: GET /api/auth/me with garbage JWT returns 401 ───');
  {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    assert('status 401', res.status === 401, `status=${res.status}`);
  }

  console.log('\n─── Test 9b: POST /api/auth/refresh rotates BOTH tokens (Phase 3) ───');
  {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('new accessToken is a string', typeof body.session?.accessToken === 'string' && body.session.accessToken.length > 50, `len=${body.session?.accessToken?.length}`);
    assert('new accessToken differs from login token', body.session?.accessToken && body.session.accessToken !== jwt, 'same token reused?');
    assert('refresh token ROTATED (differs from login one)', typeof body.session?.refreshToken === 'string' && body.session.refreshToken !== rt, `rotated=${body.session?.refreshToken !== rt}`);
    assert('expiresAt is a number', typeof body.session?.expiresAt === 'number', `expiresAt=${body.session?.expiresAt}`);
    assert('user.email matches', body.user?.email === TEST_EMAIL, `email=${body.user?.email}`);
    // Adopt the rotated tokens — everything downstream uses these.
    jwt = body.session.accessToken;
    rt = body.session.refreshToken;
    const meRes = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const meBody = await jsonSafe(meRes);
    assert('renewed token works on /api/auth/me', meRes.status === 200 && meBody.user?.email === TEST_EMAIL, `status=${meRes.status}`);
  }

  console.log('\n─── Test 9c: refresh with garbage token returns 401 ───');
  {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'not-a-real-refresh-token-xyz' }),
    });
    const body = await jsonSafe(res);
    assert('status 401', res.status === 401, `status=${res.status}`);
    assert('error INVALID_REFRESH_TOKEN', body.error === 'INVALID_REFRESH_TOKEN', `error=${body.error}`);
  }

  console.log('\n─── Test 9d: refresh with missing refreshToken returns 400 (validation-first) ───');
  {
    const res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await jsonSafe(res);
    assert('status 400 (not a confusing 501)', res.status === 400, `status=${res.status}`);
    assert('error AUTH_VALIDATION', body.error === 'AUTH_VALIDATION', `error=${body.error}`);
  }

  console.log('\n─── Test 10: /api/generate returns 401 without JWT (auth-gated) ───');
  {
    const res = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'test' }),
    });
    const body = await jsonSafe(res);
    assert('status 401', res.status === 401, `status=${res.status}`);
    assert('error UNAUTHORIZED', body.error === 'UNAUTHORIZED', `error=${body.error}`);
  }

  console.log('\n─── Test 11: /api/workspace/export with JWT returns 200 ───');
  let preImportBrandCount = 0;
  {
    const res = await fetch(`${BASE}/api/workspace/export`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('source is database', body.source === 'database', `source=${body.source}`);
    assert('workspaces is an array', Array.isArray(body.workspaces), `type=${typeof body.workspaces}`);
    preImportBrandCount = body.workspaces?.[0]?.brands?.length ?? 0;
    console.log(`    (pre-import brand count for ${TEST_EMAIL}: ${preImportBrandCount})`);
  }

  console.log('\n─── Test 12: /api/workspace/import with JWT creates a brand ───');
  {
    const exportFile = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      source: 'localStorage',
      data: {
        brands: [{
          id: `smoke-brand-${Date.now()}`,
          name: `Smoke Brand ${Date.now()}`,
          tagline: 'tagline',
          industry: 'Tech',
          targetAudience: 'Engineers',
          brandVoice: { tone: 'Direct', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
          preferredLanguage: 'English',
          productsAndServices: [{ id: 'p1', name: 'Widget', description: '' }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        drafts: [],
        calendarEvents: [],
        settings: {
          workspaceName: 'Smoke Test',
          defaultBrandId: 'smoke-brand-1',
          defaultLanguage: 'English',
          timezone: 'Asia/Karachi (PKT, UTC+5)',
          enableFluffHighlighting: true,
          autoSaveDrafts: true,
        },
        activeBrandId: `smoke-brand-${Date.now()}`,
      },
    };
    const res = await fetch(`${BASE}/api/workspace/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(exportFile),
    });
    const body = await jsonSafe(res);
    assert('status 201 (or 207 partial)', res.status === 201 || res.status === 207, `status=${res.status}`);
    assert('created 1 brand', body.created?.brands === 1, `created.brands=${body.created?.brands}`);
    assert('no errors', Array.isArray(body.errors) && body.errors.length === 0, `errors=${JSON.stringify(body.errors).slice(0, 100)}`);
  }

  console.log('\n─── Test 13: re-export shows +1 brand ───');
  {
    const res = await fetch(`${BASE}/api/workspace/export`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    const newCount = body.workspaces?.[0]?.brands?.length ?? 0;
    assert('brand count increased by 1', newCount === preImportBrandCount + 1, `before=${preImportBrandCount}, after=${newCount}`);
  }

  console.log('\n─── Test 14: idempotent re-import (same exportedAt) creates 0 new rows ───');
  {
    const fixedTimestamp = '2026-11-09T00:00:00.000Z';
    const exportFile = {
      formatVersion: 1,
      exportedAt: fixedTimestamp,
      source: 'localStorage',
      data: {
        brands: [{
          id: 'idem-brand-1',
          name: `Idempotent Brand ${Date.now()}`,
          tagline: '', industry: 'Tech', targetAudience: '',
          brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
          preferredLanguage: 'English',
          productsAndServices: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        drafts: [], calendarEvents: [],
        settings: { workspaceName: 'Idem', defaultBrandId: 'idem-brand-1', defaultLanguage: 'English', timezone: 'Asia/Karachi (PKT, UTC+5)', enableFluffHighlighting: true, autoSaveDrafts: true },
        activeBrandId: 'idem-brand-1',
      },
    };
    // First import: creates 1 brand.
    const r1 = await fetch(`${BASE}/api/workspace/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(exportFile),
    });
    const b1 = await jsonSafe(r1);
    assert('first import creates 1 brand', b1.created?.brands === 1, `created.brands=${b1.created?.brands}`);
    // Second import (same exportedAt): creates 0.
    const r2 = await fetch(`${BASE}/api/workspace/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(exportFile),
    });
    const b2 = await jsonSafe(r2);
    assert('second import creates 0 brands (idempotent)', b2.created?.brands === 0, `created.brands=${b2.created?.brands}`);
    assert('second import reports "already imported" note', Array.isArray(b2.notes) && b2.notes.some(n => /already imported/i.test(n)), `notes=${JSON.stringify(b2.notes).slice(0, 150)}`);
  }

  // ── Phase 3 multi-org (P3.2): workspace list + org-scoped CRUD ────────────
  // The smoke user survives across runs, so every org count here is RELATIVE
  // (before/after), never absolute. Org B is explicitly deleted at the end of
  // this section (org delete cascades members/brands/drafts/events/settings).
  console.log('\n─── Test 14b: multi-org — /api/orgs, x-org-id scoping, targeted import ───');
  let orgBId = null;
  {
    // (a) without JWT → 401
    const noAuth = await fetch(`${BASE}/api/orgs`);
    const noAuthBody = await jsonSafe(noAuth);
    assert('orgs without JWT → 401', noAuth.status === 401, `status=${noAuth.status}`);
    assert('orgs 401 error UNAUTHORIZED', noAuthBody.error === 'UNAUTHORIZED', `error=${noAuthBody.error}`);

    // (b) with JWT → 200 + memberships with owner role
    const r1 = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${jwt}` } });
    const b1 = await jsonSafe(r1);
    const countBefore = Array.isArray(b1.orgs) ? b1.orgs.length : -1;
    assert('orgs with JWT → 200', r1.status === 200, `status=${r1.status}`);
    assert('orgs array present', Array.isArray(b1.orgs), `type=${typeof b1.orgs}`);
    assert('at least one membership (workspace from Test 12)', countBefore >= 1, `count=${countBefore}`);
    assert('membership role is owner', b1.orgs?.[0]?.role === 'owner', `role=${b1.orgs?.[0]?.role}`);
    assert('org carries name + timezone', typeof b1.orgs?.[0]?.name === 'string' && typeof b1.orgs?.[0]?.defaultTimezone === 'string', `org=${JSON.stringify(b1.orgs?.[0] ?? {}).slice(0, 120)}`);

    // (c) create a SECOND org through create_organization RPC as the user
    const userScoped = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: newOrgId, error: orgErr } = await userScoped.rpc('create_organization', {
      p_name: `Smoke Org B ${Date.now()}`,
      p_slug: `smoke-org-b-${Date.now()}`,
      p_timezone: 'Asia/Karachi',
    });
    assert('create_organization RPC succeeded', !orgErr && typeof newOrgId === 'string', `error=${orgErr?.message ?? ''}`);
    orgBId = typeof newOrgId === 'string' ? newOrgId : null;

    if (orgBId) {
      // (d) the list now shows BOTH workspaces
      const r2 = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${jwt}` } });
      const b2 = await jsonSafe(r2);
      assert('orgs count increased by 1', Array.isArray(b2.orgs) && b2.orgs.length === countBefore + 1, `before=${countBefore}, after=${b2.orgs?.length}`);
      // P3.3: the role data the frontend read-only UI depends on.
      assert('org B listed with role owner (creator = owner)', b2.orgs?.some(o => o.id === orgBId && o.role === 'owner'), `roles=${JSON.stringify(b2.orgs?.map(o => `${o.id.slice(0, 8)}:${o.role}`))}`);
      assert('every membership role is a valid org_role', (b2.orgs ?? []).every(o => ['owner', 'admin', 'editor', 'viewer'].includes(o.role)), `roles=${JSON.stringify(b2.orgs?.map(o => o.role))}`);

      // (e) CRUD targeted at org B works and lands in org B
      const brandBody = {
        name: `MultiOrg Brand ${Date.now()}`,
        tagline: 'org b probe',
        industry: 'Tech',
        targetAudience: 'QA',
        brandVoice: { tone: 'Direct', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
        preferredLanguage: 'English',
        productsAndServices: [{ name: 'Widget' }],
      };
      const rc = await fetch(`${BASE}/api/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'x-org-id': orgBId },
        body: JSON.stringify(brandBody),
      });
      const bc = await jsonSafe(rc);
      assert('CRUD with x-org-id=orgB → 201', rc.status === 201, `status=${rc.status}`);
      assert('created brand row carries org B org_id', bc.org_id === orgBId, `org_id=${bc.org_id}`);

      // (f) non-member org → 403 (RLS returns zero rows; existence never leaked)
      const rf = await fetch(`${BASE}/api/brands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'x-org-id': '00000000-0000-4000-8000-000000000000',
        },
        body: JSON.stringify(brandBody),
      });
      const bf = await jsonSafe(rf);
      assert('CRUD with foreign x-org-id → 403', rf.status === 403, `status=${rf.status}`);
      assert('403 error FORBIDDEN_ORG', bf.error === 'FORBIDDEN_ORG', `error=${bf.error}`);

      // (g) malformed header → 400 before any DB work
      const rm = await fetch(`${BASE}/api/brands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'x-org-id': 'not-a-uuid',
        },
        body: JSON.stringify(brandBody),
      });
      const bm = await jsonSafe(rm);
      assert('CRUD with non-UUID x-org-id → 400', rm.status === 400, `status=${rm.status}`);
      assert('400 error INVALID_ORG_ID', bm.error === 'INVALID_ORG_ID', `error=${bm.error}`);

      // (h) import TARGETS the active workspace when the header is present
      const importFile = {
        formatVersion: 1,
        exportedAt: `2026-11-10T00:00:0${Math.floor(Math.random() * 10)}.000Z`,
        source: 'localStorage',
        data: {
          brands: [{
            id: `orgb-brand-${Date.now()}`,
            name: `Org B Import Brand ${Date.now()}`,
            tagline: '', industry: 'Tech', targetAudience: '',
            brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
            preferredLanguage: 'English',
            productsAndServices: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
          drafts: [],
          calendarEvents: [],
          settings: { workspaceName: 'Org B Import', defaultBrandId: 'orgb-brand-1', defaultLanguage: 'English', timezone: 'Asia/Karachi (PKT, UTC+5)', enableFluffHighlighting: true, autoSaveDrafts: true },
          activeBrandId: `orgb-brand-${Date.now()}`,
        },
      };
      const ri = await fetch(`${BASE}/api/workspace/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'x-org-id': orgBId },
        body: JSON.stringify(importFile),
      });
      const bi = await jsonSafe(ri);
      assert('import with x-org-id=orgB → 201/207', ri.status === 201 || ri.status === 207, `status=${ri.status}`);
      assert('import report targets org B', bi.orgId === orgBId, `orgId=${bi.orgId}`);
      assert('import lands in caller workspace (no get-or-create)', Array.isArray(bi.notes) && bi.notes.some(n => /active workspace/i.test(n)), `notes=${JSON.stringify(bi.notes ?? []).slice(0, 150)}`);

      // (i) export still exposes every workspace (frontend switcher data source)
      const re = await fetch(`${BASE}/api/workspace/export`, { headers: { Authorization: `Bearer ${jwt}` } });
      const be = await jsonSafe(re);
      assert('export workspaces count == orgs count', Array.isArray(be.workspaces) && be.workspaces.length === countBefore + 1, `workspaces=${be.workspaces?.length}, expected=${countBefore + 1}`);

      // (j) org B deletion cascades everything created in this section
      const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: delErr } = await admin.from('organizations').delete().eq('id', orgBId);
      assert('org B cleanup delete succeeded', !delErr, `error=${delErr?.message ?? ''}`);
      orgBId = null;
    }
  }

  console.log('\n─── Test 14c: P3.4 members — invite, roster, roles, guards (live) ───');
  {
    // (a) a second REAL auth user via the service-role admin API
    // (email_confirm: true so the app login flow works without email links).
    const memberEmail = `omni-member-${Date.now()}@omnichannelplus.dev`;
    const adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: memberEmail,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    assert('admin.createUser for member B succeeded', !createErr && !!created?.user?.id, `error=${createErr?.message ?? ''}`);
    const memberUserId = created?.user?.id ?? null;
    if (memberUserId) createdTestUserIds.push(memberUserId);

    // (b) login B through the app's own auth flow
    let memberJwt = null;
    {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: memberEmail, password: TEST_PASSWORD }),
      });
      const body = await jsonSafe(res);
      assert('member B app login → 200', res.status === 200, `status=${res.status}`);
      memberJwt = body.session?.accessToken ?? null;
    }

    // (c) fresh org C owned by the primary smoke user (A)
    const scopedA = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: orgCId, error: orgCErr } = await scopedA.rpc('create_organization', {
      p_name: `Smoke Org C ${Date.now()}`,
      p_slug: `smoke-org-c-${Date.now()}`,
      p_timezone: 'Asia/Karachi', // the RPC's validator rejects bare 'UTC'
    });
    assert('create_organization RPC (org C) succeeded', !orgCErr && typeof orgCId === 'string', `error=${orgCErr?.message ?? ''}`);

    if (memberJwt && memberUserId && typeof orgCId === 'string' && orgCId) {
      // (d) B is not a member: roster read → 403, org existence never leaked
      const g1 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, { headers: { Authorization: `Bearer ${memberJwt}` } });
      const gb1 = await jsonSafe(g1);
      assert('non-member roster read → 403', g1.status === 403, `status=${g1.status}`);
      assert('403 error FORBIDDEN_ORG', gb1.error === 'FORBIDDEN_ORG', `error=${gb1.error}`);

      // (e) B (non-member) tries to manage → 403 (same code as non-admin
      // members — no way to probe org existence from these endpoints)
      const p1 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberJwt}` },
        body: JSON.stringify({ email: memberEmail, role: 'viewer' }),
      });
      assert('non-member invite attempt → 403', p1.status === 403, `status=${p1.status}`);

      // (f) owner is not assignable via the dropdown endpoints
      const p2 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ email: memberEmail, role: 'owner' }),
      });
      const gb2 = await jsonSafe(p2);
      assert('assigning owner → 400 INVALID_ROLE', p2.status === 400 && gb2.error === 'INVALID_ROLE', `status=${p2.status}, error=${gb2.error}`);

      // (g) unknown email → 404 USER_NOT_FOUND (honest: ask them to sign up)
      const p3 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ email: `nobody-${Date.now()}@invalid.example`, role: 'viewer' }),
      });
      const gb3 = await jsonSafe(p3);
      assert('unknown email → 404 USER_NOT_FOUND', p3.status === 404 && gb3.error === 'USER_NOT_FOUND', `status=${p3.status}, error=${gb3.error}`);

      // (h) A invites B as viewer → 201
      const p4 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ email: memberEmail, role: 'viewer' }),
      });
      const gb4 = await jsonSafe(p4);
      assert('invite B as viewer → 201', p4.status === 201, `status=${p4.status}`);
      assert('invite response carries userId + role', gb4.member?.userId === memberUserId && gb4.member?.role === 'viewer', `member=${JSON.stringify(gb4.member ?? {})}`);

      // (i) duplicate invite → 409
      const p5 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ email: memberEmail, role: 'viewer' }),
      });
      const gb5 = await jsonSafe(p5);
      assert('duplicate invite → 409 ALREADY_MEMBER', p5.status === 409 && gb5.error === 'ALREADY_MEMBER', `status=${p5.status}, error=${gb5.error}`);

      // (j) END-TO-END: B now sees org C in /api/orgs with role viewer
      const o1 = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${memberJwt}` } });
      const ob1 = await jsonSafe(o1);
      assert('member B sees org C with role viewer', ob1.orgs?.some(o => o.id === orgCId && o.role === 'viewer'), `orgs=${JSON.stringify(ob1.orgs?.map(o => o.role))}`);

      // (k) roster as B (viewer): 200, 2 rows, NO email enrichment (PII gate)
      const g2 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, { headers: { Authorization: `Bearer ${memberJwt}` } });
      const gb6 = await jsonSafe(g2);
      assert('viewer member roster read → 200', g2.status === 200, `status=${g2.status}`);
      assert('roster has 2 members', Array.isArray(gb6.members) && gb6.members.length === 2, `count=${gb6.members?.length}`);
      assert('viewer sees NO email addresses (PII gate)', Array.isArray(gb6.members) && gb6.members.every(m => m.email === null), `emails=${JSON.stringify(gb6.members?.map(m => m.email))}`);

      // (k2) roster as A (owner): emails enriched
      const g3 = await fetch(`${BASE}/api/orgs/${orgCId}/members`, { headers: { Authorization: `Bearer ${jwt}` } });
      const gb7 = await jsonSafe(g3);
      assert('owner roster shows member email', gb7.members?.some(m => m.email === memberEmail), `emails=${JSON.stringify(gb7.members?.map(m => m.email))}`);

      // (l) viewer CANNOT write in org C (can_write RLS — the P3.3 UI
      // gate's server mirror; the CRUD route maps the refusal to 422)
      const brandBody = {
        name: `Viewer Write Probe ${Date.now()}`,
        tagline: 'x', industry: 'Tech', targetAudience: 'QA',
        brandVoice: { tone: 'Direct', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
        preferredLanguage: 'English',
        productsAndServices: [{ name: 'Widget' }],
      };
      const w1 = await fetch(`${BASE}/api/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberJwt}`, 'x-org-id': orgCId },
        body: JSON.stringify(brandBody),
      });
      assert('viewer brand create in org C → 422 (can_write RLS refusal)', w1.status === 422, `status=${w1.status}`);

      // (m) A promotes B to editor → 200; editor CAN write (role change is
      // immediately effective — RLS re-evaluates on every query)
      const p6 = await fetch(`${BASE}/api/orgs/${orgCId}/members/${memberUserId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ role: 'editor' }),
      });
      assert('PATCH member role viewer→editor → 200', p6.status === 200, `status=${p6.status}`);
      const w2 = await fetch(`${BASE}/api/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberJwt}`, 'x-org-id': orgCId },
        body: JSON.stringify(brandBody),
      });
      assert('editor brand create in org C → 201', w2.status === 201, `status=${w2.status}`);

      // (n) LAST_OWNER guard: A cannot remove themselves as the only owner
      const d1 = await fetch(`${BASE}/api/orgs/${orgCId}/members/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const db1 = await jsonSafe(d1);
      assert('removing the last owner → 409 LAST_OWNER', d1.status === 409 && db1.error === 'LAST_OWNER', `status=${d1.status}, error=${db1.error}`);

      // (o) A removes B → 200; org C disappears from B's list
      const d2 = await fetch(`${BASE}/api/orgs/${orgCId}/members/${memberUserId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert('remove member B → 200', d2.status === 200, `status=${d2.status}`);
      const o2 = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${memberJwt}` } });
      const ob2 = await jsonSafe(o2);
      assert("org C gone from B's list after removal", !(ob2.orgs ?? []).some(o => o.id === orgCId), `orgs=${JSON.stringify(ob2.orgs?.length)}`);

      // (p) cleanup org C (service-role delete cascades members + brand)
      const { error: delCErr } = await adminClient.from('organizations').delete().eq('id', orgCId);
      assert('org C cleanup delete succeeded', !delCErr, `error=${delCErr?.message ?? ''}`);
    }
  }

  console.log('\n─── Test 14d: P3.5/P3.6 lifecycle — rename, ownership transfer, delete guards (live) ───');
  {
    // (a) a fresh second REAL auth user (B2) via the service-role admin API
    const b2Email = `omni-owner-${Date.now()}@omnichannelplus.dev`;
    const adminClientD = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: createdD, error: createDErr } = await adminClientD.auth.admin.createUser({
      email: b2Email,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    assert('admin.createUser for B2 succeeded', !createDErr && !!createdD?.user?.id, `error=${createDErr?.message ?? ''}`);
    const b2UserId = createdD?.user?.id ?? null;
    if (b2UserId) createdTestUserIds.push(b2UserId);

    // (b) B2 logs in through the app
    let b2Jwt = null;
    {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: b2Email, password: TEST_PASSWORD }),
      });
      const body = await jsonSafe(res);
      assert('B2 app login → 200', res.status === 200, `status=${res.status}`);
      b2Jwt = body.session?.accessToken ?? null;
    }

    // (c) fresh org D owned by A (the primary smoke user)
    const scopedD = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: orgDId, error: orgDErr } = await scopedD.rpc('create_organization', {
      p_name: `Smoke Org D ${Date.now()}`,
      p_slug: `smoke-org-d-${Date.now()}`,
      p_timezone: 'Asia/Karachi',
    });
    assert('create_organization RPC (org D) succeeded', !orgDErr && typeof orgDId === 'string', `error=${orgDErr?.message ?? ''}`);

    if (b2Jwt && b2UserId && typeof orgDId === 'string' && orgDId) {
      const orgH = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
      const b2H = { 'Content-Type': 'application/json', Authorization: `Bearer ${b2Jwt}` };
      const dumpD = async label => {
        const { data } = await adminClientD.from('organization_members').select('user_id, role').eq('org_id', orgDId).order('invited_at');
        console.log(`  [dump] ${label}:`, JSON.stringify(data?.map(r => ({ id: r.user_id.slice(0, 8), role: r.role }))), `A=${userId.slice(0, 8)} B2=${b2UserId.slice(0, 8)}`);
      };

      // (d) A invites B2 as ADMIN (transfer targets must be admins)
      const inv = await fetch(`${BASE}/api/orgs/${orgDId}/members`, {
        method: 'POST', headers: orgH,
        body: JSON.stringify({ email: b2Email, role: 'admin' }),
      });
      const invBody = await jsonSafe(inv);
      assert('invite B2 as admin → 201', inv.status === 201, `status=${inv.status}`);
      assert('invite resolved B2 as the member', invBody.member?.userId === b2UserId, `resolved=${invBody.member?.userId}, expected=${b2UserId}`);
      await dumpD('after invite');

      // (e) admin CANNOT rename (server owner-only gate, before any RLS)
      const ren1 = await fetch(`${BASE}/api/orgs/${orgDId}`, {
        method: 'PATCH', headers: b2H, body: JSON.stringify({ name: 'B2 Renamed' }),
      });
      const rb1 = await jsonSafe(ren1);
      assert('admin rename attempt → 403 ORG_MANAGEMENT_FORBIDDEN', ren1.status === 403 && rb1.error === 'ORG_MANAGEMENT_FORBIDDEN', `status=${ren1.status}, error=${rb1.error}`);

      // (f) rename validation: empty name → 400 INVALID_NAME
      const ren2 = await fetch(`${BASE}/api/orgs/${orgDId}`, {
        method: 'PATCH', headers: orgH, body: JSON.stringify({ name: '   ' }),
      });
      const rb2 = await jsonSafe(ren2);
      assert('empty rename → 400 INVALID_NAME', ren2.status === 400 && rb2.error === 'INVALID_NAME', `status=${ren2.status}, error=${rb2.error}`);

      // (g) owner renames → 200, row echoes back
      const ren3 = await fetch(`${BASE}/api/orgs/${orgDId}`, {
        method: 'PATCH', headers: orgH, body: JSON.stringify({ name: `Smoke Org D Renamed ${Date.now()}` }),
      });
      const rb3 = await jsonSafe(ren3);
      assert('owner rename → 200 with org row', ren3.status === 200 && typeof rb3.org?.name === 'string' && rb3.org.name.startsWith('Smoke Org D Renamed'), `status=${ren3.status}, name=${rb3.org?.name}`);
      assert('rename response carries slug (immutable)', typeof rb3.org?.slug === 'string' && rb3.org.slug.startsWith('smoke-org-d-'), `slug=${rb3.org?.slug}`);

      // (h) list reflects the rename
      const lst = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${jwt}` } });
      const lb = await jsonSafe(lst);
      assert('renamed name visible in /api/orgs', (lb.orgs ?? []).some(o => o.id === orgDId && o.name.startsWith('Smoke Org D Renamed')), `names=${JSON.stringify((lb.orgs ?? []).map(o => o.name))}`);

      // (i) transfer guards: self → 400, unknown member → 404
      const tr1 = await fetch(`${BASE}/api/orgs/${orgDId}/ownership-transfer`, {
        method: 'POST', headers: orgH, body: JSON.stringify({ targetUserId: userId }),
      });
      const tb1 = await jsonSafe(tr1);
      assert('transfer to self → 400 INVALID_TARGET', tr1.status === 400 && tb1.error === 'INVALID_TARGET', `status=${tr1.status}, error=${tb1.error}`);

      const tr2 = await fetch(`${BASE}/api/orgs/${orgDId}/ownership-transfer`, {
        method: 'POST', headers: orgH, body: JSON.stringify({ targetUserId: '00000000-0000-4000-8000-000000000009' }),
      });
      const tb2 = await jsonSafe(tr2);
      assert('transfer to unknown member → 404 MEMBER_NOT_FOUND', tr2.status === 404 && tb2.error === 'MEMBER_NOT_FOUND', `status=${tr2.status}, error=${tb2.error}`);

      // (j) A transfers ownership to B2 (admin) → 200
      const tr3 = await fetch(`${BASE}/api/orgs/${orgDId}/ownership-transfer`, {
        method: 'POST', headers: orgH, body: JSON.stringify({ targetUserId: b2UserId }),
      });
      const tb3 = await jsonSafe(tr3);
      assert('ownership transfer A → B2 → 200', tr3.status === 200 && !tb3.warning, `status=${tr3.status}, warning=${tb3.warning ?? ''}`);
      await dumpD('after transfer');

      // (k) roles swapped on both sides (end-to-end via /api/orgs)
      const lstA = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${jwt}` } });
      const lbA = await jsonSafe(lstA);
      assert('A is now admin in org D', lbA.orgs?.find(o => o.id === orgDId)?.role === 'admin', `role=${lbA.orgs?.find(o => o.id === orgDId)?.role}`);
      const lstB = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${b2Jwt}` } });
      const lbB = await jsonSafe(lstB);
      assert('B2 is now owner in org D', lbB.orgs?.find(o => o.id === orgDId)?.role === 'owner', `role=${lbB.orgs?.find(o => o.id === orgDId)?.role}`);

      // (l) the OLD owner (now admin) cannot transfer again
      const tr4 = await fetch(`${BASE}/api/orgs/${orgDId}/ownership-transfer`, {
        method: 'POST', headers: orgH, body: JSON.stringify({ targetUserId: userId }),
      });
      const tb4 = await jsonSafe(tr4);
      assert('ex-owner transfer attempt → 403', tr4.status === 403 && tb4.error === 'ORG_MANAGEMENT_FORBIDDEN', `status=${tr4.status}, error=${tb4.error}`);

      // (m) new owner (B2) removes A → 200; org D leaves A's list
      const rmA = await fetch(`${BASE}/api/orgs/${orgDId}/members/${userId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${b2Jwt}` },
      });
      assert('new owner removes A → 200', rmA.status === 200, `status=${rmA.status}`);
      const lstA2 = await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${jwt}` } });
      const lbA2 = await jsonSafe(lstA2);
      assert("org D gone from A's list after removal", !(lbA2.orgs ?? []).some(o => o.id === orgDId), `orgs=${JSON.stringify(lbA2.orgs?.length)}`);

      // (n) LAST_WORKSPACE guard: org D is B2's only workspace → 409
      const del1 = await fetch(`${BASE}/api/orgs/${orgDId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${b2Jwt}` } });
      const db1 = await jsonSafe(del1);
      assert('deleting the only workspace → 409 LAST_WORKSPACE', del1.status === 409 && db1.error === 'LAST_WORKSPACE', `status=${del1.status}, error=${db1.error}`);

      // (o) cleanup org D (service-role delete cascades members)
      const { error: delDErr } = await adminClientD.from('organizations').delete().eq('id', orgDId);
      assert('org D cleanup delete succeeded', !delDErr, `error=${delDErr?.message ?? ''}`);
    }
  }

  console.log('\n─── Test 15: /api/auth/logout with JWT + refreshToken revokes the session ───');
  {
    const res = await fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('ok: true', body.ok === true, `ok=${body.ok}`);

    // Revocation proof (Phase 3): the revoked refresh token must no longer
    // renew the session — a leaked token cannot outlive the logout.
    const rr = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    const rb = await jsonSafe(rr);
    assert('revoked refreshToken can no longer renew', rr.status === 401, `status=${rr.status}`);
    assert('revocation reports INVALID_REFRESH_TOKEN', rb.error === 'INVALID_REFRESH_TOKEN', `error=${rb.error}`);
  }

  console.log('\n─── Test 16: /api/auth/logout without JWT also returns 200 (idempotent) ───');
  {
    const res = await fetch(`${BASE}/api/auth/logout`, { method: 'POST' });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('ok: true', body.ok === true, `ok=${body.ok}`);
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error('\n[FATAL]', e.message);
    console.error(e.stack);
  } finally {
    await cleanup();
    const passed = assertions.filter(a => a.passed).length;
    const failed = assertions.length - passed;
    console.log(`\n──────────────────────────────────────`);
    console.log(`Summary: ${passed} / ${assertions.length} assertions passed${failed ? `, ${failed} FAILED` : ''}`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();
