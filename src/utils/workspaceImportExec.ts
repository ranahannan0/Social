/**
 * Workspace import executor (Phase 2 — design doc §8 step 2).
 *
 * Runs the mapped workspace through Supabase via a USER-SCOPED client
 * (anon key + user JWT), so Row Level Security is exercised end to end:
 * - org creation goes through the create_organization() RPC (creator
 *   becomes owner atomically),
 * - every insert satisfies created_by = auth.uid() policies,
 * - any cross-check failure surfaces as a real RLS/constraint error.
 *
 * IDEMPOTENCY: the org's settings.ui_prefs.importedFromLocal records the
 * exportedAt stamp of the last completed import. Re-importing the SAME
 * file is a no-op (created counts = 0). Different exports create new rows
 * (the user asked for it); the report always shows what happened.
 *
 * SERVER-ONLY: imports @supabase/supabase-js. Never import from client code.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MappedWorkspace } from './workspaceImportMapper';

export interface ImportReport {
  orgId: string | null;
  imported: boolean; // false = already imported (idempotent skip)
  created: { brands: number; drafts: number; events: number; checks: number };
  skipped: { brands: number; drafts: number; events: number; checks: number };
  notes: string[];
  errors: string[];
}

export class ImportExecutionError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'workspace'}-${suffix}`;
}

/**
 * Executes the import as the authenticated user.
 * NOTE: verified against the real schema only via the local Postgres harness
 * (raw-SQL equivalent in supabase/tests/importMapper.db.test.ts). The
 * supabase-js path itself runs only when Supabase credentials exist.
 */
