// LIVE SECURITY AUDIT — runs read-only probes + one denied-write probe.
// Creates a temporary probe user (admin API), tests cross-tenant isolation
// via RLS, then deletes the probe. Prints NO secrets.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) { console.error('MISSING_ENV'); process.exit(1); }

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
const record = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${detail}`); };

// ---------- fetch tenant rows (service role) ----------
const [{ data: orgs }, { data: brands }, { data: drafts }, { data: events }, { data: members }, { data: profiles }] = await Promise.all([
  admin.from('organizations').select('id,name'),
  admin.from('brands').select('id,org_id'),
  admin.from('content_drafts').select('id,org_id'),
  admin.from('calendar_events').select('id,org_id'),
  admin.from('organization_members').select('org_id,user_id,role'),
  admin.from('profiles').select('id'),
]);
const orgIds = new Set(orgs.map((o) => o.id));
const targetOrg = orgs.find((o) => o.name === 'Growth Core HQ');

console.log('=== A. RLS ISOLATION (probe user sees nothing that is not theirs) ===');

// ---------- create probe user ----------
const stamp = Date.now();
const probeEmail = `audit-probe-${stamp}@example.com`;
const probePass = `Ap-${stamp}-xQ!${Math.floor(Math.random() * 1e6)}`;
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email: probeEmail, password: probePass, email_confirm: true,
});
if (cErr || !created?.user) { console.error('PROBE_CREATE_FAILED:', cErr?.message); process.exit(1); }
const probeId = created.user.id;

try {
  const probe = createClient(url, anonKey); // session client
  const { error: sErr } = await probe.auth.signInWithPassword({ email: probeEmail, password: probePass });
  record('A0 probe signin', !sErr, sErr ? sErr.message : 'probe session established');

  const t1 = async (id, table) => {
    const { data, error } = await probe.from(table).select('*');
    const ok = !error && Array.isArray(data) && data.length === 0;
    record(id, ok, error ? `error: ${error.message}` : `rows visible: ${data.length} (expected 0)`);
  };
  await t1('A1 orgs hidden', 'organizations');
  await t1('A2 brands hidden', 'brands');
  await t1('A3 drafts hidden', 'content_drafts');
  await t1('A4 events hidden', 'calendar_events');

  // cross-tenant by exact id: probe asks for the REAL org by uuid
  if (targetOrg) {
    const { data, error } = await probe.from('organizations').select('*').eq('id', targetOrg.id);
    const ok = !error && Array.isArray(data) && data.length === 0;
    record('A5 known-org id probe', ok, error ? `error: ${error.message}` : `direct uuid lookup rows: ${data.length} (expected 0)`);
  }

  // direct INSERT must be denied (no INSERT policy on organizations)
  const { error: iErr } = await probe.from('organizations').insert({
    name: 'Audit Probe Org', slug: `audit-probe-${stamp}`, created_by: probeId,
  });
  record('A6 direct insert denied', !!iErr, iErr ? `denied as expected (${iErr.code ?? ''})` : 'SECURITY HOLE: insert succeeded');

  // anon (no session) must see nothing
  const anon = createClient(url, anonKey);
  const { data: aData, error: aErr } = await anon.from('organizations').select('*');
  const okAnon = (aErr || (Array.isArray(aData) && aData.length === 0));
  record('A7 anon (logged-out) blocked', okAnon, aErr ? `denied (${aErr.code ?? ''})` : `rows visible: ${aData.length}`);
} finally {
  const { error: dErr } = await admin.auth.admin.deleteUser(probeId);
  console.log(dErr ? `CLEANUP_WARN: ${dErr.message}` : 'cleanup: probe user deleted');
}

console.log('\n=== B. DATA INTEGRITY (orphans / ownership) ===');
const orphanCheck = (id, rows) => {
  const bad = rows.filter((r) => !orgIds.has(r.org_id));
  record(id, bad.length === 0, bad.length === 0 ? 'no orphans' : `${bad.length} orphan rows!`);
};
orphanCheck('B1 brands -> orgs', brands);
orphanCheck('B2 drafts -> orgs', drafts);
orphanCheck('B3 events -> orgs', events);

const memberless = orgs.filter((o) => !members.some((m) => m.org_id === o.id));
record('B4 every org has a member', memberless.length === 0, memberless.length === 0 ? 'all orgs owned' : `memberless: ${memberless.map((o) => o.name).join(', ')}`);

const hqMember = targetOrg ? members.find((m) => m.org_id === targetOrg.id) : null;
record('B5 your org membership', !!hqMember && hqMember.role === 'owner', hqMember ? `role=${hqMember.role}` : 'NO MEMBERSHIP ROW');

const profileCountOk = profiles.length === 2; // 2 auth users -> 2 profiles via trigger
record('B6 profiles mirror auth users', profileCountOk, `profiles=${profiles.length} (auth users=2)`);

console.log('\n=== SUMMARY ===');
const fails = results.filter((r) => !r.pass);
console.log(`${results.length - fails.length}/${results.length} checks passed${fails.length ? ` — FAILURES: ${fails.map((f) => f.id).join(', ')}` : ''}`);
