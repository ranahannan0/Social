/**
 * Import-mapper → real-schema verification (Phase 2, local Postgres harness).
 *
 * Proves that the output of mapWorkspaceImport() is insertable into the
 * ACTUAL migration schema under RLS, in correct dependency order, with
 * timezone conversion behaving exactly as designed. This is the local
 * stand-in for the supabase-js executor path (workspaceImportExec.ts),
 * which requires real Supabase credentials to run.
 *
 * Run by scripts/db/runLocal.mjs (phase 2) against a freshly migrated DB.
 * Usage: node --import tsx supabase/tests/importMapper.db.test.ts <conn>
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { mapWorkspaceImport } from '../../src/utils/workspaceImportMapper';
import type { WorkspaceExportFile } from '../../src/utils/workspaceFile';

const CONN = process.argv[2] || 'postgres:///omnip_test?host=/tmp&port=5433';

const results: Array<{ name: string; ok: boolean }> = [];
let failures = 0;

function record(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}: ${name}`);
}

async function connectAs(sub: string | null): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: CONN });
  await c.connect();
  if (sub) {
    await c.query(`SET ROLE authenticated`);
    await c.query(`SET request.jwt.claims = '${JSON.stringify({ sub })}'`);
  }
  return c;
}

async function main() {
  const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const admin = await connectAs(null);
  await admin.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, 'importer@example.test')`,
    [U]
  );
  const user = await connectAs(U);

  // ── Build a realistic workspace export (mirrors localStorage _v2 shapes) ──
  const exportFile: WorkspaceExportFile = {
    formatVersion: 1,
    exportedAt: '2026-11-08T09:00:00.000Z',
    source: 'localStorage',
    data: {
      brands: [
        {
          id: 'brand-01', name: 'Acme Labs', tagline: 'Better widgets', industry: 'SaaS',
          targetAudience: 'SMBs', website: undefined,
          brandVoice: { tone: 'pro', bannedWords: ['hype'], styleGuidelines: 'short', sampleCopy: 'demo' },
          preferredLanguage: 'English', productsAndServices: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      drafts: [
        {
          id: 'draft-101', brandId: 'brand-01', title: 'Launch post', topic: 'Launch',
          platform: 'linkedin', objective: 'Authority', language: 'English', audience: 'a',
          selectedHookType: 'patternInterrupt',
          hooks: { patternInterrupt: 'h1', curiosityGap: 'h2', directBenefit: 'h3' },
          caption: 'We are live.', callToAction: 'Try it', hashtags: ['launch'],
          status: 'ready',
          createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'draft-102', brandId: 'brand-01', title: 'Story teaser', topic: 'Story',
          platform: 'linkedin', objective: 'Engagement', language: 'English', audience: 'a',
          selectedHookType: 'curiosityGap',
          hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' },
          caption: 'Story coming.', callToAction: '', hashtags: [],
          status: 'scheduled', scheduledDate: '2026-03-13T00:30:00',
          complianceStatus: { passed: true, detectedFluff: [], charCount: 12, maxLimit: 3000, warnings: [] },
          createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      calendarEvents: [
        {
          id: 'event-01', draftId: 'draft-102', brandId: 'brand-01', title: 'Story teaser',
          platform: 'linkedin', date: '2026-03-13', time: '00:30', status: 'scheduled', summary: 's',
        },
        {
          id: 'event-02', draftId: 'ghost-draft', brandId: 'brand-01', title: 'Standalone',
          platform: 'x', date: '2026-03-14', time: '12:00', status: 'draft', summary: '',
        },
      ],
      settings: { workspaceName: 'Importer WS', timezone: 'Asia/Karachi', autoSaveDrafts: true },
      activeBrandId: 'brand-01',
    },
  };

  const mapped = mapWorkspaceImport(exportFile, {});
  assert.ok(mapped.ok, 'mapper must accept the fixture');
  if (!mapped.ok) process.exit(1);
  const ws = mapped.value;

  record('Mapper: 2 brands... 1 brand, 2 drafts, 2 events, 1 check mapped',
    ws.brands.length === 1 && ws.drafts.length === 2 && ws.events.length === 2 && ws.checks.length === 1);
  record('Standalone event: ghost draft link dropped',
    ws.events.find(e => e.legacyId === 'event-02')?.legacyDraftId === null);

  // ── Execute the SAME insert sequence the supabase-js executor performs ───
  const orgRes = await user.query<{ id: string }>(
    `SELECT create_organization($1,$2,$3) AS id`,
    [ws.workspaceName, `importer-ws-${Math.random().toString(36).slice(2, 8)}`, ws.timezone]
  );
  const orgId = orgRes.rows[0].id;
  record('create_organization RPC succeeds for the caller', !!orgId);

  const brandIds = new Map<string, string>();
  for (const b of ws.brands) {
    const r = await user.query<{ id: string }>(
      `INSERT INTO brands (org_id, name, tagline, industry, target_audience,
         brand_voice, preferred_language, products_services)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, b.name, b.tagline, b.industry, b.targetAudience,
       JSON.stringify(b.brandVoice), b.preferredLanguage, b.productsServices]
    );
    brandIds.set(b.legacyId, r.rows[0].id);
  }
  record('Mapped brands insert under RLS (created_by defaults to auth.uid())',
    brandIds.size === 1);

  const draftIds = new Map<string, string>();
  for (const d of ws.drafts) {
    const r = await user.query<{ id: string }>(
      `INSERT INTO content_drafts (org_id, brand_id, title, topic, platform, objective,
         language, audience, selected_hook_type, hooks, caption, call_to_action,
         hashtags, status, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [orgId, brandIds.get(d.legacyBrandId), d.title, d.topic, d.platform, d.objective,
       d.language, d.audience, d.selectedHookType, JSON.stringify(d.hooks), d.caption,
       d.callToAction, d.hashtags, d.status, d.scheduledAtUtc]
    );
    draftIds.set(d.legacyId, r.rows[0].id);
  }
  record('Mapped drafts insert under RLS incl. scheduled_at instants',
    draftIds.size === 2);

  for (const c of ws.checks) {
    await user.query(
      `INSERT INTO compliance_checks (org_id, draft_id, provider, passed,
         detected_fluff, char_count, max_limit, warnings, check_version)
       VALUES ($1,$2,'rule_local',$3,$4,$5,$6,$7,$8)`,
      [orgId, draftIds.get(c.legacyDraftId), c.passed, c.detectedFluff,
       c.charCount, c.maxLimit, JSON.stringify(c.warnings), c.checkVersion]
    );
  }
  const latest = await user.query(
    `SELECT latest_check_id FROM content_drafts WHERE id = $1`, [draftIds.get('draft-102')]);
  record('latest_check_id trigger fires for imported check', latest.rows[0].latest_check_id !== null);

  for (const e of ws.events) {
    await user.query(
      `INSERT INTO calendar_events (org_id, brand_id, draft_id, title, platform,
         scheduled_at, timezone, status, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, brandIds.get(e.legacyBrandId),
       e.legacyDraftId ? draftIds.get(e.legacyDraftId) ?? null : null,
       e.title, e.platform, e.scheduledAtUtc, e.timezone, e.status, e.summary]
    );
  }

  // ── Timezone correctness: naive 2026-03-13 00:30 Karachi → 19:30Z prev day ─
  const tz = await user.query(
    `SELECT scheduled_at FROM calendar_events
     WHERE org_id = $1 AND draft_id = $2`,
    [orgId, draftIds.get('draft-102')]
  );
  const got = new Date(tz.rows[0].scheduled_at).toISOString();
  record(`timestamptz round-trip: stored ${got}`, got === '2026-03-12T19:30:00.000Z');

  // ── I-2 invariant: the imported scheduled draft matches its event ─────────
  const draftRow = await user.query(
    `SELECT status, scheduled_at FROM content_drafts WHERE id = $1`,
    [draftIds.get('draft-102')]
  );
  record('Imported scheduled draft carries status=scheduled AND scheduled_at',
    draftRow.rows[0].status === 'scheduled' && draftRow.rows[0].scheduled_at !== null);

  // ── Cross-tenant: another user sees nothing from the imported org ─────────
  const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await admin.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'other@example.test')`, [U2]);
  const other = await connectAs(U2);
  const peek = await other.query(`SELECT count(*)::int AS n FROM brands WHERE org_id = $1`, [orgId]);
  record('Other user sees ZERO imported brands (RLS holds on imported data)',
    peek.rows[0].n === 0);

  await user.end(); await other.end(); await admin.end();

  console.log(`\nSummary: ${results.length - failures}/${results.length} import-mapper DB assertions passed.`);
  if (failures > 0) process.exit(1);
}

main().catch(e => { console.error('RUNNER ERROR:', e.message); process.exit(1); });
