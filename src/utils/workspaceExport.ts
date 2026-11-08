/**
 * Client-side workspace export (Phase 1.5 — design doc §8 step 1).
 *
 * Reads all five versioned localStorage keys, validates, and triggers a
 * download. Export works in BOTH storage modes (the data being exported is
 * the browser's own localStorage) and MUST exist before any database
 * cutover, so no user data can be lost at any step.
 */

import {
  WORKSPACE_EXPORT_FORMAT_VERSION,
  validateWorkspaceExport,
  type WorkspaceExportFile,
} from './workspaceFile';
import type { BrandProfile, ContentDraft, CalendarEvent, AppSettings } from '../types';

/** Must mirror AppContext STORAGE_KEYS. Kept literal to avoid importing the context. */
export const EXPORT_SOURCE_KEYS = {
  brands: 'omni_plus_brands_v2',
  drafts: 'omni_plus_drafts_v2',
  events: 'omni_plus_events_v2',
  settings: 'omni_plus_settings_v2',
  activeBrand: 'omni_plus_active_brand_v2',
} as const;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readArray<T>(key: string): T[] {
  const v = readJson(key);
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Builds the export document from the browser's localStorage.
 * Returns null when nothing is exportable (all keys empty) — callers show
 * a neutral state; export is never fabricated.
 */
export function collectWorkspaceExport(now: Date = new Date()): WorkspaceExportFile | null {
  const brands = readArray<BrandProfile>(EXPORT_SOURCE_KEYS.brands);
  const drafts = readArray<ContentDraft>(EXPORT_SOURCE_KEYS.drafts);
  const calendarEvents = readArray<CalendarEvent>(EXPORT_SOURCE_KEYS.events);
  const settings = readJson(EXPORT_SOURCE_KEYS.settings) as Partial<AppSettings> | null;
  const activeBrandRaw = readJson(EXPORT_SOURCE_KEYS.activeBrand);
  const activeBrandId = typeof activeBrandRaw === 'string' ? activeBrandRaw : null;

  const empty =
    brands.length === 0 && drafts.length === 0 && calendarEvents.length === 0 && !settings;
  if (empty) return null;

  return {
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    source: 'localStorage',
    data: { brands, drafts, calendarEvents, settings, activeBrandId },
  };
}

/** Validates + serializes; throws only on programmer error (already typed). */
export function buildExportJson(file: WorkspaceExportFile): string {
  const verdict = validateWorkspaceExport(file);
  if (!verdict.ok) {
    throw new Error(`Export failed validation: ${verdict.issues.map(i => i.field).join(', ')}`);
  }
  return JSON.stringify(file, null, 2);
}

export function suggestedExportFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `omni-channel-plus-backup-${stamp}.json`;
}

/** Triggers a browser download of the export document. */
export function downloadWorkspaceExport(now: Date = new Date()): {
  fileName: string;
  counts: { brands: number; drafts: number; events: number };
} {
  const file = collectWorkspaceExport(now);
  if (!file) throw new Error('Nothing to export — the workspace is empty.');

  const json = buildExportJson(file);
  const fileName = suggestedExportFileName(now);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return {
    fileName,
    counts: {
      brands: file.data.brands.length,
      drafts: file.data.drafts.length,
      events: file.data.calendarEvents.length,
    },
  };
}
