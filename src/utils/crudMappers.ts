/**
 * Single-resource CRUD mappers (Stage B — per-resource cloud sync).
 *
 * SERVER-SIDE, PURE: no DB, no network. The Express CRUD routes
 * (/api/brands, /api/drafts, /api/events) use these to turn a JSON body
 * into a validated DB row payload, applying the SAME rules as the
 * workspace import mapper (one row instead of a whole file):
 * - strict enums (platform / language / objective / hook type / status)
 * - length caps mirrored from the DB CHECK constraints → clean 400s
 *   instead of raw 23514 constraint errors
 * - local-naive scheduling inputs converted to UTC instants with the
 *   organization timezone (same tzConvert helpers as bulk import)
 * - invariant I-2: a 'scheduled' draft without a parseable date is
 *   downgraded to 'ready' — a fabricated date is never invented
 *
 * UPDATE semantics: a field is written ONLY when present in the body
 * (partial PATCH safe). The bundled client always sends full objects, so
 * in practice every mapped field is provided.
 */

import { localNaiveToUtcIso, isValidTimezone } from './tzConvert';

export class CrudValidationError extends Error {
  constructor(
    readonly issues: string[]
  ) {
    super(`Invalid ${issues.length > 1 ? 'fields' : 'field'}: ${issues.join('; ')}`);
    this.name = 'CrudValidationError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDbUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

const PLATFORMS = [
  'linkedin', 'x', 'instagram_reels', 'instagram_feed', 'youtube',
  'tiktok', 'pinterest', 'whatsapp', 'email', 'blog_seo',
] as const;

const LANGUAGES = [
  'English', 'Roman Urdu', 'Urdu (Script)', 'Hindi', 'Spanish', 'Arabic',
] as const;

const OBJECTIVES = ['Awareness', 'Lead Gen', 'Authority', 'Sales', 'Engagement'] as const;

const HOOK_TYPES = ['patternInterrupt', 'curiosityGap', 'directBenefit'] as const;

type DraftStatus = 'draft' | 'ready' | 'scheduled';
type EventStatus = 'draft' | 'scheduled';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
}

function requireString(v: unknown, field: string, issues: string[], cap?: number): string {
  const s = asString(v)?.trim() ?? '';
  if (!s) {
    issues.push(`${field} is required`);
    return '';
  }
  if (cap && s.length > cap) {
    issues.push(`${field} exceeds ${cap} characters`);
  }
  return s;
}

function optionalString(v: unknown, field: string, issues: string[], cap?: number): string | undefined {
  if (v === undefined) return undefined;
  const s = asString(v);
  if (s === undefined) {
    issues.push(`${field} must be a string`);
    return undefined;
  }
  if (cap && s.length > cap) issues.push(`${field} exceeds ${cap} characters`);
  return s;
}

function requireEnum<T extends string>(v: unknown, field: string, allowed: readonly T[], issues: string[]): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  issues.push(`${field} must be one of: ${allowed.join(', ')}`);
  return allowed[0];
}

function optionalEnum<T extends string>(v: unknown, field: string, allowed: readonly T[], issues: string[]): T | undefined {
  if (v === undefined) return undefined;
  return requireEnum(v, field, allowed, issues);
}

/** Resolves the effective workspace timezone with a safe fallback. */
export function resolveOrgTimezone(candidate: unknown): string {
  return typeof candidate === 'string' && isValidTimezone(candidate) ? candidate : 'UTC';
}

// ─────────────────────────────────────────────────────────────────────────────
// Brands
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedBrandRow {
  org_id?: string;
  name?: string;
  tagline?: string;
  industry?: string;
  target_audience?: string;
  brand_voice?: { tone: string; banned_words: string[]; style_guidelines: string; sample_copy: string };
  preferred_language?: string;
  products_services?: string[];
}

