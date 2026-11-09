/**
 * Phase 3 token-refresh unit tests — pure decision logic.
 *
 * The refresh engine lives in src/services/authClient.ts. Only the pure
 * helpers are unit-testable here (the network paths are covered live by
 * scripts/db/authSmoke.mjs and in local mode by the integration suite).
 * Importing authClient in node is safe: it touches sessionStorage only
 * inside guarded functions that swallow the ReferenceError.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldProactiveRefresh } from '../../src/services/authClient';

// Supabase default access-token lifetime: 3600s (1h).
const HOUR = 3600;

test('shouldProactiveRefresh: null expiry never refreshes proactively', () => {
  // Unknown expiry → we cannot know when to renew; the 401 path handles it.
  assert.equal(shouldProactiveRefresh(null, Date.now()), false);
});

test('shouldProactiveRefresh: fresh token (1h left) does not refresh', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 + HOUR, now), false);
});

test('shouldProactiveRefresh: token inside 60s leeway window refreshes', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 + 30, now), true); // 30s left
  assert.equal(shouldProactiveRefresh(now / 1000 + 59, now), true); // just inside
});

test('shouldProactiveRefresh: exactly at leeway boundary refreshes (<=)', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 + 60, now), true); // boundary inclusive
});

test('shouldProactiveRefresh: just outside leeway does not refresh', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 + 61, now), false);
  assert.equal(shouldProactiveRefresh(now / 1000 + 120, now), false);
});

test('shouldProactiveRefresh: already-expired token refreshes', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 - 1, now), true);
  assert.equal(shouldProactiveRefresh(now / 1000 - HOUR, now), true);
});

test('shouldProactiveRefresh: custom leeway is honored', () => {
  const now = 1_700_000_000_000;
  // 5-minute leeway: token with 4 min left must refresh.
  assert.equal(shouldProactiveRefresh(now / 1000 + 240, now, 300), true);
  // Token with 6 min left must not.
  assert.equal(shouldProactiveRefresh(now / 1000 + 360, now, 300), false);
});

test('shouldProactiveRefresh: fractional seconds in expiresAt work', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldProactiveRefresh(now / 1000 + 45.7, now), true);
  assert.equal(shouldProactiveRefresh(now / 1000 + 90.3, now), false);
});
