// Live cloud inspection — read-only, service role. Prints NO secrets.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('MISSING_ENV: SUPABASE_URL / service key not set');
  process.exit(1);
}
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const q = async (label, table, select = '*') => {
  const { data, error, count } = await admin.from(table).select(select, { count: 'exact' });
  if (error) { console.log(`[${table}] ERROR: ${error.message}`); return null; }
  console.log(`[${table}] rows=${count ?? data.length}`);
  return data;
};

console.log('=== AUTH USERS (GoTrue) ===');
const { data: usersData, error: uErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
if (uErr) console.log('listUsers ERROR:', uErr.message);
else {
  console.log(`total_users=${usersData.users.length}`);
  for (const u of usersData.users) {
    console.log(`- ${u.email} | confirmed=${u.email_confirmed_at ? 'YES' : 'NO'} | created=${u.created_at}`);
  }
}

console.log('\n=== PUBLIC TABLES ===');
const orgs = await q('orgs', 'organizations', 'id,name,slug,created_by,created_at');
const brands = await q('brands', 'brands', 'id,name,org_id');
const drafts = await q('content_drafts', 'content_drafts', 'id,title,org_id');
await q('calendar_events', 'calendar_events', 'id,org_id');
await q('organization_members', 'organization_members', 'org_id,user_id,role');

if (orgs?.length) {
  console.log('\n=== ORG DETAIL ===');
  for (const o of orgs) console.log(`- org "${o.name ?? o.id}" created=${o.created_at}`);
}
if (brands?.length) {
  console.log('\n=== BRANDS ===');
  for (const b of brands) {
    const orgName = orgs?.find((o) => o.id === b.org_id)?.name ?? b.org_id;
    console.log(`- "${b.name}" (org: ${orgName})`);
  }
}
if (drafts?.length) {
  console.log('\n=== CONTENT DRAFTS ===');
  for (const d of drafts.slice(0, 12)) {
    const orgName = orgs?.find((o) => o.id === d.org_id)?.name ?? d.org_id;
    console.log(`- "${d.title}" (org: ${orgName})`);
  }
  if (drafts.length > 12) console.log(`... aur ${drafts.length - 12} drafts`);
}
console.log('\nDone (read-only).');
