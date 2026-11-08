/**
 * Stage B CRUD smoke test — live Supabase end-to-end.
 *
 * Boots the Express server with STORAGE_MODE=supabase, creates two throwaway
 * probe users (admin API, email pre-confirmed), bootstraps each workspace via
 * /api/workspace/import, then exercises the per-resource CRUD routes the way
 * the Stage B browser client does:
 *
 * - auth gates: 401 without a token
 * - validation: clean 400s from the crudMappers (never raw DB constraint errors)
 * - create/update/delete round-trips for brands, drafts, events
 * - timezone conversion: local-naive schedule input → UTC instant (Asia/Karachi)
 * - cascade semantics: brand delete removes its drafts + events server-side
 * - cross-tenant isolation: user B CANNOT touch user A's rows (404, even
 *   with the exact UUID — RLS + org scoping)
 * - cleanup: service-role deletes both workspaces + both probe users
 *
 * Env: loads .env (SUPABASE_URL, keys, STORAGE_MODE=supabase).
 */
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const PORT = String(process.env.CRUD_SMOKE_PORT || '3182');
const BASE = `http://localhost:${PORT}`;
const TZ = 'Asia/Karachi'; // UTC+5, no DST — deterministic conversions

let serverProc = null;
let serverProcExitCode = null;
const assertions = [];
const probeUserIds = [];

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
  serverProc.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
  serverProc.stderr.on('data', d => process.stderr.write(`  [server:err] ${d}`));
  serverProc.on('exit', code => { serverProcExitCode = code; });

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

function adminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createProbe(admin, stamp) {
  const email = `crud-probe-${stamp}@example.com`;
  const password = `Cp-${stamp}-xQ!${Math.floor(Math.random() * 1e6)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !data?.user) throw new Error(`probe create failed: ${error?.message}`);
  probeUserIds.push(data.user.id);
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body?.session?.accessToken) throw new Error(`probe login failed: ${JSON.stringify(body).slice(0, 200)}`);
  return { email, jwt: body.session.accessToken, userId: data.user.id };
}

async function bootstrapWorkspace(jwt, brandName) {
  const legacyId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const file = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    source: 'localStorage',
    data: {
      brands: [{
        id: legacyId,
        name: brandName,
        tagline: '', industry: 'Tech', targetAudience: '',
        brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
        preferredLanguage: 'English',
        productsAndServices: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      drafts: [],
      calendarEvents: [],
      settings: {
        workspaceName: brandName,
        defaultBrandId: legacyId,
        defaultLanguage: 'English',
        timezone: TZ,
        enableFluffHighlighting: true,
        autoSaveDrafts: true,
      },
      activeBrandId: legacyId,
    },
  };
  const res = await fetch(`${BASE}/api/workspace/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(file),
  });
  const body = await res.json();
  if (res.status !== 201 && res.status !== 207) {
    throw new Error(`bootstrap import failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
}

async function exportWorkspace(jwt) {
  const res = await fetch(`${BASE}/api/workspace/export`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return res.json();
}

async function jsonSafe(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return body;
}

async function main() {
  await startServer();
  const admin = adminClient();
  const stamp = Date.now();

  console.log('\n[setup] creating probe users + bootstrapping workspaces');
  const A = await createProbe(admin, stamp);
  const B = await createProbe(admin, stamp + 1);
  await bootstrapWorkspace(A.jwt, `Crud Seed A ${stamp}`);
  await bootstrapWorkspace(B.jwt, `Crud Seed B ${stamp}`);
  console.log('  probes ready');

  console.log('\n─── Test 1: POST /api/brands without token → 401 ───');
  {
    const res = await fetch(`${BASE}/api/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Auth' }),
    });
    const body = await jsonSafe(res);
    assert('status 401', res.status === 401, `status=${res.status}`);
    assert('error UNAUTHORIZED', body.error === 'UNAUTHORIZED', `error=${body.error}`);
  }

  console.log('\n─── Test 2: POST /api/brands creates a row (201 + uuid) ───');
  let brandId = null;
  {
    const res = await fetch(`${BASE}/api/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        name: 'Apex CRUD Systems',
        tagline: 'Ship faster',
        industry: 'SaaS',
        targetAudience: 'CTOs',
        brandVoice: { tone: 'Bold', bannedWords: ['synergy'], styleGuidelines: 'Short', sampleCopy: '' },
        preferredLanguage: 'Roman Urdu',
        productsAndServices: [{ name: 'Kinetic CMS' }, { name: 'Pulse Analytics' }],
      }),
    });
    const body = await jsonSafe(res);
    assert('status 201', res.status === 201, `status=${res.status}`);
    assert('id is a uuid', typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id), `id=${body.id}`);
    assert('name echoed', body.name === 'Apex CRUD Systems', `name=${body.name}`);
    assert('language echoed', body.preferred_language === 'Roman Urdu', `lang=${body.preferred_language}`);
    brandId = body.id;
  }

  console.log('\n─── Test 3: POST /api/brands with invalid name → 400 INVALID_ENTITY ───');
  {
    const res = await fetch(`${BASE}/api/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ name: 'x'.repeat(121) }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('error INVALID_ENTITY', body.error === 'INVALID_ENTITY', `error=${body.error}`);
    assert('issue mentions 120 cap', Array.isArray(body.errors) && body.errors.some(e => e.includes('120')), `errors=${JSON.stringify(body.errors)}`);
  }

  console.log('\n─── Test 4: PATCH /api/brands/:id updates fields (200) ───');
  {
    const res = await fetch(`${BASE}/api/brands/${brandId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ tagline: 'Updated tagline', industry: 'Cloud' }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('tagline updated', body.tagline === 'Updated tagline', `tagline=${body.tagline}`);
    assert('industry updated', body.industry === 'Cloud', `industry=${body.industry}`);
    assert('name untouched', body.name === 'Apex CRUD Systems', `name=${body.name}`);
  }

  console.log('\n─── Test 5: PATCH /api/brands/legacy-id → 400 INVALID_ID ───');
  {
    const res = await fetch(`${BASE}/api/brands/brand-1730000000000-abc`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ tagline: 'x' }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('error INVALID_ID', body.error === 'INVALID_ID', `error=${body.error}`);
  }

  console.log('\n─── Test 6: POST /api/drafts with scheduledDate converts PKT → UTC ───');
  let draftId = null;
  {
    const res = await fetch(`${BASE}/api/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        brandId,
        title: 'Kubernetes Memory Breakdown',
        topic: 'Kubernetes Memory Overhead Breakdown',
        platform: 'blog_seo',
        objective: 'Authority',
        language: 'English',
        audience: 'Platform engineers',
        selectedHookType: 'curiosityGap',
        hooks: { patternInterrupt: 'p', curiosityGap: 'c', directBenefit: 'd' },
        caption: 'Body text',
        callToAction: 'Subscribe',
        hashtags: ['k8s'],
        status: 'scheduled',
        scheduledDate: '2026-11-10T09:30',
      }),
    });
    const body = await jsonSafe(res);
    assert('status 201', res.status === 201, `status=${res.status}`);
    assert('id is a uuid', typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id), `id=${body.id}`);
    // 09:30 Asia/Karachi == 04:30 UTC
    assert('scheduled_at converted to UTC', body.scheduled_at === '2026-11-10T04:30:00+00:00' || body.scheduled_at === '2026-11-10T04:30:00.000+00:00' || String(body.scheduled_at).startsWith('2026-11-10T04:30:00'), `scheduled_at=${body.scheduled_at}`);
    assert('status echoed', body.status === 'scheduled', `status=${body.status}`);
    draftId = body.id;
  }

  console.log('\n─── Test 7: PATCH /api/drafts/:id demotes schedule (ready → scheduled_at null) ───');
  {
    const res = await fetch(`${BASE}/api/drafts/${draftId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ status: 'ready', scheduledDate: undefined }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('draft status ready', body.status === 'ready', `status=${body.status}`);
    assert('scheduled_at cleared', body.scheduled_at === null, `scheduled_at=${body.scheduled_at}`);
  }

  console.log('\n─── Test 8: POST /api/events with date+time converts and links draft ───');
  let eventId = null;
  {
    const res = await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        brandId,
        draftId,
        title: 'Publish breakdown',
        platform: 'blog_seo',
        date: '2026-11-11',
        time: '18:45',
        status: 'scheduled',
        summary: 'Go live',
      }),
    });
    const body = await jsonSafe(res);
    assert('status 201', res.status === 201, `status=${res.status}`);
    // 18:45 PKT == 13:45 UTC
    assert('scheduled_at converted', String(body.scheduled_at).startsWith('2026-11-11T13:45:00'), `scheduled_at=${body.scheduled_at}`);
    assert('timezone stored', body.timezone === TZ, `tz=${body.timezone}`);
    assert('draft linked', body.draft_id === draftId, `draft_id=${body.draft_id}`);
    eventId = body.id;
  }

  console.log('\n─── Test 9: PATCH /api/events/:id reschedules (date+time) ───');
  {
    const res = await fetch(`${BASE}/api/events/${eventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ date: '2026-11-12', time: '08:15' }),
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('rescheduled instant', String(body.scheduled_at).startsWith('2026-11-12T03:15:00'), `scheduled_at=${body.scheduled_at}`);
  }

  console.log('\n─── Test 10: POST /api/events with invalid date → 400 ───');
  {
    const res = await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ brandId, title: 'Bad date', platform: 'x', date: '2026-02-30', time: '10:00' }),
    });
    const body = await jsonSafe(res);
    assert('status 400', res.status === 400, `status=${res.status}`);
    assert('issue mentions instant', Array.isArray(body.errors) && body.errors.some(e => e.includes('valid calendar instant')), `errors=${JSON.stringify(body.errors)}`);
  }

  console.log('\n─── Test 11: export reflects CRUD state (2 brands, 1 draft, 1 event) ───');
  {
    const ws = await exportWorkspace(A.jwt);
    const w = ws.workspaces?.[0];
    assert('2 brands (seed + created)', w?.brands?.length === 2, `brands=${w?.brands?.length}`);
    assert('1 draft', w?.drafts?.length === 1, `drafts=${w?.drafts?.length}`);
    assert('1 event', w?.calendarEvents?.length === 1, `events=${w?.calendarEvents?.length}`);
  }

  console.log('\n─── Test 12: cross-tenant — user B cannot touch user A rows (404) ───');
  {
    const r1 = await fetch(`${BASE}/api/brands/${brandId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${B.jwt}` },
      body: JSON.stringify({ tagline: 'HACKED' }),
    });
    const b1 = await jsonSafe(r1);
    assert('B PATCH A brand → 404', r1.status === 404, `status=${r1.status}, body=${JSON.stringify(b1).slice(0, 80)}`);

    const r2 = await fetch(`${BASE}/api/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${B.jwt}` },
    });
    assert('B DELETE A event → 404', r2.status === 404, `status=${r2.status}`);

    // A's data is unchanged
    const ws = await exportWorkspace(A.jwt);
    const brand = ws.workspaces?.[0]?.brands?.find(x => x.id === brandId);
    assert('A brand untouched by B', brand?.tagline === 'Updated tagline', `tagline=${brand?.tagline}`);
  }

  console.log('\n─── Test 13: DELETE /api/events/:id → 200, export reflects ───');
  {
    const res = await fetch(`${BASE}/api/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${A.jwt}` },
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    assert('ok true', body.ok === true, `ok=${body.ok}`);
    const ws = await exportWorkspace(A.jwt);
    assert('event gone from export', ws.workspaces?.[0]?.calendarEvents?.length === 0, `events=${ws.workspaces?.[0]?.calendarEvents?.length}`);
  }

  console.log('\n─── Test 14: DELETE /api/drafts/:id → 200 ───');
  {
    const res = await fetch(`${BASE}/api/drafts/${draftId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${A.jwt}` },
    });
    const body = await jsonSafe(res);
    assert('status 200', res.status === 200, `status=${res.status}`);
    const ws = await exportWorkspace(A.jwt);
    assert('draft gone from export', ws.workspaces?.[0]?.drafts?.length === 0, `drafts=${ws.workspaces?.[0]?.drafts?.length}`);
  }

  console.log('\n─── Test 15: brand delete cascades drafts + events server-side ───');
  {
    const rb = await fetch(`${BASE}/api/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ name: 'Cascade Co', industry: 'Test' }),
    });
    const brand = await jsonSafe(rb);
    assert('cascade brand created', rb.status === 201, `status=${rb.status}`);
    const rd = await fetch(`${BASE}/api/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        brandId: brand.id, title: 'Cascade draft', topic: 'Cascade topic', platform: 'x',
        status: 'draft',
      }),
    });
    const draft = await jsonSafe(rd);
    assert('cascade draft created', rd.status === 201, `status=${rd.status}`);
    const re = await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        brandId: brand.id, draftId: draft.id, title: 'Cascade event',
        platform: 'x', date: '2026-11-13', time: '10:00', status: 'scheduled',
      }),
    });
    assert('cascade event created', re.status === 201, `status=${re.status}`);

    const del = await fetch(`${BASE}/api/brands/${brand.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${A.jwt}` },
    });
    assert('brand delete 200', del.status === 200, `status=${del.status}`);

    const ws = await exportWorkspace(A.jwt);
    const w = ws.workspaces?.[0];
    assert('cascade draft gone', !w?.drafts?.some(d => d.id === draft.id), `drafts=${w?.drafts?.length}`);
    assert('cascade event gone', !w?.calendarEvents?.some(e => e.title === 'Cascade event'), `events=${w?.calendarEvents?.length}`);
    assert('cascade brand gone', !w?.brands?.some(b => b.id === brand.id), `brands=${w?.brands?.length}`);
  }

  console.log('\n─── Test 16: draft update with unchanged complianceStatus (no duplicate check) ───');
  {
    const rd = await fetch(`${BASE}/api/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({
        brandId, title: 'Compliance draft', topic: 'Compliance topic', platform: 'linkedin',
        status: 'draft',
        complianceStatus: { passed: true, detectedFluff: [], charCount: 100, maxLimit: 3000, warnings: [] },
      }),
    });
    const draft = await jsonSafe(rd);
    assert('draft with check created', rd.status === 201, `status=${rd.status}`);
    assert('checkCreated reported', draft.checkCreated === true, `checkCreated=${draft.checkCreated}`);

    const rp = await fetch(`${BASE}/api/drafts/${draft.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.jwt}` },
      body: JSON.stringify({ caption: 'edited caption (no compliance change)' }),
    });
    const patched = await jsonSafe(rp);
    assert('patch 200', rp.status === 200, `status=${rp.status}`);
    assert('no new check on plain edit', patched.checkCreated === undefined, `checkCreated=${patched.checkCreated}`);
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error('\n[FATAL]', e.message);
    console.error(e.stack);
  } finally {
    await stopServer();
    // Cleanup: delete probe workspaces first (organizations.created_by has no
    // cascade to profiles), then the users (FK cascade removes the rest).
    try {
      const admin = adminClient();
      for (const uid of probeUserIds) {
        await admin.from('organizations').delete().eq('created_by', uid);
      }
      for (const uid of probeUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
      console.log('\n[cleanup] probe workspaces + users deleted');
    } catch (e) {
      console.warn(`\n[cleanup] warning: ${e.message}`);
    }
    const passed = assertions.filter(a => a.passed).length;
    const failed = assertions.length - passed;
    console.log(`\n──────────────────────────────────────`);
    console.log(`Summary: ${passed} / ${assertions.length} assertions passed${failed ? `, ${failed} FAILED` : ''}`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();
