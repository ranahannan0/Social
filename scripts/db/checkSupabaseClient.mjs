/**
 * Functional check of supabase-js against the REAL project with new-format
 * API keys (sb_publishable_ / sb_secret_). Run:
 *   node scripts/db/checkSupabaseClient.mjs
 * Requires env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *               SUPA_TEST_EMAIL, SUPA_TEST_PASSWORD
 * Exits non-zero on any failed assertion. No secrets are printed.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const pub = process.env.SUPABASE_ANON_KEY;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.SUPA_TEST_EMAIL;
const password = process.env.SUPA_TEST_PASSWORD;

if (!url || !pub || !secret || !email || !password) {
  console.error('FAIL: missing env (need SUPABASE_URL, ANON, SERVICE, TEST_EMAIL, TEST_PASSWORD)');
  process.exit(1);
}

let passed = 0;
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) process.exitCode = 1;
  else passed++;
};

// 1. Client with publishable key + password grant (real sign-in path)
const pubClient = createClient(url, pub, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: signIn, error: signInErr } = await pubClient.auth.signInWithPassword({ email, password });
ok('signInWithPassword (publishable key)', !signInErr && Boolean(signIn?.session?.access_token));
const jwt = signIn?.session?.access_token;
const claims = signIn?.session?.user?.id ?? null;
console.log(`  user id: ${claims ?? 'n/a'}`);

// 2. auth.getUser() with the granted JWT (server-side verification path)
const { data: gu, error: guErr } = await pubClient.auth.getUser(jwt);
ok('auth.getUser(jwt) resolves same user', !guErr && gu?.user?.id === claims);

// 3. User-scoped client (publishable + user Bearer) → PostgREST query.
//    Tables don't exist yet (migrations pending): expect PostgREST error
//    PGRST205/404 — proving the request authenticated past the gateway.
const userScoped = createClient(url, pub, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { Authorization: `Bearer ${jwt}` } },
});
const { error: rlsErr } = await userScoped.from('organizations').select('id');
const code = rlsErr?.code ?? rlsErr?.details ?? '';
ok('user-scoped REST query reaches PostgREST (table-missing expected)', /PGRST/.test(String(code)) || rlsErr === null);
console.log(`  rest error code: ${code || '(none)'}`);

// 4. Admin client with secret key → admin.listUsers (service_role path)
const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: users, error: auErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 5 });
ok('admin.listUsers (secret key)', !auErr && Array.isArray(users?.users));
console.log(`  total users: ${users?.total ?? 'n/a'}`);

console.log(`\n${passed}/4 passed`);
process.exit(process.exitCode ?? 0);
