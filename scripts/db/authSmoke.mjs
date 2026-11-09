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