export async function executeWorkspaceImport(
  scoped: SupabaseClient,
  mapped: MappedWorkspace,
  exportedAt: string
): Promise<ImportReport> {
  const report: ImportReport = {
    orgId: null,
    imported: false,
    created: { brands: 0, drafts: 0, events: 0, checks: 0 },
    skipped: { ...mapped.warnings.skipped },
    notes: [...mapped.warnings.notes],
    errors: [],
  };

  // ── 1. Org: get-or-create (one org per user per design doc §12 decision 1)
  //
  // The create_organization RPC inserts a NEW org on every call. Without this
  // pre-check, a user who clicks "Sync to Cloud" twice would end up with two
  // duplicate orgs — and the frontend's hydrator (which only reads
  // workspaces[0]) would show stale data from the first org while the user's
  // latest sync sat unread in the second. Reuse the existing org when one
  // exists; only call create_organization on first import.
  let orgId: string | null = null;
  {
    const { data: existingOrgs, error: listErr } = await scoped
      .from('organizations')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1);
    if (listErr) {
      throw new ImportExecutionError(`Organization lookup failed: ${listErr.message}`);
    }
    if (existingOrgs && existingOrgs.length > 0) {
      orgId = (existingOrgs[0] as { id: string }).id;
      report.notes.push('Reused existing organization for this user.');
    } else {
      const { data: newOrgId, error: orgErr } = await scoped.rpc('create_organization', {
        p_name: mapped.workspaceName.slice(0, 120),
        p_slug: slugify(mapped.workspaceName),
        p_timezone: mapped.timezone,
      });
      if (orgErr || !newOrgId) {
        throw new ImportExecutionError(`Organization creation failed: ${orgErr?.message ?? 'no id'}`);
      }
      orgId = newOrgId as string;
    }
  }
  report.orgId = orgId;

  // ── 2. Idempotency marker: has THIS export already been imported? ────────
  const { data: settingsRow } = await scoped
    .from('organization_settings')
    .select('ui_prefs')
    .eq('org_id', orgId)
    .single();
  const prefs = ((settingsRow?.ui_prefs ?? {}) as Record<string, unknown>);
  if (prefs.importedFromLocal === exportedAt) {
    report.notes.push('This export was already imported into this organization — nothing created.');
    return report;
  }

  // ── 3. Brands ────────────────────────────────────────────────────────────
  const brandIdByLegacy = new Map<string, string>();
  for (const b of mapped.brands) {
    const { data, error } = await scoped
      .from('brands')
      .insert({
        org_id: orgId,
        name: b.name,
        tagline: b.tagline,
        industry: b.industry,
        target_audience: b.targetAudience,
        brand_voice: b.brandVoice,
        preferred_language: b.preferredLanguage,
        products_services: b.productsServices,
      })
      .select('id')
      .single();
    if (error || !data) {
      report.errors.push(`brand "${b.name}": ${error?.message ?? 'no id returned'}`);
      continue;
    }
    brandIdByLegacy.set(b.legacyId, (data as { id: string }).id);
    report.created.brands++;
  }

  // ── 4. Drafts (+ scheduled_at instants) ──────────────────────────────────
  const draftIdByLegacy = new Map<string, string>();
  for (const d of mapped.drafts) {
    const brandId = brandIdByLegacy.get(d.legacyBrandId);
    if (!brandId) {
      report.errors.push(`draft "${d.title}": brand row missing at insert time`);
      continue;
    }
    const { data, error } = await scoped
      .from('content_drafts')
      .insert({
        org_id: orgId,
        brand_id: brandId,
        title: d.title,
        topic: d.topic,
        platform: d.platform,
        objective: d.objective,
        language: d.language,
        audience: d.audience,
        selected_hook_type: d.selectedHookType,
        hooks: d.hooks,
        caption: d.caption,
        call_to_action: d.callToAction,
        hashtags: d.hashtags,
        status: d.status,
        scheduled_at: d.scheduledAtUtc,
      })
      .select('id')
      .single();
    if (error || !data) {
      report.errors.push(`draft "${d.title}": ${error?.message ?? 'no id returned'}`);
      continue;
    }
    draftIdByLegacy.set(d.legacyId, (data as { id: string }).id);
    report.created.drafts++;
  }

  // ── 5. Compliance checks (append-only; trigger maintains latest_check_id) ─
  for (const c of mapped.checks) {
    const draftId = draftIdByLegacy.get(c.legacyDraftId);
    if (!draftId) continue; // draft failed to insert; counted in errors above
    const { error } = await scoped.from('compliance_checks').insert({
      org_id: orgId,
      draft_id: draftId,
      provider: 'rule_local',
      passed: c.passed,
      detected_fluff: c.detectedFluff,
      char_count: c.charCount,
      max_limit: c.maxLimit,
      warnings: c.warnings,
      check_version: c.checkVersion,
    });
    if (error) {
      report.errors.push(`check for draft "${c.legacyDraftId}": ${error.message}`);
      continue;
    }
    report.created.checks++;
  }

  // ── 6. Calendar events ───────────────────────────────────────────────────
  for (const e of mapped.events) {
    const brandId = brandIdByLegacy.get(e.legacyBrandId);
    if (!brandId) {
      report.errors.push(`event "${e.title}": brand row missing at insert time`);
      continue;
    }
    const draftId = e.legacyDraftId ? draftIdByLegacy.get(e.legacyDraftId) ?? null : null;
    const { error } = await scoped.from('calendar_events').insert({
      org_id: orgId,
      brand_id: brandId,
      draft_id: draftId,
      title: e.title,
      platform: e.platform,
      scheduled_at: e.scheduledAtUtc,
      timezone: e.timezone,
      status: e.status,
      summary: e.summary,
    });
    if (error) {
      report.errors.push(`event "${e.title}": ${error.message}`);
      continue;
    }
    report.created.events++;
  }

  // ── 7. Stamp idempotency marker + persist auto-save preference ───────────
  const { error: prefErr } = await scoped
    .from('organization_settings')
    .update({
      auto_save_drafts: mapped.autoSaveDrafts,
      ui_prefs: { ...prefs, importedFromLocal: exportedAt },
    })
    .eq('org_id', orgId);
  if (prefErr) {
    report.errors.push(`settings update: ${prefErr.message}`);
  }

  report.imported = true;
  return report;
}
