/**
 * Server smoke test — REAL Supabase end-to-end (Phase 2 cutover gate 3).
 *
 * Boots the actual Express server with STORAGE_MODE=supabase and exercises:
 *   1. health reports storageMode=supabase
 *   2. workspace endpoints are JWT-gated (401 without/garbage token)
 *   3. real sign-in → export works for a fresh user
 *   4. real import (brand + drafts + scheduled event) creates rows through
 *      RLS via the user-scoped client, verified by DIRECT SQL over the pooler
 *   5. naive Karachi time lands as the correct timestamptz instant
 *   6. cleanup deletes the smoke org
 *
 * Env: SUPABASE_DB_URL (pooler), SUPA_TEST_EMAIL, SUPA_TEST_PASSWORD.
 * Server env comes from repo .env (dotenv) + STORAGE_MODE override here.
 * Exit 0 = all assertions passed. Secrets never printed.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import 'dotenv/config'; // repo .env provides SUPABASE_URL + keys for this script AND the spawned server

const PORT = 3777;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.SUPABASE_DB_URL;
const EMAIL = process.env.SUPA_TEST_EMAIL;
const PASSWORD = process.env.SUPA_TEST_PASSWORD;
const PUB = process.env.SUPABASE_ANON_KEY;
if (!DB_URL || !EMAIL || !PASSWORD || !PUB) {
  console.error('✗ need SUPABASE_DB_URL + SUPA_TEST_EMAIL + SUPA_TEST_PASSWORD + SUPABASE_ANON_KEY');
  process.exit(1);
}

let passed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (cond) passed++; else process.exitCode = 1;
};

const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  cwd: new URL('../../', import.meta.url).pathname,
  env: { ...process.env, STORAGE_MODE: 'supabase', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not become healthy. log:\n${serverLog.slice(-1500)}`);
}

try {
  // 1. Health
  const health = await waitForHealth();
  ok('health reports storageMode=supabase', health.storageMode === 'supabase', JSON.stringify(health.storageMode));

  // 2. Auth gating
  const noAuth = await fetch(`${BASE}/api/workspace/export`);
  ok('export without token → 401', noAuth.status === 401, `got ${noAuth.status}`);
  const badAuth = await fetch(`${BASE}/api/workspace/export`, {
    headers: { Authorization: 'Bearer not-a-real-jwt' },
  });
  ok('export with garbage token → 401', badAuth.status === 401, `got ${badAuth.status}`);

  // 3. Real sign-in (Supabase GoTrue password grant) + export
  const sres = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const sess = await sres.json();
  const jwt = sess?.access_token;
  ok('real password grant sign-in', sres.ok && Boolean(jwt));
  const userId = sess?.user?.id ?? null;

  const exp = await fetch(`${BASE}/api/workspace/export`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const expBody = await exp.json();
  ok('export with real token → 200', exp.status === 200, `got ${exp.status}`);

  // 4. Real import (goes through create_organization RPC + RLS inserts)
  const payload = {
    formatVersion: 1,
    exportedAt: '2026-11-08T15:00:00.000Z',
    source: 'localStorage',
    data: {
      brands: [{
        id: 'b1', name: `Smoke Brand ${Date.now()}`, tagline: 't', industry: 'i',
        targetAudience: 'a',
        brandVoice: { tone: 'pro', bannedWords: ['x'], styleGuidelines: 's', sampleCopy: 'c' },
        preferredLanguage: 'English', productsAndServices: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      drafts: [
        { id: 'd1', brandId: 'b1', title: 'Ready Draft', topic: 'T', platform: 'linkedin',
          objective: 'Authority', language: 'English', audience: 'a',
          selectedHookType: 'patternInterrupt',
          hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' },
          caption: 'cap', callToAction: '', hashtags: [],
          status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'd2', brandId: 'b1', title: 'Scheduled Draft', topic: 'T', platform: 'linkedin',
          objective: 'Authority', language: 'English', audience: 'a',
          selectedHookType: 'patternInterrupt',
          hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' },
          caption: 'cap', callToAction: '', hashtags: [],
          status: 'scheduled', scheduledDate: '2026-03-13T00:30:00',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      calendarEvents: [
        { id: 'e1', draftId: 'd2', brandId: 'b1', title: 'Smoke Event', platform: 'linkedin',
          date: '2026-03-13', time: '00:30', status: 'scheduled', summary: 's' },
      ],
      settings: { timezone: 'Asia/Karachi' },
      activeBrandId: 'b1',
    },
  };
  const imp = await fetch(`${BASE}/api/workspace/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const report = await imp.json();
  ok('import → 201 (full success, no per-row errors)',
    imp.status === 201 && (report.errors?.length ?? 1) === 0,
    `got ${imp.status} ${JSON.stringify(report).slice(0, 200)}`);
  const orgId = report.orgId;

  // 5. Direct-SQL verification over the pooler (service_role)
  const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`SET ROLE service_role`);
  const counts = await db.query(`
    SELECT
      (SELECT count(*)::int FROM organizations WHERE id=$1) AS orgs,
      (SELECT count(*)::int FROM brands WHERE org_id=$1) AS brands,
      (SELECT count(*)::int FROM content_drafts WHERE org_id=$1) AS drafts,
      (SELECT count(*)::int FROM calendar_events WHERE org_id=$1) AS events,
      (SELECT count(*)::int FROM organization_members WHERE org_id=$1 AND role='owner' AND user_id=$2) AS owner_rows
  `, [orgId, userId]);
  const c = counts.rows[0];
  ok('SQL: org+brand+2 drafts+1 event exist, caller is owner',
    c.orgs === 1 && c.brands === 1 && c.drafts === 2 && c.events === 1 && c.owner_rows === 1,
    JSON.stringify(c));
  const instant = await db.query(`
    SELECT scheduled_at AT TIME ZONE 'UTC' AS utc FROM calendar_events
    WHERE org_id=$1 AND draft_id IS NOT NULL`, [orgId]);
  const utc = instant.rows[0]?.utc?.toISOString?.() ?? String(instant.rows[0]?.utc ?? '');
  ok('SQL: naive Karachi 00:30 stored as 2026-03-12T19:30Z instant',
    utc.startsWith('2026-03-12T19:30:00'), `stored ${utc}`);

  // 6. Cleanup: delete the smoke org (cascades tenant rows)
  const del = await db.query(`DELETE FROM organizations WHERE id=$1`, [orgId]);
  const after = await db.query(`SELECT count(*)::int AS n FROM brands WHERE org_id=$1`, [orgId]);
  ok('cleanup: smoke org deleted, cascade wiped tenant rows',
    del.rowCount === 1 && after.rows[0].n === 0);
  await db.end();
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  server.kill('SIGKILL');
}

console.log(`\n${passed}/8 server smoke assertions passed.`);
process.exit(process.exitCode ?? 0);
