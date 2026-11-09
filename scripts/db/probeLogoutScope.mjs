/**
 * GoTrue logout-scope probe (throwaway diagnostic).
 *
 * Goal: find the exact REST shape that revokes ONE refresh token.
 * Tries, in order, on the REAL Supabase project:
 *   1. POST /auth/v1/logout?scope=local  + body { refresh_token }
 *   2. POST /auth/v1/logout?scope=global + body { refresh_token }
 * After each attempt it checks whether the refresh token still renews.
 */
import 'dotenv/config';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.AUTH_SMOKE_EMAIL || 'omni-admin-test@omnichannelplus.dev';
const PASSWORD = process.env.AUTH_SMOKE_PASSWORD || 'OmniTest#2026x';

async function login() {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(j)}`);
  return { jwt: j.access_token, rt: j.refresh_token };
}

async function tryLogout(scope, jwt, rt) {
  const res = await fetch(`${URL}/auth/v1/logout?scope=${scope}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}

async function canStillRefresh(rt) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });
  return res.status;
}

async function attempt(name) {
  const { jwt, rt } = await login();
  console.log(`[${name}] login ok, rt=${rt.slice(0, 8)}…`);
  return { jwt, rt };
}

const a = await attempt('scope=local');
console.log('[scope=local] logout →', JSON.stringify(await tryLogout('local', a.jwt, a.rt)));
console.log('[scope=local] refresh after →', await canStillRefresh(a.rt), '(401 = revoked, 200 = still alive)');

const b = await attempt('scope=global');
console.log('[scope=global] logout →', JSON.stringify(await tryLogout('global', b.jwt, b.rt)));
console.log('[scope=global] refresh after →', await canStillRefresh(b.rt), '(401 = revoked, 200 = still alive)');

// leave the account in a clean state: whichever token still works, revoke via the winning scope again
