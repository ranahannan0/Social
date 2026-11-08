/**
 * Workspace import mapper (Phase 2 — design doc §8 step 2). PURE: no DB, no
 * network, no browser. Converts a validated workspace export file into
 * DB-shaped rows, enforcing every mapping rule the schema requires.
 *
 * Rules (each produces a warning, never a silent mutation):
 * - Unknown platform → entity skipped.
 * - Duplicate brand names (trimmed, case-insensitive) → first kept, rest
 *   skipped (DB UNIQUE(org_id, name)).
 * - Draft scheduled WITHOUT a parseable scheduledDate → downgraded to
 *   'ready' (invariant I-2; never fabricate a date).
 * - Non-scheduled draft WITH scheduledDate → scheduledDate dropped.
 * - Events whose draftId points nowhere → become standalone (draftId null).
 * - Events/drafts whose brandId points nowhere → skipped.
 * - complianceStatus → append-only compliance_checks row (rule_local).
 * - Local-naive dates → UTC instants via workspace timezone (tzConvert).
 * - Legacy ids preserved in legacyId for the executor to link parents.
 */

import type {
  BrandProfile, ContentDraft, CalendarEvent, PlatformType,
} from '../types';
import { localNaiveToUtcIso, isValidTimezone } from './tzConvert';
import { validateWorkspaceExport, type WorkspaceExportFile } from './workspaceFile';

export const PLATFORMS: PlatformType[] = [
  'linkedin', 'x', 'instagram_reels', 'instagram_feed', 'youtube',
  'tiktok', 'pinterest', 'whatsapp', 'email', 'blog_seo',
];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?$/;

export interface MappedBrand {
  legacyId: string;
  name: string;
  tagline: string;
  industry: string;
  targetAudience: string;
  brandVoice: {
    tone: string; banned_words: string[]; style_guidelines: string; sample_copy: string;
  };
  preferredLanguage: string;
  productsServices: string[];
  createdAt: string; // ISO, normalized
  updatedAt: string;
}

export interface MappedDraft {
  legacyId: string;
  legacyBrandId: string;
  title: string;
  topic: string;
  platform: PlatformType;
  objective: string;
  language: string;
  audience: string;
  selectedHookType: string;
  hooks: { patternInterrupt: string; curiosityGap: string; directBenefit: string };
  caption: string;
  callToAction: string;
  hashtags: string[];
  status: 'draft' | 'ready' | 'scheduled';
  scheduledAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappedEvent {
  legacyId: string;
  legacyDraftId: string | null;
  legacyBrandId: string;
  title: string;
  platform: PlatformType;
  scheduledAtUtc: string;
  timezone: string;
  status: 'draft' | 'scheduled';
  summary: string;
}

export interface MappedCheck {
  legacyDraftId: string;
  passed: boolean;
  detectedFluff: string[];
  charCount: number;
  maxLimit: number;
  warnings: string[];
  checkVersion: string;
}

export interface ImportWarnings {
  skipped: { brands: number; drafts: number; events: number; checks: number };
  notes: string[];
}

export interface MappedWorkspace {
  workspaceName: string;
  timezone: string;
  autoSaveDrafts: boolean;
  brands: MappedBrand[];
  drafts: MappedDraft[];
  events: MappedEvent[];
  checks: MappedCheck[];
  warnings: ImportWarnings;
}

export type MapOutcome =
  | { ok: true; value: MappedWorkspace }
  | { ok: false; errors: string[] };

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIso(value: string | undefined, fallback: string): string {
  if (typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value))) {
    // Legacy localStorage timestamps are ISO without zone info; treat naive
    // values as UTC for audit columns (creation metadata, not scheduling).
    const parsed = new Date(value.endsWith('Z') ? value : `${value.replace(/Z$/, '')}Z`);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }
  return fallback;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Converts a workspace export file into DB-shaped rows.
 * `workspaceTimezone` is the organization's default_timezone (Asia/Karachi
 * unless the export's settings declare a valid one).
 */
