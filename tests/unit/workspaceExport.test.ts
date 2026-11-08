import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkspaceExport,
  WORKSPACE_EXPORT_FORMAT_VERSION,
} from '../../src/utils/workspaceFile';
import {
  buildExportJson,
  suggestedExportFileName,
  collectWorkspaceExport,
  EXPORT_SOURCE_KEYS,
} from '../../src/utils/workspaceExport';

/** Minimal localStorage stub for Node (browser API is not present here). */
function stubLocalStorage(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

function validFile() {
  return {
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    exportedAt: '2026-11-08T10:00:00.000Z',
    source: 'localStorage' as const,
    data: { brands: [], drafts: [], calendarEvents: [], settings: null, activeBrandId: null },
  };
}

test('validateWorkspaceExport accepts the canonical empty export', () => {
  const r = validateWorkspaceExport(validFile());
  assert.ok(r.ok);
});

test('wrong formatVersion is fatal', () => {
  const r = validateWorkspaceExport({ ...validFile(), formatVersion: 99 });
  assert.ok(!r.ok);
});

test('non-object input is fatal', () => {
  assert.ok(!validateWorkspaceExport('nope').ok);
  assert.ok(!validateWorkspaceExport(null).ok);
});

test('missing arrays are fatal; null settings is fine', () => {
  const f = validFile() as unknown as Record<string, unknown>;
  f.data = { settings: null, activeBrandId: null };
  const r = validateWorkspaceExport(f);
  assert.ok(!r.ok);
});

test('buildExportJson serializes a valid file to stable JSON', () => {
  const json = buildExportJson(validFile());
  assert.equal(JSON.parse(json).formatVersion, WORKSPACE_EXPORT_FORMAT_VERSION);
});

test('buildExportJson throws on a structurally broken file (programmer error)', () => {
  const bad = { ...validFile(), formatVersion: 42 } as never;
  assert.throws(() => buildExportJson(bad));
});

test('suggestedExportFileName is timestamped and safe', () => {
  const name = suggestedExportFileName(new Date('2026-11-08T10:00:00Z'));
  assert.match(name, /^omni-channel-plus-backup-2026-11-08T10-00-00\.json$/);
});

test('collectWorkspaceExport returns null when everything is empty', () => {
  stubLocalStorage({});
  assert.equal(collectWorkspaceExport(), null);
});

test('collectWorkspaceExport bundles all five keys with counts', () => {
  const brands = [{ id: 'b1', name: 'Acme' }];
  const drafts = [{ id: 'd1', title: 'T' }];
  const events = [{ id: 'e1' }, { id: 'e2' }];
  stubLocalStorage({
    [EXPORT_SOURCE_KEYS.brands]: JSON.stringify(brands),
    [EXPORT_SOURCE_KEYS.drafts]: JSON.stringify(drafts),
    [EXPORT_SOURCE_KEYS.events]: JSON.stringify(events),
    [EXPORT_SOURCE_KEYS.settings]: JSON.stringify({ workspaceName: 'WS' }),
    [EXPORT_SOURCE_KEYS.activeBrand]: JSON.stringify('b1'),
  });
  const file = collectWorkspaceExport(new Date('2026-11-08T10:00:00Z'));
  assert.ok(file);
  assert.equal(file!.data.brands.length, 1);
  assert.equal(file!.data.drafts.length, 1);
  assert.equal(file!.data.calendarEvents.length, 2);
  assert.equal(file!.data.activeBrandId, 'b1');
  assert.equal(file!.exportedAt, '2026-11-08T10:00:00.000Z');
});

test('collectWorkspaceExport tolerates corrupt JSON keys (treated as empty)', () => {
  stubLocalStorage({
    [EXPORT_SOURCE_KEYS.brands]: '{broken json',
    [EXPORT_SOURCE_KEYS.drafts]: JSON.stringify([{ id: 'd1' }]),
  });
  const file = collectWorkspaceExport();
  assert.ok(file);
  assert.equal(file!.data.brands.length, 0);
  assert.equal(file!.data.drafts.length, 1);
});
