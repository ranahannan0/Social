/**
 * Workspace hydrator (Phase 2 frontend cutover — design doc §8 step 4).
 *
 * Pure mapper that converts the `/api/workspace/export` response (DB-shaped
 * rows) into the frontend types consumed by AppContext. This is the inverse
 * of `workspaceImportMapper.ts` (with a small lossy surface: products lose
 * their `description`/`tierOrPrice` on round-trip because the DB stores them
 * as `text[]` of names only — Phase 3 will normalize).
 *
 * PURE: no network, no browser APIs. Safe to unit-test and run anywhere.
 */

import type {
  BrandProfile,
  ContentDraft,
  CalendarEvent,
  AppSettings,
  PlatformType,
  MarketingObjective,
  SupportedLanguage,
  HookType,
} from '../types';
import { utcIsoToLocalNaive, isValidTimezone } from './tzConvert';

const KNOWN_PLATFORMS: PlatformType[] = [
  'linkedin', 'x', 'instagram_reels', 'instagram_feed', 'youtube',
  'tiktok', 'pinterest', 'whatsapp', 'email', 'blog_seo',
];
const KNOWN_OBJECTIVES: MarketingObjective[] = [
  'Awareness', 'Lead Gen', 'Authority', 'Sales', 'Engagement',
];
const KNOWN_LANGUAGES: SupportedLanguage[] = [
  'English', 'Roman Urdu', 'Urdu (Script)', 'Hindi', 'Spanish', 'Arabic',
];
const KNOWN_HOOK_TYPES: HookType[] = ['patternInterrupt', 'curiosityGap', 'directBenefit'];
const KNOWN_STATUSES = ['draft', 'ready', 'scheduled'] as const;

const DEFAULT_SETTINGS: AppSettings = {
  workspaceName: 'Growth Core HQ',
  defaultBrandId: 'brand-01',
  defaultLanguage: 'English',
  timezone: 'Asia/Karachi (PKT, UTC+5)',
  enableFluffHighlighting: true,
  autoSaveDrafts: true,
};

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asPlatform(v: unknown): PlatformType {
  return KNOWN_PLATFORMS.includes(v as PlatformType) ? (v as PlatformType) : 'linkedin';
}

function asObjective(v: unknown): MarketingObjective {
  return KNOWN_OBJECTIVES.includes(v as MarketingObjective) ? (v as MarketingObjective) : 'Awareness';
}

function asLanguage(v: unknown): SupportedLanguage {
  return KNOWN_LANGUAGES.includes(v as SupportedLanguage) ? (v as SupportedLanguage) : 'English';
}

function asHookType(v: unknown): HookType {
  return KNOWN_HOOK_TYPES.includes(v as HookType) ? (v as HookType) : 'patternInterrupt';
}

function asStatus(v: unknown): 'draft' | 'ready' | 'scheduled' {
  return (KNOWN_STATUSES as readonly string[]).includes(v as string)
    ? (v as 'draft' | 'ready' | 'scheduled')
    : 'draft';
}

interface DbBrand {
  id: string;
  name: string;
  tagline?: string;
  industry?: string;
  target_audience?: string;
  brand_voice?: {
    tone?: string;
    banned_words?: string[];
    style_guidelines?: string;
    sample_copy?: string;
  };
  preferred_language?: string;
  products_services?: string[];
  created_at?: string;
  updated_at?: string;
}

