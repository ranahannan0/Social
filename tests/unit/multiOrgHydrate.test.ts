/**
 * Phase 3 multi-org hydrator tests (P3.2).
 *
 * Covers the two pure surfaces the workspace switcher relies on:
 * - listOrgsFromExport: org summaries for the switcher UI (tolerant of junk)
 * - hydrateWorkspaceFromExport(raw, requestedOrgId): exact-org selection
 *   with a defensive first-workspace fallback
 *
 * PURE tests: no network, no browser APIs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hydrateWorkspaceFromExport,
  listOrgsFromExport,
} from '../../src/utils/workspaceHydrate';

const ORG_A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Org A', default_timezone: 'Asia/Karachi' };
const ORG_B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Org B', default_timezone: 'UTC' };

function workspaceFor(org: { id: string; name: string }, brandName: string) {
  return {
    organization: org,
    brands: [
      {
        id: `${brandName.toLowerCase()}-db-id`,
        name: brandName,
        tagline: '',
        industry: '',
        target_audience: '',
        brand_voice: {},
        preferred_language: 'English',
        products_services: [],
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    drafts: [],
    calendarEvents: [],
    settings: null,
  };
}

function multiOrgExport() {
  return {
    formatVersion: 1,
    exportedAt: '2026-11-09T00:00:00.000Z',
    source: 'database',
    workspaces: [workspaceFor(ORG_A, 'BrandFromA'), workspaceFor(ORG_B, 'BrandFromB')],
  };
}

// ── listOrgsFromExport ──────────────────────────────────────────────────────

test('listOrgsFromExport returns every workspace org in payload order', () => {
  const orgs = listOrgsFromExport(multiOrgExport());
  assert.equal(orgs.length, 2);
  assert.deepEqual(
    orgs.map(o => o.id),
    [ORG_A.id, ORG_B.id]
  );
  assert.equal(orgs[0].name, 'Org A');
  assert.equal(orgs[0].defaultTimezone, 'Asia/Karachi');
});

test('listOrgsFromExport tolerates junk payloads without throwing', () => {
  assert.deepEqual(listOrgsFromExport(null), []);
  assert.deepEqual(listOrgsFromExport('nonsense'), []);
  assert.deepEqual(listOrgsFromExport({}), []);
  assert.deepEqual(listOrgsFromExport({ workspaces: 'nope' }), []);
  // Entries without a usable org id are skipped, not fatal.
  const partial = listOrgsFromExport({
    workspaces: [{ organization: { name: 'NoId' } }, workspaceFor(ORG_B, 'B')],
  });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, ORG_B.id);
});

// ── hydrateWorkspaceFromExport with requestedOrgId ─────────────────────────

test('requestedOrgId hydrates the MATCHING workspace, not the first', () => {
  const h = hydrateWorkspaceFromExport(multiOrgExport(), ORG_B.id);
  assert.equal(h.organizationId, ORG_B.id);
  assert.equal(h.organizationName, 'Org B');
  assert.equal(h.brands.length, 1);
  assert.equal(h.brands[0].name, 'BrandFromB');
});

test('requestedOrgId absent keeps the legacy first-workspace behaviour', () => {
  const h = hydrateWorkspaceFromExport(multiOrgExport());
  assert.equal(h.organizationId, ORG_A.id);
  assert.equal(h.brands[0].name, 'BrandFromA');
});

test('unknown requestedOrgId falls back to the first workspace (defensive)', () => {
  // The switcher only offers orgs from the same payload, so a miss means
  // the org vanished mid-switch — first workspace beats throwing.
  const h = hydrateWorkspaceFromExport(multiOrgExport(), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(h.organizationId, ORG_A.id);
  assert.equal(h.brands[0].name, 'BrandFromA');
});

test('single-workspace export + requestedOrgId still hydrates it', () => {
  const single = {
    formatVersion: 1,
    exportedAt: '2026-11-09T00:00:00.000Z',
    source: 'database',
    workspaces: [workspaceFor(ORG_A, 'SoloBrand')],
  };
  const h = hydrateWorkspaceFromExport(single, ORG_A.id);
  assert.equal(h.organizationId, ORG_A.id);
  assert.equal(h.brands[0].name, 'SoloBrand');
});

test('empty workspaces + requestedOrgId still yields null org (pre-bootstrap)', () => {
  const empty = { formatVersion: 1, exportedAt: '2026-11-09T00:00:00.000Z', source: 'database', workspaces: [] };
  const h = hydrateWorkspaceFromExport(empty, ORG_A.id);
  assert.equal(h.organizationId, null);
  assert.equal(h.organizationName, null);
  assert.equal(h.brands.length, 0);
});