export function mapWorkspaceImport(
  raw: unknown,
  options: { defaultTimezone?: string; fallbackWorkspaceName?: string } = {}
): MapOutcome {
  const structural = validateWorkspaceExport(raw);
  if (!structural.ok) {
    return {
      ok: false,
      errors: structural.issues.map(i => `${i.field}: ${i.problem}`),
    };
  }
  const file = raw as WorkspaceExportFile;
  const notes: string[] = structural.issues.map(i => `${i.field}: ${i.problem}`);
  const skipped = { brands: 0, drafts: 0, events: 0, checks: 0 };

  const settings = file.data.settings ?? {};
  const tzCandidate = asString(settings.timezone);
  const timezone = isValidTimezone(tzCandidate)
    ? tzCandidate
    : (options.defaultTimezone ?? 'Asia/Karachi');
  if (tzCandidate && tzCandidate !== timezone) {
    notes.push(`settings.timezone "${tzCandidate}" is not a valid IANA zone; using "${timezone}"`);
  }

  const workspaceName =
    asString(settings.workspaceName).trim().slice(0, 120) ||
    options.fallbackWorkspaceName ||
    'Imported Workspace';

  const autoSaveDrafts =
    typeof settings.autoSaveDrafts === 'boolean' ? settings.autoSaveDrafts : true;

  // ── Brands (dedupe by trimmed, case-insensitive name) ────────────────────
  const brands: MappedBrand[] = [];
  const seenBrandNames = new Set<string>();
  const seenBrandIds = new Set<string>();
  for (const b of file.data.brands) {
    const name = asString(b.name).trim();
    if (!name || name.length > 120) {
      skipped.brands++;
      notes.push(`brand "${asString(b.name).slice(0, 40)}" skipped: name empty or >120 chars`);
      continue;
    }
    const key = name.toLowerCase();
    if (seenBrandNames.has(key)) {
      skipped.brands++;
      notes.push(`brand "${name}" skipped: duplicate name`);
      continue;
    }
    if (typeof b.id !== 'string' || !b.id || seenBrandIds.has(b.id)) {
      skipped.brands++;
      notes.push(`brand "${name}" skipped: missing/duplicate id`);
      continue;
    }
    seenBrandNames.add(key);
    seenBrandIds.add(b.id);
    const voice = (b.brandVoice ?? {}) as Record<string, unknown>;
    brands.push({
      legacyId: b.id,
      name,
      tagline: asString(b.tagline).slice(0, 300),
      industry: asString(b.industry).slice(0, 200),
      targetAudience: asString(b.targetAudience).slice(0, 300),
      brandVoice: {
        tone: asString(voice.tone),
        banned_words: asStringArray(voice.bannedWords),
        style_guidelines: asString(voice.styleGuidelines),
        sample_copy: asString(voice.sampleCopy),
      },
      preferredLanguage: asString(b.preferredLanguage, 'English'),
      productsServices: Array.isArray(b.productsAndServices)
        ? b.productsAndServices
            .map(p => asString((p as { name?: unknown })?.name).trim())
            .filter(Boolean)
        : [],
      createdAt: normalizeIso(b.createdAt, nowIso()),
      updatedAt: normalizeIso(b.updatedAt, nowIso()),
    });
  }

  // ── Drafts (must reference a surviving brand) ────────────────────────────
  const drafts: MappedDraft[] = [];
  const survivingDraftIds = new Set<string>();
  for (const d of file.data.drafts) {
    const title = asString(d.title).trim();
    const topic = asString(d.topic).trim();
    if (!title || title.length > 300 || !topic || topic.length > 300) {
      skipped.drafts++;
      notes.push(`draft "${title.slice(0, 40)}" skipped: title/topic empty or over limit`);
      continue;
    }
    if (!PLATFORMS.includes(d.platform)) {
      skipped.drafts++;
      notes.push(`draft "${title}" skipped: unknown platform "${String(d.platform)}"`);
      continue;
    }
    if (!d.brandId || !seenBrandIds.has(d.brandId)) {
      skipped.drafts++;
      notes.push(`draft "${title}" skipped: brand not found`);
      continue;
    }

    let status: MappedDraft['status'] =
      d.status === 'scheduled' || d.status === 'ready' ? d.status : 'draft';
    let scheduledAtUtc: string | null = null;
    if (status === 'scheduled') {
      const naive = asString(d.scheduledDate); // local naive YYYY-MM-DDTHH:mm[:ss]
      const instant = naive ? localNaiveToUtcIso(naive, timezone) : null;
      if (instant) {
        scheduledAtUtc = instant;
      } else {
        // Invariant I-2: cannot be 'scheduled' without an instant. Downgrade
        // to 'ready' (content intact, scheduling lost) — never fabricate a date.
        status = 'ready';
        notes.push(
          `draft "${title}": scheduledDate "${naive}" unparseable → downgraded to ready`
        );
      }
    }

    const hooks = (d.hooks ?? {}) as unknown as Record<string, unknown>;
    survivingDraftIds.add(d.id);
    drafts.push({
      legacyId: d.id,
      legacyBrandId: d.brandId,
      title,
      topic,
      platform: d.platform,
      objective: asString(d.objective),
      language: asString(d.language, 'English'),
      audience: asString(d.audience),
      selectedHookType: asString(d.selectedHookType, 'patternInterrupt'),
      hooks: {
        patternInterrupt: asString(hooks.patternInterrupt),
        curiosityGap: asString(hooks.curiosityGap),
        directBenefit: asString(hooks.directBenefit),
      },
      caption: asString(d.caption),
      callToAction: asString(d.callToAction),
      hashtags: asStringArray(d.hashtags),
      status,
      scheduledAtUtc,
      createdAt: normalizeIso(d.createdAt, nowIso()),
      updatedAt: normalizeIso(d.updatedAt, nowIso()),
    });
  }

  // ── Compliance checks (one per evaluated draft; latest wins) ─────────────
  const checks: MappedCheck[] = [];
  for (const d of file.data.drafts) {
    if (!survivingDraftIds.has(d.id)) continue; // draft skipped → its check too
    const cs = d.complianceStatus;
    if (!cs || typeof cs !== 'object') continue;
    checks.push({
      legacyDraftId: d.id,
      passed: (cs as { passed?: unknown }).passed === true,
      detectedFluff: asStringArray((cs as { detectedFluff?: unknown }).detectedFluff),
      charCount: Math.max(0, Number((cs as { charCount?: unknown }).charCount) || 0),
      maxLimit: Math.max(1, Number((cs as { maxLimit?: unknown }).maxLimit) || 3000),
      warnings: asStringArray((cs as { warnings?: unknown }).warnings),
      checkVersion: 'v1',
    });
  }

  // ── Events (must reference a surviving brand; draft link optional) ───────
  const events: MappedEvent[] = [];
  for (const e of file.data.calendarEvents) {
    const title = asString(e.title).trim();
    if (!title || title.length > 300) {
      skipped.events++;
      notes.push(`event "${title.slice(0, 40)}" skipped: title empty or over limit`);
      continue;
    }
    if (!PLATFORMS.includes(e.platform)) {
      skipped.events++;
      notes.push(`event "${title}" skipped: unknown platform "${String(e.platform)}"`);
      continue;
    }
    if (!e.brandId || !seenBrandIds.has(e.brandId)) {
      skipped.events++;
      notes.push(`event "${title}" skipped: brand not found`);
      continue;
    }
    const naive = `${asString(e.date)}T${asString(e.time, '00:00')}`;
    const instant = localNaiveToUtcIso(naive, timezone);
    if (!instant) {
      skipped.events++;
      notes.push(`event "${title}" skipped: date/time "${naive}" unparseable`);
      continue;
    }
    const legacyDraftId =
      typeof e.draftId === 'string' && survivingDraftIds.has(e.draftId) ? e.draftId : null;
    if (e.draftId && !legacyDraftId) {
      notes.push(`event "${title}": linked draft missing → imported as standalone`);
    }

    events.push({
      legacyId: typeof e.id === 'string' ? e.id : '',
      legacyDraftId,
      legacyBrandId: e.brandId,
      title,
      platform: e.platform,
      scheduledAtUtc: instant,
      timezone,
      status: e.status === 'draft' ? 'draft' : 'scheduled',
      summary: asString(e.summary).slice(0, 500),
    });
  }

  // ── Consistency: downgrade scheduled drafts that lost ALL their events ───
  // (A draft scheduled with no surviving scheduled event would disagree with
  //  the calendar — the exact drift audit items D-2/D-3 fix at code level.)
  const scheduledEventDraftIds = new Set(
    events.filter(e => e.status === 'scheduled' && e.legacyDraftId).map(e => e.legacyDraftId)
  );
  for (const d of drafts) {
    if (d.status === 'scheduled' && !scheduledEventDraftIds.has(d.legacyId)) {
      d.status = 'ready';
      d.scheduledAtUtc = null;
      notes.push(`draft "${d.title}": no scheduled event survived import → downgraded to ready`);
    }
    if (d.status !== 'scheduled' && d.scheduledAtUtc) {
      d.scheduledAtUtc = null;
    }
  }

  return {
    ok: true,
    value: {
      workspaceName,
      timezone,
      autoSaveDrafts,
      brands,
      drafts,
      events,
      checks,
      warnings: { skipped, notes },
    },
  };
}