interface DbDraft {
  id: string;
  brand_id: string;
  title: string;
  topic: string;
  platform?: string;
  objective?: string;
  language?: string;
  audience?: string;
  selected_hook_type?: string;
  hooks?: { patternInterrupt?: string; curiosityGap?: string; directBenefit?: string };
  caption?: string;
  call_to_action?: string;
  hashtags?: string[];
  status?: string;
  scheduled_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface DbEvent {
  id: string;
  draft_id?: string | null;
  brand_id: string;
  title: string;
  platform?: string;
  scheduled_at: string;
  timezone?: string;
  summary?: string;
}

interface DbSettings {
  auto_save_drafts?: boolean;
  ui_prefs?: Record<string, unknown>;
}

interface DbOrganization {
  id: string;
  name?: string;
  default_timezone?: string;
}

export interface DbWorkspaceExport {
  formatVersion: number;
  exportedAt: string;
  source: string;
  workspaces: Array<{
    organization: DbOrganization;
    brands: DbBrand[];
    drafts: DbDraft[];
    calendarEvents: DbEvent[];
    settings: DbSettings | null;
  }>;
}

export interface HydratedWorkspace {
  brands: BrandProfile[];
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  settings: AppSettings;
  activeBrandId: string | null;
  organizationId: string | null;
  organizationName: string | null;
}

/** Lightweight org descriptor for the workspace switcher UI (P3.2). */
export interface OrgSummary {
  id: string;
  name: string;
  defaultTimezone: string | null;
}

export class HydrateError extends Error {}

/** Map a single DB brand row to the frontend BrandProfile shape. */
function mapBrand(b: DbBrand): BrandProfile {
  const voice = b.brand_voice ?? {};
  return {
    id: asString(b.id),
    name: asString(b.name),
    tagline: asString(b.tagline),
    industry: asString(b.industry),
    targetAudience: asString(b.target_audience),
    brandVoice: {
      tone: asString(voice.tone),
      bannedWords: asStringArray(voice.banned_words),
      styleGuidelines: asString(voice.style_guidelines),
      sampleCopy: asString(voice.sample_copy),
    },
    preferredLanguage: asLanguage(b.preferred_language),
    productsAndServices: asStringArray(b.products_services).map((name, idx) => ({
      id: `ps-${idx + 1}`,
      name,
      description: '',
    })),
    createdAt: asString(b.created_at, new Date().toISOString()),
    updatedAt: asString(b.updated_at, new Date().toISOString()),
  };
}

/** Map a single DB draft row to the frontend ContentDraft shape. */
function mapDraft(d: DbDraft, orgTz: string): ContentDraft {
  const hooks = d.hooks ?? {};
  // scheduledDate is a LOCAL-NAIVE stamp ("YYYY-MM-DDTHH:mm:00") across the
  // whole frontend model (see dataIntegrity.formatEventStamp). DB stores the
  // UTC instant — convert with the organization timezone so a hydrated draft
  // re-syncs (Stage B PATCH) through the exact same naive→UTC path it came
  // from. Invariant I-2: 'scheduled' without a parseable instant → 'ready'.
  const isScheduled = asStatus(d.status) === 'scheduled';
  const localStamp =
    isScheduled && d.scheduled_at ? utcIsoToLocalNaive(asString(d.scheduled_at), orgTz) : null;
  return {
    id: asString(d.id),
    brandId: asString(d.brand_id),
    title: asString(d.title),
    topic: asString(d.topic),
    platform: asPlatform(d.platform),
    objective: asObjective(d.objective),
    language: asLanguage(d.language),
    audience: asString(d.audience),
    selectedHookType: asHookType(d.selected_hook_type),
    hooks: {
      patternInterrupt: asString(hooks.patternInterrupt),
      curiosityGap: asString(hooks.curiosityGap),
      directBenefit: asString(hooks.directBenefit),
    },
    caption: asString(d.caption),
    callToAction: asString(d.call_to_action),
    hashtags: asStringArray(d.hashtags),
    status: localStamp ? 'scheduled' : isScheduled ? 'ready' : asStatus(d.status),
    scheduledDate: localStamp ? `${localStamp.date}T${localStamp.time}:00` : undefined,
    createdAt: asString(d.created_at, new Date().toISOString()),
    updatedAt: asString(d.updated_at, new Date().toISOString()),
  };
}

/** Map a single DB calendar event row to the frontend CalendarEvent shape. */
function mapEvent(e: DbEvent): CalendarEvent | null {
  const tz = asString(e.timezone, 'UTC');
  if (!isValidTimezone(tz)) return null;
  const local = utcIsoToLocalNaive(asString(e.scheduled_at), tz);
  if (!local) return null;
  return {
    id: asString(e.id),
    draftId: e.draft_id ?? undefined,
    brandId: asString(e.brand_id),
    title: asString(e.title),
    platform: asPlatform(e.platform),
    date: local.date,
    time: local.time,
    status: 'scheduled',
    summary: asString(e.summary),
  };
}

/**
 * Pure: pull the list of workspaces (organizations) out of an export payload
 * for the workspace switcher. Unknown shapes are tolerated — anything that
 * does not look like an org is skipped rather than thrown.
 */
export function listOrgsFromExport(raw: unknown): OrgSummary[] {
  if (!raw || typeof raw !== 'object') return [];
  const workspaces = (raw as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(workspaces)) return [];
  const orgs: OrgSummary[] = [];
  for (const ws of workspaces) {
    if (!ws || typeof ws !== 'object') continue;
    const org = (ws as { organization?: unknown }).organization;
    if (!org || typeof org !== 'object') continue;
    const id = (org as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const tz = (org as { default_timezone?: unknown }).default_timezone;
    orgs.push({
      id,
      name: typeof (org as { name?: unknown }).name === 'string' ? (org as { name: string }).name : 'Workspace',
      defaultTimezone: typeof tz === 'string' ? tz : null,
    });
  }
  return orgs;
}

/**
 * Map the entire /api/workspace/export response to a HydratedWorkspace.
 * If `workspaces` is empty (newly-signed-up user with no org yet), returns
 * a null `organizationId` so the caller can decide whether to seed.
 *
 * Phase 3 multi-org: when `requestedOrgId` is given, the workspace whose
 * organization.id matches is hydrated (workspace switcher). No match →
 * falls back to the first workspace defensively (the orgs list comes from
 * the same payload, so a mismatch means the org vanished mid-switch — the
 * caller re-lists orgs after every export anyway).
 */
export function hydrateWorkspaceFromExport(raw: unknown, requestedOrgId?: string): HydratedWorkspace {
  if (!raw || typeof raw !== 'object') {
    throw new HydrateError('Export response is not an object.');
  }
  const r = raw as { workspaces?: unknown };
  if (!Array.isArray(r.workspaces)) {
    throw new HydrateError('Export response has no workspaces array.');
  }
  if (r.workspaces.length === 0) {
    return {
      brands: [],
      drafts: [],
      calendarEvents: [],
      settings: DEFAULT_SETTINGS,
      activeBrandId: null,
      organizationId: null,
      organizationName: null,
    };
  }
  const workspaceList = r.workspaces as DbWorkspaceExport['workspaces'];
  const ws =
    (requestedOrgId
      ? workspaceList.find(w => w?.organization?.id === requestedOrgId)
      : undefined) ?? workspaceList[0];
  const org = ws.organization ?? { id: '' };
  // Organization timezone drives ALL naive↔UTC conversions for this workspace
  // (draft scheduledDate + event date/time). Corrupt values fall back to UTC.
  const orgTzCandidate = asString(org.default_timezone);
  const orgTz = isValidTimezone(orgTzCandidate) ? orgTzCandidate : 'UTC';
  const brands = (ws.brands ?? []).map(mapBrand);
  const brandIdByDb = new Map(brands.map(b => [b.id, b.id]));
  const drafts = (ws.drafts ?? [])
    .filter(d => brandIdByDb.has(asString(d.brand_id)))
    .map(d => mapDraft(d, orgTz));
  const draftIdByDb = new Set(drafts.map(d => d.id));
  const calendarEvents: CalendarEvent[] = [];
  for (const e of ws.calendarEvents ?? []) {
    if (!brandIdByDb.has(asString(e.brand_id))) continue;
    const mapped = mapEvent(e);
    if (!mapped) continue;
    // Drop drafts references that don't exist (orphan event → standalone)
    if (mapped.draftId && !draftIdByDb.has(mapped.draftId)) {
      mapped.draftId = undefined;
    }
    calendarEvents.push(mapped);
  }
  const settingsRow: DbSettings = ws.settings ?? {};
  const uiPrefs = (settingsRow.ui_prefs ?? {}) as Record<string, unknown>;
  const settings: AppSettings = {
    workspaceName: asString(org.name, DEFAULT_SETTINGS.workspaceName),
    defaultBrandId: brands[0]?.id ?? DEFAULT_SETTINGS.defaultBrandId,
    defaultLanguage: DEFAULT_SETTINGS.defaultLanguage,
    timezone: asString(org.default_timezone, DEFAULT_SETTINGS.timezone),
    enableFluffHighlighting: DEFAULT_SETTINGS.enableFluffHighlighting,
    autoSaveDrafts:
      typeof settingsRow.auto_save_drafts === 'boolean'
        ? settingsRow.auto_save_drafts
        : DEFAULT_SETTINGS.autoSaveDrafts,
  };
  void uiPrefs;
  return {
    brands,
    drafts,
    calendarEvents,
    settings,
    activeBrandId: brands[0]?.id ?? null,
    organizationId: asString(org.id) || null,
    organizationName: asString(org.name) || null,
  };
}
