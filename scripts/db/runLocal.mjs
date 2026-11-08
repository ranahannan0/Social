#!/usr/bin/env node
/**
 * Local database verification runner (Phase 2).
 *
 * 1. Creates a FRESH database `omnip_test` on the local PostgreSQL instance.
 * 2. Applies supabase/tests/local_shim.sql (test-only auth mock).
 * 3. Applies supabase/migrations/0001..0006 in order (the exact files that
 *    ship to Supabase — no local rewriting).
 * 4. Runs supabase/tests/isolation.test.mjs (cross-tenant RLS assertions).
 *
 * Requires a running local PostgreSQL (sandbox: ~/pg/bin/pg_ctl on port 5433).
 * These migrations are ALSO marked untested-against-Supabase until real
 * Supabase credentials are available; local verification proves SQL and RLS
 * logic, not the Supabase-specific auth integration.
 *
 * Usage: node scripts/db/runLocal.mjs
 */
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = process.env.PGHOST || '/tmp';
const PORT = process.env.PGPORT || '5433';
const USER = process.env.PGUSER || 'postgres';
const ADMIN = `postgres:///${'postgres'}?host=${HOST}&port=${PORT}&user=${USER}`;
const TESTDB = 'omnip_test';

function sqlFile(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`missing file: ${p}`);
  return readFileSync(p, 'utf8');
}

async function main() {
  const adm = new pg.Client({ connectionString: ADMIN });
  await adm.connect();

  // Fresh slate every run → deterministic, idempotent verification.
  await adm.query(`DROP DATABASE IF EXISTS ${TESTDB}`);
  await adm.query(`CREATE DATABASE ${TESTDB}`);
  await adm.end();

  const conn = `postgres:///${TESTDB}?host=${HOST}&port=${PORT}&user=${USER}`;
  const db = new pg.Client({ connectionString: conn });
  await db.connect();

  const steps = [
    'supabase/tests/local_shim.sql',
    'supabase/migrations/0001_extensions_and_enums.sql',
    'supabase/migrations/0002_core_tenancy.sql',
    'supabase/migrations/0003_brands_drafts.sql',
    'supabase/migrations/0004_events_checks_jobs_settings.sql',
    'supabase/migrations/0005_rls_policies.sql',
    'supabase/migrations/0006_provision_demo_workspace.sql',
    'supabase/migrations/0007_supabase_default_privilege_hardening.sql',
    'supabase/migrations/0008_default_privilege_lockdown.sql',
  ];

  for (const f of steps) {
    try {
      await db.query(sqlFile(f));
      console.log(`✓ applied: ${f}`);
    } catch (e) {
      console.error(`✗ FAILED applying ${f}: ${e.message}`);
      process.exit(1);
    }
  }

  // Integrity sanity: every tenant table has RLS forced.
  const rls = await db.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`);
  const tenant = ['brands', 'calendar_events', 'compliance_checks', 'content_drafts',
                  'generation_jobs', 'organization_members', 'organization_settings',
                  'organizations', 'profiles'];
  const bad = rls.rows.filter(
    r => tenant.includes(r.relname) && !(r.relrowsecurity && r.relforcerowsecurity));
  if (bad.length) {
    console.error(`✗ RLS not enabled+forced on: ${bad.map(b => b.relname).join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ RLS enabled+forced on all ${tenant.length} tenant tables`);

  await db.end();

  const { spawnSync } = await import('node:child_process');
  // Phase A: RLS isolation suite (JS, no TS imports)
  const r1 = spawnSync(process.execPath,
    [join(ROOT, 'supabase/tests/isolation.test.mjs'), conn],
    { stdio: 'inherit' });
  if (r1.status !== 0) process.exit(r1.status ?? 1);

  // Phase B: import-mapper → real-schema suite (TS imports via tsx)
  const r2 = spawnSync(process.execPath,
    ['--import', 'tsx', join(ROOT, 'supabase/tests/importMapper.db.test.ts'), conn],
    { stdio: 'inherit' });
  process.exit(r2.status ?? 1);
}

main().catch(e => { console.error('RUNNER ERROR:', e.message); process.exit(1); });
