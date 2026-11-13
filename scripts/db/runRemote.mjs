#!/usr/bin/env node
/**
 * Remote (REAL Supabase) migration runner — Phase 2 cutover + ongoing.
 *
 * Forward-only, LEDGER-BASED: applies supabase/migrations/*.sql in filename
 * order exactly once, recording each in _omni_meta.migrations (a private
 * schema no API role can reach). Re-running is safe: applied files are
 * skipped, new files are applied incrementally.
 *
 * Baseline: projects migrated before the ledger existed (0001-0006 applied
 * 2026-11-08) are seeded as applied when their tables already exist.
 *
 * NO test shim — real auth schema, roles and GoTrue exist on Supabase.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
 *     node scripts/db/runRemote.mjs
 *
 * The URL is never printed. Exits non-zero on any failure.
 */
import pg from 'pg';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGDIR = 'supabase/migrations';
const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('✗ SUPABASE_DB_URL env required (never passed on argv)');
  process.exit(1);
}

const TENANT = ['brands', 'calendar_events', 'compliance_checks', 'content_drafts',
  'generation_jobs', 'organization_members', 'organization_settings',
  'organizations', 'profiles', 'video_assets'];

function migrationFiles() {
  return readdirSync(join(ROOT, MIGDIR))
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function sqlFile(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`missing file: ${p}`);
  return readFileSync(p, 'utf8');
}

async function main() {
  const db = new pg.Client({
    connectionString: DB_URL,
    // Supavisor's chain is not in the Node trust store; TLS stays ON but the
    // CA is not pinned. Migration runs only; app traffic uses HTTPS/PostgREST.
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  // ── Preflight: environment must look like real Supabase ──────────────────
  const pre = await db.query(
    `SELECT version() AS v, current_database() AS db, current_user AS usr`);
  console.log(`connected as ${pre.rows[0].usr} on db ${pre.rows[0].db} — ${pre.rows[0].v.split(',').slice(0, 2).join(',')}`);

  const roles = await db.query(
    `SELECT rolname FROM pg_roles
     WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`);
  if (roles.rowCount < 3) {
    console.error(`✗ Supabase roles missing: ${roles.rows.map(r => r.rolname).join(', ')}`);
    process.exit(1);
  }
  console.log('✓ Supabase roles present (anon, authenticated, service_role)');

  // ── Ledger: ensure schema + table; baseline-seed if pre-ledger project ───
  await db.query(`CREATE SCHEMA IF NOT EXISTS _omni_meta`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS _omni_meta.migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const tenantCount = await db.query(`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`, [TENANT]);
  const ledgered = await db.query(`SELECT filename FROM _omni_meta.migrations`);
  const applied = new Set(ledgered.rows.map(r => r.filename));

  if (tenantCount.rows[0].n > 0 && applied.size === 0) {
    const baseline = migrationFiles().filter(f => f < '0007');
    for (const f of baseline) {
      await db.query(`INSERT INTO _omni_meta.migrations (filename) VALUES ($1)`, [f]);
      applied.add(f);
    }
    console.log(`✓ baseline-seeded ledger: ${baseline.join(', ')} (applied pre-ledger)`);
  }

  // ── Apply pending migrations in order ────────────────────────────────────
  const pending = migrationFiles().filter(f => !applied.has(f));
  if (!pending.length) console.log('✓ all migrations already applied');
  for (const f of pending) {
    try {
      await db.query(sqlFile(join(MIGDIR, f)));
      await db.query(`INSERT INTO _omni_meta.migrations (filename) VALUES ($1)`, [f]);
      console.log(`✓ applied: ${f}`);
    } catch (e) {
      console.error(`✗ FAILED ${f}: ${e.message}`);
      process.exit(1);
    }
  }

  // ── Verify: RLS, objects, grant discipline ───────────────────────────────
  const rls = await db.query(`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`, [TENANT]);
  const bad = rls.rows.filter(r => !(r.rls && r.force));
  if (rls.rowCount !== TENANT.length || bad.length) {
    console.error(`✗ RLS check failed: ${rls.rowCount}/${TENANT.length} tables, bad: ${bad.map(b => b.relname).join(',')}`);
    process.exit(1);
  }
  console.log(`✓ RLS enabled+forced on all ${TENANT.length} tenant tables`);

  const pol = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
  const rpcs = await db.query(`
    SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('create_organization','org_role_at','can_read','can_write','can_admin','provision_demo_workspace')`);
  console.log(`✓ policies: ${pol.rows[0].n}, security RPCs: ${rpcs.rows[0].n}`);

  // Hard-deny discipline (design doc §6 + 0007/0008): compliance_checks
  // (UPDATE/DELETE for both API roles) and generation_jobs (every mutation);
  // TRUNCATE must be gone everywhere (RLS does not apply to TRUNCATE).
  const grants = await db.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND grantee IN ('anon','authenticated')
      AND table_name = ANY($1)
      AND (privilege_type = 'TRUNCATE'
        OR (table_name='compliance_checks' AND privilege_type IN ('UPDATE','DELETE'))
        OR (table_name='generation_jobs' AND privilege_type IN ('INSERT','UPDATE','DELETE')))
  `, [TENANT]);
  if (grants.rowCount > 0) {
    console.error(`✗ grant discipline broken: ${JSON.stringify(grants.rows)}`);
    process.exit(1);
  }
  console.log('✓ append-only + TRUNCATE hard-denies hold for anon/authenticated');

  await db.end();
  console.log('\nSCHEMA VERIFIED on real Supabase.');
}
main().catch(e => { console.error('RUNNER ERROR:', e.message); process.exit(1); });
