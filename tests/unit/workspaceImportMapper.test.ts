import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapWorkspaceImport,
  PLATFORMS,
} from '../../src/utils/workspaceImportMapper';
import { WORKSPACE_EXPORT_FORMAT_VERSION, type WorkspaceExportFile } from '../../src/utils/workspaceFile';
import type { ContentDraft } from '../../src/types';

function baseFile(overrides: Partial<WorkspaceExportFile['data']> = {}): WorkspaceExportFile {
  return {
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    exportedAt: '2026-11-08T10:00:00.000Z',
    source: 'localStorage',
    data: {
      brands: [],
      drafts: [],
      calendarEvents: [],
      settings: null,
      activeBrandId: null,
      ...overrides,
    },
  };
}

function brand(id: string, name: string) {
  return {
    id, name, tagline: 't', industry: 'i', targetAudience: 'a',
    brandVoice: { tone: 'pro', bannedWords: ['x'], styleGuidelines: 's', sampleCopy: 'c' },
    preferredLanguage: 'English' as const,
    productsAndServices: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function draft(overrides: Record<string, unknown>): ContentDraft {
  return {
    id: 'd1', brandId: 'b1', title: 'Draft 1', topic: 'Topic', platform: 'linkedin',
    objective: 'Authority', language: 'English', audience: 'a',
    selectedHookType: 'patternInterrupt',
    hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' },
    caption: 'cap', callToAction: '', hashtags: [],
    status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ContentDraft;
}

test('happy path: valid export maps all entities with correct counts', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({ id: 'd1', brandId: 'b1', status: 'ready' })],
    calendarEvents: [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'Ev', platform: 'linkedin',
        date: '2026-03-13', time: '10:00', status: 'scheduled', summary: 's' },
    ],
    settings: { workspaceName: 'My WS', timezone: 'Asia/Karachi', autoSaveDrafts: false },
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) return;
  assert.equal(out.value.workspaceName, 'My WS');
  assert.equal(out.value.timezone, 'Asia/Karachi');
  assert.equal(out.value.autoSaveDrafts, false);
  assert.equal(out.value.brands.length, 1);
  assert.equal(out.value.drafts.length, 1);
  assert.equal(out.value.events.length, 1);
  assert.equal(out.value.warnings.skipped.brands, 0);
});

test('complianceStatus becomes an append-only check row', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({
      complianceStatus: { passed: true, detectedFluff: [], charCount: 90, maxLimit: 3000, warnings: ['w1'] },
    })],
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.checks.length, 1);
  assert.equal(out.value.checks[0].legacyDraftId, 'd1');
  assert.equal(out.value.checks[0].checkVersion, 'v1');
  assert.equal(out.value.checks[0].passed, true);
});

test('duplicate brand names: first kept, rest skipped with note', () => {
  const file = baseFile({ brands: [brand('b1', 'Acme'), brand('b2', '  acme ')] });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.brands.length, 1);
  assert.equal(out.value.brands[0].legacyId, 'b1');
  assert.equal(out.value.warnings.skipped.brands, 1);
  assert.ok(out.value.warnings.notes.some(n => n.includes('duplicate name')));
});

test('draft with unknown platform is skipped', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({ platform: 'myspace' as never })],
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.drafts.length, 0);
  assert.equal(out.value.warnings.skipped.drafts, 1);
});

test('scheduled draft with unparseable date downgrades to ready (never fabricates)', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({ status: 'scheduled', scheduledDate: 'not-a-date' })],
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.drafts[0].status, 'ready');
  assert.equal(out.value.drafts[0].scheduledAtUtc, null);
});

test('naive scheduledDate converts via workspace timezone (Karachi +5)', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({ status: 'scheduled', scheduledDate: '2026-03-13T00:30:00' })],
    calendarEvents: [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'Ev', platform: 'linkedin',
        date: '2026-03-13', time: '00:30', status: 'scheduled', summary: '' },
    ],
    settings: { timezone: 'Asia/Karachi' },
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.drafts[0].scheduledAtUtc, '2026-03-12T19:30:00.000Z');
  assert.equal(out.value.events[0].scheduledAtUtc, '2026-03-12T19:30:00.000Z');
});

test('event linked to a missing draft becomes standalone with a note', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    calendarEvents: [
      { id: 'e1', draftId: 'ghost', brandId: 'b1', title: 'Ev', platform: 'linkedin',
        date: '2026-03-13', time: '10:00', status: 'scheduled', summary: '' },
    ],
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.events[0].legacyDraftId, null);
  assert.ok(out.value.warnings.notes.some(n => n.includes('standalone')));
});

test('scheduled draft that lost ALL its events is downgraded (D-2/D-3 consistency)', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    drafts: [draft({ id: 'd1', status: 'scheduled', scheduledDate: '2026-03-13T10:00:00' })],
    // no events → the schedule cannot be represented
    settings: { timezone: 'Asia/Karachi' },
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.drafts[0].status, 'ready');
  assert.equal(out.value.drafts[0].scheduledAtUtc, null);
  assert.ok(out.value.warnings.notes.some(n => n.includes('downgraded to ready')));
});

test('event with missing brand is skipped', () => {
  const file = baseFile({
    calendarEvents: [
      { id: 'e1', brandId: 'ghost', title: 'Ev', platform: 'linkedin',
        date: '2026-03-13', time: '10:00', status: 'scheduled', summary: '' },
    ],
  });
  const out = mapWorkspaceImport(file, {});
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.events.length, 0);
  assert.equal(out.value.warnings.skipped.events, 1);
});

test('invalid settings timezone falls back to default with a note', () => {
  const file = baseFile({
    brands: [brand('b1', 'Acme')],
    settings: { timezone: 'Mars/Olympus' },
  });
  const out = mapWorkspaceImport(file, { defaultTimezone: 'Asia/Karachi' });
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.value.timezone, 'Asia/Karachi');
  assert.ok(out.value.warnings.notes.some(n => n.includes('not a valid IANA zone')));
});

test('structurally invalid files are rejected with errors, not mapped', () => {
  const bad = { formatVersion: 99, data: {} };
  const out = mapWorkspaceImport(bad, {});
  assert.ok(!out.ok);
  if (out.ok) return;
  assert.ok(out.errors.some(e => e.includes('formatVersion')));
});

test('platform list has exact parity with the DB enum (10 platforms)', () => {
  assert.deepEqual(PLATFORMS.sort(), [
    'blog_seo', 'email', 'instagram_feed', 'instagram_reels', 'linkedin',
    'pinterest', 'tiktok', 'whatsapp', 'x', 'youtube',
  ]);
});
