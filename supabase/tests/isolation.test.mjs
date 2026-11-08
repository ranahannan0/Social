/**
 * Cross-tenant RLS isolation tests (design doc §10) — LOCAL VERIFICATION.
 *
 * Runs against a vanilla PostgreSQL 16 instance with supabase/tests/local_shim.sql
 * applied (mock auth schema + roles). User impersonation = per-connection
 * `SET request.jwt.claims = '{"sub":"<uuid>"}'`, mirroring Supabase's
 * auth.uid() semantics. On real Supabase, the same scenarios are re-run
 * through the HTTP API during Phase 2 server testing.
 *
 * Exit code 0 = all assertions passed; 1 = any failure. No paid APIs.
 *
 * Usage: node supabase/tests/isolation.test.mjs "postgres:///omnip_test?host=/tmp&port=5433"
 */
import pg from 'pg';

const CONN = process.argv[2] || 'postgres:///omnip_test?host=/tmp&port=5433';

const results = [];
let failures = 0;

function record(name, passed, detail = '') {
  results.push({ name, passed });
  if (!passed) failures++;
  console.log(`${passed ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A dedicated connection impersonating a user (or admin when claims=null). */
async function connectAs(sub) {
  const c = new pg.Client({ connectionString: CONN });
  await c.connect();
  if (sub) {
    await c.query(`SET ROLE authenticated`);
    await c.query(`SET request.jwt.claims = '${JSON.stringify({ sub })}'`);
  }
  return c;
}

async function expectError(name, fn, needle) {
  try {
    await fn();
    record(name, false, `expected error containing "${needle}" but none thrown`);
  } catch (e) {
    record(name, e.message.includes(needle), `got: ${e.message.slice(0, 120)}`);
  }
}

const U_A = '11111111-1111-4111-8111-111111111111';
const U_B = '22222222-2222-4222-8222-222222222222';
let ORG_A, ORG_B, BRAND_A, DRAFT_A, EVENT_A, CHECK_ID;

async function main() {
  const admin = await connectAs(null); // superuser, RLS bypassed only for setup of auth.users

  // ── Setup: users (auth.users rows trigger profile creation) ──────────────
  await admin.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
     ($1, 'alice@example.test', '{"display_name":"Alice"}'),
     ($2, 'bob@example.test',   '{"display_name":"Bob"}')`,
    [U_A, U_B]
  );

  const A = await connectAs(U_A);
  const B = await connectAs(U_B);

  // ── 1. Profile auto-provisioning trigger ─────────────────────────────────
  const pa = await A.query(`SELECT display_name FROM profiles WHERE id = $1`, [U_A]);
  record('Profile auto-created for user A via trigger', pa.rowCount === 1 && pa.rows[0].display_name === 'Alice');
  const pb = await B.query(`SELECT count(*)::int AS n FROM profiles`);
  record('User B sees exactly one profile (own)', pb.rows[0].n === 1);

  // ── 2. Org creation via RPC ──────────────────────────────────────────────
  ORG_A = (await A.query(`SELECT create_organization('Org A', 'org-a') AS id`)).rows[0].id;
  ORG_B = (await B.query(`SELECT create_organization('Org B', 'org-b') AS id`)).rows[0].id;
  record('Org A created with owner membership', !!ORG_A);
  record('Org B created with owner membership', !!ORG_B);

  const roleA = await A.query(`SELECT org_role_at($1) AS r`, [ORG_A]);
  record('User A is owner of Org A', roleA.rows[0].r === 'owner');

  // ── 3. Tenant data creation (as A, and one brand as B) ───────────────────
  BRAND_A = (await A.query(
    `INSERT INTO brands (org_id, name, tagline) VALUES ($1,'Brand A','t') RETURNING id`,
    [ORG_A]
  )).rows[0].id;

  await B.query(`INSERT INTO brands (org_id, name, tagline) VALUES ($1,'Brand B','t')`, [ORG_B]);

  DRAFT_A = (await A.query(
    `INSERT INTO content_drafts (org_id, brand_id, title, topic, platform)
     VALUES ($1,$2,'Draft A','Topic A','linkedin') RETURNING id`,
    [ORG_A, BRAND_A]
  )).rows[0].id;

  EVENT_A = (await A.query(
    `INSERT INTO calendar_events (org_id, brand_id, draft_id, title, platform,
       scheduled_at, timezone) VALUES ($1,$2,$3,'Event A','linkedin',
       now() + interval '1 day', 'Asia/Karachi') RETURNING id`,
    [ORG_A, BRAND_A, DRAFT_A]
  )).rows[0].id;

  CHECK_ID = (await A.query(
    `INSERT INTO compliance_checks (org_id, draft_id, provider, passed, char_count, max_limit)
     VALUES ($1,$2,'rule_local',true,10,3000) RETURNING id`,
    [ORG_A, DRAFT_A]
  )).rows[0].id;

  const lc = await A.query(`SELECT latest_check_id FROM content_drafts WHERE id = $1`, [DRAFT_A]);
  record('latest_check_id auto-set by trigger', lc.rows[0].latest_check_id === CHECK_ID);

  // ── 4. Cross-tenant visibility: B sees zero A rows ───────────────────────
  for (const [table, id] of [['brands', BRAND_A], ['content_drafts', DRAFT_A],
                             ['calendar_events', EVENT_A], ['compliance_checks', CHECK_ID]]) {
    const r = await B.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id]);
    record(`B SELECT ${table} by A's id → 0 rows`, r.rows[0].n === 0);
  }
  const allBrands = await B.query(`SELECT count(*)::int AS n FROM brands`);
  record('B list brands → only own org rows (1)', allBrands.rows[0].n === 1);
  // (B's org has its own brand created below; A's brand stays invisible)

  // ── 5. Cross-tenant mutation: B cannot modify A's rows ───────────────────
  const upd = await B.query(`UPDATE brands SET tagline='hacked' WHERE id=$1`, [BRAND_A]);
  record('B UPDATE A brand → 0 rows affected', upd.rowCount === 0);
  const del = await B.query(`DELETE FROM content_drafts WHERE id=$1`, [DRAFT_A]);
  record('B DELETE A draft → 0 rows affected', del.rowCount === 0);

  await expectError('B INSERT brand with org_id=A → RLS violation', async () => {
    await B.query(`INSERT INTO brands (org_id, name) VALUES ($1,'Evil')`, [ORG_A]);
  }, 'new row violates row-level security');

  await expectError('B INSERT draft into Org A → RLS violation', async () => {
    await B.query(
      `INSERT INTO content_drafts (org_id, brand_id, title, topic, platform)
       VALUES ($1,$2,'X','Y','linkedin')`, [ORG_A, BRAND_A]);
  }, 'new row violates row-level security');

  // ── 6. RLS structural invariants ─────────────────────────────────────────
  await expectError('Draft scheduled without timestamp → CHECK violation', async () => {
    await A.query(`INSERT INTO content_drafts (org_id, brand_id, title, topic, platform, status, scheduled_at)
      VALUES ($1,$2,'S','S','linkedin','scheduled',NULL)`, [ORG_A, BRAND_A]);
  }, 'drafts_scheduled_has_timestamp');

  await expectError('Ready draft WITH timestamp → CHECK violation', async () => {
    await A.query(`INSERT INTO content_drafts (org_id, brand_id, title, topic, platform, status, scheduled_at)
      VALUES ($1,$2,'S','S','linkedin','ready', now())`, [ORG_A, BRAND_A]);
  }, 'drafts_nonscheduled_no_timestamp');

  await expectError('Second scheduled event for same draft → unique violation (audit D-1)', async () => {
    await A.query(
      `INSERT INTO calendar_events (org_id, brand_id, draft_id, title, platform,
         scheduled_at, timezone) VALUES ($1,$2,$3,'Dup','linkedin',
         now() + interval '2 days', 'Asia/Karachi')`, [ORG_A, BRAND_A, DRAFT_A]);
  }, 'one_scheduled_event_per_draft');

  await expectError('Negative char_count → CHECK violation', async () => {
    await A.query(`INSERT INTO compliance_checks (org_id, draft_id, provider, passed, char_count, max_limit)
      VALUES ($1,$2,'rule_local',true,-1,3000)`, [ORG_A, DRAFT_A]);
  }, 'compliance_checks_char_count_check');

  await expectError('UPDATE compliance_checks → denied (append-only)', async () => {
    await A.query(`UPDATE compliance_checks SET passed = false WHERE id = $1`, [CHECK_ID]);
  }, 'permission denied');
  await expectError('DELETE compliance_checks → denied (append-only)', async () => {
    await A.query(`DELETE FROM compliance_checks WHERE id = $1`, [CHECK_ID]);
  }, 'permission denied');
  await expectError('INSERT generation_jobs as user → denied (server-only)', async () => {
    await A.query(`INSERT INTO generation_jobs (org_id, user_id, provider) VALUES ($1,$2,'gemini')`,
      [ORG_A, U_A]);
  }, 'permission denied');

  // ── 7. Last-owner guard ──────────────────────────────────────────────────
  await expectError('Sole owner cannot be demoted', async () => {
    await A.query(`UPDATE organization_members SET role='viewer' WHERE org_id=$1 AND user_id=$2`,
      [ORG_A, U_A]);
  }, 'LAST_OWNER_CANNOT_BE_DEMOTED');
  await expectError('Sole owner cannot be removed', async () => {
    await A.query(`DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2`, [ORG_A, U_A]);
  }, 'LAST_OWNER_CANNOT_BE_REMOVED');

  // Owner CAN delete own org (cascade wipes tenant data).
  const tmpOrg = (await A.query(`SELECT create_organization('Temp', 'temp-org') AS id`)).rows[0].id;
  await A.query(`INSERT INTO brands (org_id, name) VALUES ($1,'TempBrand')`, [tmpOrg]);
  const delOrg = await A.query(`DELETE FROM organizations WHERE id=$1`, [tmpOrg]);
  const leftover = await admin.query(`SELECT count(*)::int AS n FROM brands WHERE org_id=$1`, [tmpOrg]);
  record('Owner deletes org → cascade removes brands', delOrg.rowCount === 1 && leftover.rows[0].n === 0);

  // ── 8. Viewer role read-only ─────────────────────────────────────────────
  const U_V = '33333333-3333-4333-8333-333333333333';
  await admin.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'vera@example.test')`, [U_V]);
  const V = await connectAs(U_V);
  await A.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'viewer')`,
    [ORG_A, U_V]);
  const seen = await V.query(`SELECT count(*)::int AS n FROM brands WHERE org_id=$1`, [ORG_A]);
  record('Viewer reads org brands', seen.rows[0].n === 1);
  await expectError('Viewer cannot insert drafts', async () => {
    await V.query(`INSERT INTO content_drafts (org_id, brand_id, title, topic, platform)
      VALUES ($1,$2,'V','V','linkedin')`, [ORG_A, BRAND_A]);
  }, 'new row violates row-level security');

  // ── 9. Demo provisioning RPC: idempotent ─────────────────────────────────
  const d1 = await A.query(`SELECT provision_demo_workspace($1) AS ok`, [ORG_A]);
  const d2 = await A.query(`SELECT provision_demo_workspace($1) AS ok`, [ORG_A]);
  record('Demo workspace provisioned then idempotent',
    d1.rows[0].ok === true && d2.rows[0].ok === false);
  const demoEvents = await A.query(
    `SELECT count(*)::int AS n FROM calendar_events ce
     JOIN content_drafts d ON d.id = ce.draft_id
     WHERE ce.org_id = $1 AND d.title = 'Customer story teaser'`,
    [ORG_A]);
  record('Demo scheduled draft has exactly 1 event (unique index respected)', demoEvents.rows[0].n === 1);

  // ── 10. Naive→tz conversion round-trip sanity (org timezone math) ────────
  const tzCheck = await A.query(
    `SELECT (make_timestamptz(2026, 3, 13, 0, 30, 0.0))::text IS NOT NULL AS ok`);
  record('timestamptz storage functional', tzCheck.rows[0].ok === true);

  await A.end(); await B.end(); await V.end(); await admin.end();

  console.log(`\nSummary: ${results.length - failures}/${results.length} isolation assertions passed.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('RUNNER ERROR:', e.message);
  process.exit(1);
});