export function mapBrandPayload(
  body: unknown,
  opts: { orgId?: string; mode: 'create' | 'update' }
): { row: MappedBrandRow; notes: string[] } {
  const issues: string[] = [];
  const notes: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrudValidationError(['Request body must be a JSON object.']);
  }
  const b = body as Record<string, unknown>;
  const row: MappedBrandRow = {};
  if (opts.orgId) row.org_id = opts.orgId;

  if (b.name !== undefined || opts.mode === 'create') {
    const name = requireString(b.name, 'name', issues, 120);
    if (name) row.name = name;
  }
  const tagline = optionalString(b.tagline, 'tagline', issues, 300);
  if (tagline !== undefined) row.tagline = tagline;
  const industry = optionalString(b.industry, 'industry', issues, 200);
  if (industry !== undefined) row.industry = industry;
  const target = optionalString(b.targetAudience, 'targetAudience', issues, 300);
  if (target !== undefined) row.target_audience = target;

  if (b.brandVoice !== undefined) {
    if (!b.brandVoice || typeof b.brandVoice !== 'object' || Array.isArray(b.brandVoice)) {
      issues.push('brandVoice must be an object');
    } else {
      const v = b.brandVoice as Record<string, unknown>;
      const banned = asStringArray(v.bannedWords);
      if (banned === undefined && v.bannedWords !== undefined) {
        issues.push('brandVoice.bannedWords must be an array of strings');
      }
      row.brand_voice = {
        tone: asString(v.tone)?.trim() ?? '',
        banned_words: banned ?? [],
        style_guidelines: asString(v.styleGuidelines) ?? '',
        sample_copy: asString(v.sampleCopy) ?? '',
      };
    }
  } else if (opts.mode === 'create') {
    row.brand_voice = { tone: '', banned_words: [], style_guidelines: '', sample_copy: '' };
  }

  if (b.preferredLanguage !== undefined) {
    row.preferred_language = requireEnum(b.preferredLanguage, 'preferredLanguage', LANGUAGES, issues);
  } else if (opts.mode === 'create') {
    row.preferred_language = 'English';
  }

  if (b.productsAndServices !== undefined) {
    if (!Array.isArray(b.productsAndServices)) {
      issues.push('productsAndServices must be an array');
    } else {
      const names = (b.productsAndServices as unknown[])
        .map(p => asString((p as { name?: unknown } | null)?.name)?.trim() ?? '')
        .filter(Boolean)
        .slice(0, 50);
      row.products_services = names;
      const dropped = (b.productsAndServices as unknown[]).length - names.length;
      if (dropped > 0) notes.push(`${dropped} empty product name(s) dropped`);
    }
  } else if (opts.mode === 'create') {
    row.products_services = [];
  }

  if (issues.length > 0) throw new CrudValidationError(issues);
  return { row, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedCompliance {
  passed: boolean;
  detected_fluff: string[];
  char_count: number;
  max_limit: number;
  warnings: string[];
  check_version: string;
}

export interface MappedDraftRow {
  org_id?: string;
  brand_id?: string;
  title?: string;
  topic?: string;
  platform?: string;
  objective?: string;
  language?: string;
  audience?: string;
  selected_hook_type?: string;
  hooks?: { patternInterrupt: string; curiosityGap: string; directBenefit: string };
  caption?: string;
  call_to_action?: string;
  hashtags?: string[];
  status?: DraftStatus;
  scheduled_at?: string | null;
  compliance?: MappedCompliance;
}

/**
 * Maps a draft payload. `scheduledDate` is the frontend's local-naive stamp
 * ("YYYY-MM-DDTHH:mm") interpreted in the organization timezone.
 * Returns notes for silent downgrades (invariant I-2 and friends).
 */
export function mapDraftPayload(
  body: unknown,
  opts: { orgId?: string; orgTimezone: string; mode: 'create' | 'update' }
): { row: MappedDraftRow; notes: string[] } {
  const issues: string[] = [];
  const notes: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrudValidationError(['Request body must be a JSON object.']);
  }
  const b = body as Record<string, unknown>;
  const row: MappedDraftRow = {};
  if (opts.orgId) row.org_id = opts.orgId;

  if (b.brandId !== undefined || opts.mode === 'create') {
    if (!isDbUuid(b.brandId)) issues.push('brandId must be a UUID of an existing brand in your workspace');
    else row.brand_id = b.brandId;
  }
  if (b.title !== undefined || opts.mode === 'create') {
    const title = requireString(b.title, 'title', issues, 300);
    if (title) row.title = title;
  }
  if (b.topic !== undefined || opts.mode === 'create') {
    const topic = requireString(b.topic, 'topic', issues, 300);
    if (topic) row.topic = topic;
  }
  if (b.platform !== undefined || opts.mode === 'create') {
    row.platform = requireEnum(b.platform, 'platform', PLATFORMS, issues);
  }
  const objective = optionalEnum(b.objective, 'objective', OBJECTIVES, issues);
  if (objective !== undefined) row.objective = objective;
  const language = optionalEnum(b.language, 'language', LANGUAGES, issues);
  if (language !== undefined) row.language = language;
  const audience = optionalString(b.audience, 'audience', issues, 300);
  if (audience !== undefined) row.audience = audience;
  const hookType = optionalEnum(b.selectedHookType, 'selectedHookType', HOOK_TYPES, issues);
  if (hookType !== undefined) row.selected_hook_type = hookType;

  if (b.hooks !== undefined) {
    if (!b.hooks || typeof b.hooks !== 'object' || Array.isArray(b.hooks)) {
      issues.push('hooks must be an object');
    } else {
      const h = b.hooks as Record<string, unknown>;
      row.hooks = {
        patternInterrupt: asString(h.patternInterrupt) ?? '',
        curiosityGap: asString(h.curiosityGap) ?? '',
        directBenefit: asString(h.directBenefit) ?? '',
      };
    }
  } else if (opts.mode === 'create') {
    row.hooks = { patternInterrupt: '', curiosityGap: '', directBenefit: '' };
  }

  const caption = optionalString(b.caption, 'caption', issues, 20000);
  if (caption !== undefined) row.caption = caption;
  const cta = optionalString(b.callToAction, 'callToAction', issues, 500);
  if (cta !== undefined) row.call_to_action = cta;
  const hashtags = asStringArray(b.hashtags);
  if (b.hashtags !== undefined && hashtags === undefined) {
    issues.push('hashtags must be an array of strings');
  } else if (hashtags !== undefined) {
    row.hashtags = hashtags.slice(0, 50);
  }

  // Status + scheduling pair. Full-object PATCHes always carry both; partial
  // updates may carry either — the pair is recomputed together so the
  // invariant (scheduled ⇒ parseable instant) always holds in the DB.
  const statusProvided = b.status !== undefined;
  const dateProvided = b.scheduledDate !== undefined;
  if (statusProvided || dateProvided || opts.mode === 'create') {
    let status: DraftStatus = requireEnum(
      b.status !== undefined ? b.status : 'draft',
      'status',
      ['draft', 'ready', 'scheduled'] as const,
      issues
    );
    let scheduledAt: string | null = null;
    if (status === 'scheduled') {
      const naive = asString(b.scheduledDate)?.trim() ?? '';
      const instant = naive ? localNaiveToUtcIso(naive, opts.orgTimezone) : null;
      if (instant) {
        scheduledAt = instant;
      } else {
        // Invariant I-2: never fabricate a date — downgrade, keep content.
        status = 'ready';
        notes.push(`scheduledDate "${naive.slice(0, 40)}" unparseable → draft downgraded to ready`);
      }
    }
    row.status = status;
    row.scheduled_at = scheduledAt;
  }

  if (b.complianceStatus !== undefined && b.complianceStatus !== null) {
    if (!b.complianceStatus || typeof b.complianceStatus !== 'object' || Array.isArray(b.complianceStatus)) {
      issues.push('complianceStatus must be an object');
    } else {
      const c = b.complianceStatus as Record<string, unknown>;
      const detected = asStringArray(c.detectedFluff);
      const warnings = asStringArray(c.warnings);
      if ((c.detectedFluff !== undefined && detected === undefined) || (c.warnings !== undefined && warnings === undefined)) {
        issues.push('complianceStatus.detectedFluff/warnings must be arrays of strings');
      } else {
        row.compliance = {
          passed: c.passed === true,
          detected_fluff: detected ?? [],
          char_count: Math.max(0, Number(c.charCount) || 0),
          max_limit: Math.max(1, Number(c.maxLimit) || 3000),
          warnings: warnings ?? [],
          check_version: 'v1',
        };
      }
    }
  }

  if (issues.length > 0) throw new CrudValidationError(issues);
  return { row, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar events
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedEventRow {
  org_id?: string;
  brand_id?: string;
  draft_id?: string | null;
  title?: string;
  platform?: string;
  scheduled_at?: string;
  timezone?: string;
  status?: EventStatus;
  summary?: string;
}

export function mapEventPayload(
  body: unknown,
  opts: { orgId?: string; orgTimezone: string; mode: 'create' | 'update' }
): { row: MappedEventRow; notes: string[] } {
  const issues: string[] = [];
  const notes: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrudValidationError(['Request body must be a JSON object.']);
  }
  const b = body as Record<string, unknown>;
  const row: MappedEventRow = {};
  if (opts.orgId) {
    row.org_id = opts.orgId;
    row.timezone = opts.orgTimezone;
  }

  if (b.brandId !== undefined || opts.mode === 'create') {
    if (!isDbUuid(b.brandId)) issues.push('brandId must be a UUID of an existing brand in your workspace');
    else row.brand_id = b.brandId;
  }
  if (b.draftId !== undefined) {
    // Unknown/legacy draft references become standalone events (same rule as
    // the bulk import mapper — never fabricate a link the DB would reject).
    if (b.draftId === null || !isDbUuid(b.draftId)) {
      if (b.draftId !== null && b.draftId !== undefined && b.draftId !== '') {
        notes.push('draftId is not a cloud draft id → event imported as standalone');
      }
      row.draft_id = null;
    } else {
      row.draft_id = b.draftId;
    }
  }
  if (b.title !== undefined || opts.mode === 'create') {
    const title = requireString(b.title, 'title', issues, 300);
    if (title) row.title = title;
  }
  if (b.platform !== undefined || opts.mode === 'create') {
    row.platform = requireEnum(b.platform, 'platform', PLATFORMS, issues);
  }

  if (b.date !== undefined || b.time !== undefined || opts.mode === 'create') {
    const date = asString(b.date)?.trim() ?? '';
    const time = asString(b.time)?.trim() || '00:00';
    const instant = localNaiveToUtcIso(`${date}T${time}`, opts.orgTimezone);
    if (!instant) {
      issues.push(`date/time "${date}T${time}" is not a valid calendar instant`);
    } else {
      row.scheduled_at = instant;
    }
  }

  if (b.status !== undefined) {
    row.status = requireEnum(b.status, 'status', ['draft', 'scheduled'] as const, issues);
  } else if (opts.mode === 'create') {
    row.status = 'scheduled';
  }

  const summary = optionalString(b.summary, 'summary', issues, 500);
  if (summary !== undefined) row.summary = summary;

  if (issues.length > 0) throw new CrudValidationError(issues);
  return { row, notes };
}
