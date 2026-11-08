/**
 * Workspace export file format (Phase 1.5 — design doc §8).
 *
 * The export bundles ALL five versioned localStorage keys into one portable,
 * validated JSON document. This module is PURE (no browser, no Node APIs) so
 * the same validation runs client-side (before download), server-side
 * (before import), and in tests.
 */

import type { BrandProfile, ContentDraft, CalendarEvent, AppSettings } from '../types';

export const WORKSPACE_EXPORT_FORMAT_VERSION = 1;

/** Shape mirrors AppContext STORAGE_KEYS (_v2). */
export interface WorkspaceExportFile {
  formatVersion: number;
  exportedAt: string; // ISO timestamp
  source: 'localStorage';
  data: {
    brands: BrandProfile[];
    drafts: ContentDraft[];
    calendarEvents: CalendarEvent[];
    settings: Partial<AppSettings> | null;
    activeBrandId: string | null;
  };
}

export interface ValidationIssue {
  field: string;
  problem: string;
}

export type ValidationResult =
  | { ok: true; issues: ValidationIssue[] } // warnings only
  | { ok: false; issues: ValidationIssue[] }; // fatal

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * Structural validation only (schema/type shape). Business mapping rules
 * (platform enums, schedule invariants, dedupe) live in the import mapper.
 */
export function validateWorkspaceExport(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isObj(raw)) return { ok: false, issues: [{ field: '$', problem: 'not an object' }] };
  if (raw.formatVersion !== WORKSPACE_EXPORT_FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        {
          field: 'formatVersion',
          problem: `expected ${WORKSPACE_EXPORT_FORMAT_VERSION}, got ${String(raw.formatVersion)}`,
        },
      ],
    };
  }
  if (typeof raw.exportedAt !== 'string' || Number.isNaN(Date.parse(raw.exportedAt))) {
    issues.push({ field: 'exportedAt', problem: 'missing or not a valid timestamp' });
  }
  const data = raw.data;
  if (!isObj(data)) {
    return { ok: false, issues: [...issues, { field: 'data', problem: 'missing data object' }] };
  }

  const arrays: Array<[string, unknown, (x: unknown) => boolean]> = [
    ['data.brands', data.brands, isObj],
    ['data.drafts', data.drafts, isObj],
    ['data.calendarEvents', data.calendarEvents, isObj],
  ];
  for (const [field, value, elemCheck] of arrays) {
    if (!Array.isArray(value)) {
      issues.push({ field, problem: 'missing array (fatal)' });
      continue;
    }
    value.forEach((entry, i) => {
      if (!elemCheck(entry)) {
        issues.push({ field: `${field}[${i}]`, problem: 'entry is not an object (fatal)' });
      }
    });
  }

  if (data.settings !== null && !isObj(data.settings)) {
    issues.push({ field: 'data.settings', problem: 'must be object or null (fatal)' });
  }
  if (data.activeBrandId !== null && typeof data.activeBrandId !== 'string') {
    issues.push({ field: 'data.activeBrandId', problem: 'must be string or null (fatal)' });
  }

  const fatal = issues.some(i => i.problem.includes('fatal'));
  return fatal ? { ok: false, issues } : { ok: true, issues };
}
