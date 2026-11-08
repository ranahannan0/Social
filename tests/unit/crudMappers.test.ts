/**
 * Unit tests for the Stage B single-resource CRUD mappers (pure functions).
 * Mirrors the mapping rules of the workspace import mapper at row scale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapBrandPayload,
  mapDraftPayload,
  mapEventPayload,
  CrudValidationError,
  isDbUuid,
  resolveOrgTimezone,
} from '../../src/utils/crudMappers';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const TZ = 'Asia/Karachi'; // UTC+5, no DST — deterministic conversions

function expectValidationError(fn: () => unknown, fragment: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CrudValidationError, `expected CrudValidationError, got ${String(err)}`);
    assert.ok(
      (err as CrudValidationError).issues.some(i => i.includes(fragment)),
      `issues should mention "${fragment}", got: ${(err as CrudValidationError).issues.join(' | ')}`
    );
    return true;
  });
}

test('isDbUuid accepts canonical uuids and rejects legacy ids', () => {
  assert.equal(isDbUuid(UUID_A), true);
  assert.equal(isDbUuid('brand-1730000000000-abc123'), false);
  assert.equal(isDbUuid(''), false);
  assert.equal(isDbUuid(null), false);
  assert.equal(isDbUuid(42), false);
});

test('resolveOrgTimezone falls back to UTC for invalid zones', () => {
  assert.equal(resolveOrgTimezone('Asia/Karachi'), 'Asia/Karachi');
  assert.equal(resolveOrgTimezone('Mars/Olympus'), 'UTC');
  assert.equal(resolveOrgTimezone(undefined), 'UTC');
});

// ── Brands ───────────────────────────────────────────────────────────────────

test('brand create: full payload maps to a DB row with org scoping', () => {
  const { row, notes } = mapBrandPayload(
    {
      name: '  Apex Cloud Systems  ',
      tagline: 'Ship faster',
      industry: 'SaaS',
      targetAudience: 'CTOs',
      brandVoice: { tone: 'Bold', bannedWords: ['synergy'], styleGuidelines: 'Short', sampleCopy: 'Hi' },
      preferredLanguage: 'Roman Urdu',
      productsAndServices: [{ name: 'Kinetic CMS' }, { name: '  ' }, { description: 'no name' }],
    },
    { orgId: UUID_B, mode: 'create' }
  );
  assert.equal(row.org_id, UUID_B);
  assert.equal(row.name, 'Apex Cloud Systems');
  assert.deepEqual(row.brand_voice?.banned_words, ['synergy']);
  assert.deepEqual(row.products_services, ['Kinetic CMS']);
  assert.equal(row.preferred_language, 'Roman Urdu');
  assert.ok(notes.some(n => n.includes('2 empty product name(s) dropped')));
});

test('brand create: missing name rejected', () => {
  expectValidationError(() => mapBrandPayload({ tagline: 'x' }, { mode: 'create' }), 'name is required');
});

test('brand create: over-limit name rejected with 120 cap (DB CHECK mirror)', () => {
  expectValidationError(
    () => mapBrandPayload({ name: 'x'.repeat(121) }, { mode: 'create' }),
    'name exceeds 120 characters'
  );
});

test('brand create: invalid language enum rejected', () => {
  expectValidationError(
    () => mapBrandPayload({ name: 'Ok', preferredLanguage: 'Klingon' }, { mode: 'create' }),
    'preferredLanguage must be one of'
  );
});

test('brand update: partial payload only maps provided fields', () => {
  const { row } = mapBrandPayload({ tagline: 'New tagline' }, { mode: 'update' });
  assert.deepEqual(Object.keys(row).sort(), ['tagline']);
});

// ── Drafts ───────────────────────────────────────────────────────────────────

const draftBase = {
  brandId: UUID_A,
  title: 'Kubernetes Memory Overhead',
  topic: 'Kubernetes Memory Overhead Breakdown',
  platform: 'blog_seo',
  objective: 'Authority' as const,
  language: 'English' as const,
  audience: 'Platform engineers',
  selectedHookType: 'curiosityGap' as const,
  hooks: { patternInterrupt: 'p', curiosityGap: 'c', directBenefit: 'd' },
  caption: 'body',
  callToAction: 'Subscribe',
  hashtags: ['k8s', 'cloud'],
  status: 'draft' as const,
};

test('draft create: full payload maps, naive scheduledDate converts to UTC instant', () => {
  const { row, notes } = mapDraftPayload(
    { ...draftBase, status: 'scheduled', scheduledDate: '2026-11-10T09:30' },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'create' }
  );
  assert.equal(row.org_id, UUID_B);
  assert.equal(row.brand_id, UUID_A);
  assert.equal(row.status, 'scheduled');
  // 09:30 PKT == 04:30 UTC
  assert.equal(row.scheduled_at, '2026-11-10T04:30:00.000Z');
  assert.equal(row.selected_hook_type, 'curiosityGap');
  assert.deepEqual(row.hashtags, ['k8s', 'cloud']);
  assert.deepEqual(notes, []);
});

test('draft create: non-scheduled status drops scheduledDate', () => {
  const { row } = mapDraftPayload(
    { ...draftBase, status: 'ready', scheduledDate: '2026-11-10T09:30' },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'create' }
  );
  assert.equal(row.status, 'ready');
  assert.equal(row.scheduled_at, null);
});

test('draft invariant I-2: scheduled without parseable date downgrades to ready', () => {
  const { row, notes } = mapDraftPayload(
    { ...draftBase, status: 'scheduled', scheduledDate: 'not-a-date' },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'create' }
  );
  assert.equal(row.status, 'ready');
  assert.equal(row.scheduled_at, null);
  assert.ok(notes.some(n => n.includes('downgraded to ready')));
});

test('draft create: missing brand/title/topic/platform rejected', () => {
  expectValidationError(() => mapDraftPayload({}, { orgTimezone: TZ, mode: 'create' }), 'brandId must be a UUID');
  expectValidationError(
    () => mapDraftPayload({ brandId: UUID_A }, { orgTimezone: TZ, mode: 'create' }),
    'title is required'
  );
  expectValidationError(
    () => mapDraftPayload({ brandId: UUID_A, title: 't' }, { orgTimezone: TZ, mode: 'create' }),
    'topic is required'
  );
  expectValidationError(
    () => mapDraftPayload({ brandId: UUID_A, title: 't', topic: 'x' }, { orgTimezone: TZ, mode: 'create' }),
    'platform must be one of'
  );
});

test('draft update: complianceStatus maps to an append-only check payload', () => {
  const { row } = mapDraftPayload(
    { status: 'ready', complianceStatus: { passed: true, detectedFluff: ['very'], charCount: 120, maxLimit: 3000, warnings: ['w1'] } },
    { orgTimezone: TZ, mode: 'update' }
  );
  assert.equal(row.status, 'ready');
  assert.equal(row.compliance?.passed, true);
  assert.deepEqual(row.compliance?.detected_fluff, ['very']);
  assert.equal(row.compliance?.check_version, 'v1');
});

test('draft update: title over 300 chars rejected (DB CHECK mirror)', () => {
  expectValidationError(
    () => mapDraftPayload({ title: 'x'.repeat(301) }, { orgTimezone: TZ, mode: 'update' }),
    'title exceeds 300 characters'
  );
});

// ── Events ───────────────────────────────────────────────────────────────────

const eventBase = {
  brandId: UUID_A,
  title: 'Launch post',
  platform: 'linkedin' as const,
  date: '2026-11-11',
  time: '18:45',
  status: 'scheduled' as const,
  summary: 'Go live',
};

test('event create: local-naive date/time converts with org timezone', () => {
  const { row, notes } = mapEventPayload(
    { ...eventBase, draftId: UUID_B },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'create' }
  );
  assert.equal(row.org_id, UUID_B);
  assert.equal(row.brand_id, UUID_A);
  assert.equal(row.draft_id, UUID_B);
  assert.equal(row.scheduled_at, '2026-11-11T13:45:00.000Z'); // 18:45 PKT
  assert.equal(row.timezone, TZ);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.summary, 'Go live');
  assert.deepEqual(notes, []);
});

test('event create: invalid date rejected with clean 400 issue', () => {
  expectValidationError(
    () => mapEventPayload({ ...eventBase, date: '2026-02-30' }, { orgTimezone: TZ, mode: 'create' }),
    'not a valid calendar instant'
  );
});

test('event create: legacy/non-uuid draftId becomes standalone (note, not error)', () => {
  const { row, notes } = mapEventPayload(
    { ...eventBase, draftId: 'draft-1730000000000-xyz' },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'create' }
  );
  assert.equal(row.draft_id, null);
  assert.ok(notes.some(n => n.includes('standalone')));
});

test('event create: missing title/brand/date rejected', () => {
  expectValidationError(() => mapEventPayload({}, { orgTimezone: TZ, mode: 'create' }), 'brandId must be a UUID');
  expectValidationError(
    () => mapEventPayload({ brandId: UUID_A }, { orgTimezone: TZ, mode: 'create' }),
    'title is required'
  );
  expectValidationError(
    () => mapEventPayload({ brandId: UUID_A, title: 't' }, { orgTimezone: TZ, mode: 'create' }),
    'not a valid calendar instant'
  );
});

test('event update: partial payload (date+time) reconverts the instant', () => {
  const { row } = mapEventPayload(
    { date: '2026-11-12', time: '08:15' },
    { orgId: UUID_B, orgTimezone: TZ, mode: 'update' }
  );
  assert.equal(row.scheduled_at, '2026-11-12T03:15:00.000Z'); // 08:15 PKT
  assert.equal(row.title, undefined); // untouched field stays absent
});

test('event update: time-only payload (no date) is rejected cleanly', () => {
  expectValidationError(
    () => mapEventPayload({ time: '20:00' }, { orgTimezone: TZ, mode: 'update' }),
    'not a valid calendar instant'
  );
});
