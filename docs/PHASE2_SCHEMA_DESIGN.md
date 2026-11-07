# OMNI CHANNEL PLUS — Phase 2 Database & Multi-Tenancy Design Proposal

**Status:** DESIGN PROPOSAL — awaiting review. No SQL has been applied anywhere.
**Branch context:** `dev/phase1-stabilization` @ `2ecc9b4` (Phase 1 verified; upstream `a8c68ed` reconciled).
**Governing rule:** design before SQL (master development order). Actual migration files are written only after this document is approved or amended.

---

## 1. Scope of Phase 2 (and what it is NOT)

**In scope**
- Supabase PostgreSQL as the system of record, replacing localStorage as durable storage.
- Multi-tenant data model: users → organizations → brands (single-level org nesting only).
- Row Level Security on every tenant table, plus server-side authorization as the primary gate (RLS is defense in depth, never the only check).
- Versioned, forward-only SQL migrations under version control.
- localStorage backup/export path **before** any cutover (handover requirement).
- Auth-gated server APIs (this also closes audit finding S-1: unauthenticated paid-quota consumption via `/api/ai-status`).

**Explicitly NOT in scope (later phases)**
- Social platform publishing (P4), CRM/competitor data (P5), video assets (P6), orchestration (P8), analytics warehouse (P9), Redis/BullMQ (P10).
- Direct browser→Supabase access. In Phase 2 the Express server is the ONLY database client (holds the service-role key server-side; user requests carry a Supabase JWT which the server verifies). This is the simplest secure posture and avoids shipping any Supabase material to the frontend.

---

## 2. Tenancy Model

```
auth.users (Supabase-managed)
   │ 1:1
   ▼
profiles ──< organization_members >── organizations
                                          │ 1:N
                                          ▼
                                       brands ──< content_drafts
                                          │            │ 1:N (0..1 scheduled)
                                          ▼            ▼
                                   calendar_events   compliance_checks
                                          ▲              │
                                          └── draft_id ──┘
generation_jobs (audit/quota trail)  organization_settings (1:1)
```

- Every business table carries a denormalized `org_id` NOT NULL. This is deliberate: RLS predicates become a single-indexed lookup, and it makes "which rows can this user see?" trivially auditable.
- All primary keys are `uuid` with `gen_random_uuid()` defaults (PG13+ native; no extension needed).
- Every table gets `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz NOT NULL DEFAULT now()`, maintained by a shared `touch_updated_at()` trigger.
- Member roles: `owner` (manage org, billing seat, delete org), `admin` (manage members, delete brands/drafts/events), `editor` (create/edit drafts, brands, events), `viewer` (read-only). Phase 1 has one user; the role matrix is enforced from day one so later features cannot bypass it.

## 3. Enumerated Types

| Type | Values | Notes |
|---|---|---|
| `org_role` | owner, admin, editor, viewer | ordering enforced via `enum_role_rank()` helper in RLS |
| `draft_status` | ready, scheduled, published, archived | Phase 1 uses ready/scheduled; published/archived reserved (P4) — columns accept them only after P4 writes them |
| `event_status` | draft, scheduled, published, cancelled | matches Phase 1 UI statuses; published reserved |
| `platform_type` | linkedin, x, instagram_reels, instagram_feed, youtube, tiktok, pinterest, whatsapp, email, blog_seo | exact parity with `PlatformType` in `src/types` |
| `check_provider` | rule_local, gemini | which engine produced a compliance check |

## 4. Table Designs

### 4.1 `profiles` — mirrors `auth.users`, adds display data
```sql
id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
display_name  text NOT NULL DEFAULT '',
avatar_url    text,
created_at / updated_at
```
Auto-provisioned by a `SECURITY DEFINER` trigger on `auth.users` insert (Supabase standard pattern). No org data here — membership lives in `organization_members`.

### 4.2 `organizations`
```sql
id            uuid PK,
name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
default_timezone text NOT NULL DEFAULT 'Asia/Karachi',  -- naive→timestamptz conversion source
created_by    uuid NOT NULL REFERENCES profiles(id),
created_at / updated_at
```
`default_timezone` is the answer to the audit's Phase 2 warning about local-naive dates: the SERVER converts every user-submitted date/time to `timestamptz` using this zone.

### 4.3 `organization_members`
```sql
org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
user_id  uuid NOT NULL REFERENCES profiles(id)     ON DELETE CASCADE,
role     org_role NOT NULL DEFAULT 'viewer',
invited_by uuid REFERENCES profiles(id),
invited_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY (org_id, user_id)
```
On org creation, creator row is inserted with role `owner` in the same transaction.

### 4.4 `brands` (maps 1:1 to `BrandProfile`)
```sql
id                  uuid PK,
org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
name                text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
tagline             text NOT NULL DEFAULT '',
industry            text NOT NULL DEFAULT '',
target_audience     text NOT NULL DEFAULT '',
brand_voice         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {tone, banned_words[], style_guidelines, sample_copy}
preferred_language  text NOT NULL DEFAULT 'English',
products_services   text[] NOT NULL DEFAULT '{}',
created_by          uuid NOT NULL REFERENCES profiles(id),
created_at / updated_at
```
`brand_voice` stays JSONB in Phase 2 (shape still evolving); normalization to child tables is deferred until the shape stabilizes. CHECK constraints mirror the server-side 64 KB / length validation for a second layer.

### 4.5 `content_drafts` (maps to `ContentDraft`)
```sql
id                 uuid PK,
org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
title              text NOT NULL,
topic              text NOT NULL,
platform           platform_type NOT NULL,
objective          text NOT NULL DEFAULT '',
language           text NOT NULL DEFAULT 'English',
audience           text NOT NULL DEFAULT '',
selected_hook_type text NOT NULL DEFAULT 'patternInterrupt',
hooks              jsonb NOT NULL DEFAULT '{}',   -- {patternInterrupt, curiosityGap, directBenefit}
caption            text NOT NULL DEFAULT '',
call_to_action     text NOT NULL DEFAULT '',
hashtags           text[] NOT NULL DEFAULT '{}',
status             draft_status NOT NULL DEFAULT 'ready',
scheduled_at       timestamptz,          -- NULL unless status='scheduled' (see invariant I-2)
latest_check_id    uuid,                 -- FK added after compliance_checks exists (4.7)
created_by         uuid NOT NULL REFERENCES profiles(id),
created_at / updated_at
CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)
```
Indexes: `(org_id, brand_id)`, `(org_id, status)`, `(org_id, scheduled_at)` where scheduled_at is not null.

### 4.6 `calendar_events` (maps to `CalendarEvent` — the timezone fix lands here)
```sql
id            uuid PK,
org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
draft_id      uuid REFERENCES content_drafts(id) ON DELETE CASCADE,  -- NULL = standalone event
title         text NOT NULL,
platform      platform_type NOT NULL,
scheduled_at  timestamptz NOT NULL,          -- authoritative instant
timezone      text NOT NULL,                 -- zone used at creation (org default at that time)
status        event_status NOT NULL DEFAULT 'scheduled',
summary       text NOT NULL DEFAULT '',
created_by    uuid NOT NULL REFERENCES profiles(id),
created_at / updated_at
```
- `scheduled_at` replaces the Phase 1 local-naive pair (`date`, `time`). The server converts `{date, time, org.default_timezone}` → UTC instant on write and converts back to the org zone for display. **This is where audit B-2/B-4 are retired permanently** — no client-side key math against UTC anymore.
- Month/week/day grid grouping is computed server-side per org timezone (a materialized `event_local_date date GENERATED` column is NOT used because tz conversion is not immutable; the API returns pre-grouped keys instead).

### 4.7 `compliance_checks` (NEW — replaces the mutable `complianceStatus` blob on drafts)
```sql
id             uuid PK,
org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
draft_id       uuid NOT NULL REFERENCES content_drafts(id) ON DELETE CASCADE,
provider       check_provider NOT NULL,
passed         boolean NOT NULL,
detected_fluff text[] NOT NULL DEFAULT '{}',
char_count     integer NOT NULL,
max_limit      integer NOT NULL,
warnings       jsonb NOT NULL DEFAULT '[]',
check_version  text NOT NULL DEFAULT 'v1',   -- rule-set version, so historical results stay interpretable
created_at                      -- append-only; no updated_at by design
```
- Append-only history; a draft's displayed verdict = latest row (kept denormalized in `content_drafts.latest_check_id`, maintained in the same transaction).
- Audit B-1 semantics survive verbatim: the dashboard "evaluated drafts" denominator = `COUNT(DISTINCT draft_id)` in this table. Never labels itself legal/regulatory compliance.

### 4.8 `generation_jobs` (NEW — audit trail; closes S-1 properly)
```sql
id              uuid PK,
org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
user_id         uuid NOT NULL REFERENCES profiles(id),
draft_id        uuid REFERENCES content_drafts(id) ON DELETE SET NULL,
provider        text NOT NULL,               -- 'gemini' | 'fallback_local'
model           text NOT NULL DEFAULT '',
topic           text NOT NULL DEFAULT '',
is_fallback     boolean NOT NULL DEFAULT false,
fallback_reason text,
latency_ms      integer,
created_at
```
Enables per-org quota accounting ("N generations/min/org") replacing the current per-IP MemoryStore counters for authenticated routes, and gives honest cost visibility. IP-based limits remain as the outer unauthenticated shell.

### 4.9 `organization_settings` (1:1 with org)
```sql
org_id           uuid PK REFERENCES organizations(id) ON DELETE CASCADE,
auto_save_drafts boolean NOT NULL DEFAULT true,
ui_prefs         jsonb NOT NULL DEFAULT '{}',
updated_at
```
Preserves the audited auto-save semantics (audit item D): this flag gates library persistence only, never durability of settings themselves.

## 5. Invariants → Database Constraints (audit traceability)

| Audit item | Phase 1 fix (code) | Phase 2 enforcement (DB) |
|---|---|---|
| D-1 duplicate events per draft | `syncScheduleDraft` purge | **Partial unique index:** `CREATE UNIQUE INDEX one_scheduled_event_per_draft ON calendar_events(org_id, draft_id) WHERE draft_id IS NOT NULL AND status IN ('scheduled','published');` |
| D-2 delete-event ↔ draft state | `recomputeDraftScheduleState` | Draft status recompute stays in server transaction; DB CHECK I-2 below prevents the impossible state |
| D-3 event update ↔ draft state | same helper | same as above |
| I-2 draft scheduled ⇒ timestamp | CHECK in 4.5 | `CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)` plus `CHECK (status = 'scheduled' OR scheduled_at IS NULL)` |
| D-4 seed inconsistency | dynamic seeds | impossible by construction: scheduled events must carry draft link rules via FK + I-2 |
| D-5 ID collisions | random suffix | `gen_random_uuid()` — structural |
| D-6 "upcoming" unsorted | `selectUpcomingEvents` | `scheduled_at` index; ordering done in SQL `ORDER BY scheduled_at ASC` |

Code-level helpers remain (defense in depth); the DB is now the final arbiter.

## 6. Row Level Security

**Helper** (SECURITY DEFINER, STABLE, search_path pinned):
```sql
CREATE FUNCTION app_role_at_org(_org uuid) RETURNS org_role ...  -- membership lookup
CREATE FUNCTION can_read(_org uuid)   RETURNS boolean ...        -- role >= viewer
CREATE FUNCTION can_write(_org uuid)  RETURNS boolean ...        -- role >= editor
CREATE FUNCTION can_admin(_org uuid)  RETURNS boolean ...        -- role >= admin
```

**Policy matrix** (RLS ENABLED + FORCE on every tenant table):

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| organizations | member | — (created via RPC) | owner/admin | owner |
| organization_members | member of that org | owner/admin | owner/admin (cannot demote last owner: trigger) | owner/admin (last-owner guard) |
| brands | can_read | can_write | can_write | can_admin |
| content_drafts | can_read | can_write | can_write | can_admin |
| calendar_events | can_read | can_write | can_write | can_admin |
| compliance_checks | can_read | can_write (server only in practice) | — (append-only; no UPDATE policy = denied) | can_admin |
| generation_jobs | can_admin (privacy) | — (server writes via service role) | — | owner |
| organization_settings | can_read | can_write | can_write | — |

Notes:
- `auth.uid()` is used inside policies; since Phase 2 traffic flows through the server with the user's JWT, policies bind correctly. Service-role key bypasses RLS **only** for trigger/RPC internals and the signup provisioning path.
- Because RLS is FORCEd and the anon key is never used client-side, a leaked anon key yields an empty dataset even in the worst case.

## 7. Migration Plan (versioned, forward-only)

Supabase CLI migration layout in repo (`supabase/migrations/`), applied in order, never rewritten after merge to main:

```
0001_extensions_and_enums.sql       -- enums, helper functions
0002_core_tenancy.sql               -- profiles trigger, organizations, organization_members
0003_brands_drafts.sql              -- brands, content_drafts (+ CHECKs, indexes)
0004_events_checks_jobs_settings.sql-- calendar_events, compliance_checks, generation_jobs, organization_settings, latest_check_id FK
0005_rls_policies.sql               -- helpers + policies + FORCE RLS, last-owner triggers
0006_seed_demo_org.sql              -- optional: demo org/brand/drafts for the existing single-user experience (idempotent)
```

Rules: each migration runs in one transaction (except any CREATE INDEX CONCURRENT, explicitly flagged); rollback = new forward migration, never editing applied files; `schema_migrations` bookkeeping via Supabase CLI.

## 8. localStorage → Database Migration (pre-cutover requirement)

Ordered so that no user data can be lost at any step:

1. **Export first (Phase 1.5, lands BEFORE any DB code):** Settings → "Data & Backup" panel. `exportWorkspaceJson()` bundles all five versioned `_v2` localStorage keys into one downloadable file: `{ formatVersion: 1, exportedAt, brands, drafts, calendarEvents, settings, activeBrandId }`. Also `POST /api/workspace/export` returning the same payload server-side for automation.
2. **Import mapper (server):** `POST /api/workspace/import` accepts the export file, validates against the Phase 1 shapes, creates the caller's org + members row, maps entities in dependency order (org → brands → drafts → events → compliance checks), converts local-naive dates using the org timezone, dedupes by natural keys, and returns a per-entity report `{created, skipped, conflicts}`. Import is **idempotent** (re-running an import creates nothing new).
3. **Cutover flag:** `STORAGE_MODE=supabase|local` env, health endpoint reports the truth (`storageMode`) exactly as it already honestly does today. Default remains `local` until tests pass.
4. **Post-cutover:** localStorage keys become a read-only cache for one release, then a later version bump (`_v3` namespace reserved) retires them.

## 9. Server Authorization Layer (beyond RLS)

Every Express route gains: JWT verification (`Authorization: Bearer <supabase jwt>` → `auth.getUser`), org-membership assertion from the token's claims + DB lookup, org-scoped request validation, and per-org rate quotas backed by `generation_jobs`. RLS is the safety net behind this — never the only line (handover requirement: server-side authorization, not just frontend/DB).

## 10. Cross-Tenant Isolation Test Plan (acceptance gate)

Automated (integration, isolated servers, no paid API — same harness discipline as Phase 1):
1. Create org A (user U-A) and org B (user U-B) via the real API paths.
2. U-A creates brand/draft/event. Assert U-B: sees zero A rows on every list endpoint; direct GET of A's ids → 404 (not 403, to avoid id probing); PATCH/DELETE of A's ids → 404; POST with `org_id = A` → 403/404.
3. U-B attempts RLS-level access via the server's user-scoped client: zero rows from every tenant table.
4. Last-owner guard: sole owner cannot be demoted/removed.
5. Import idempotency: import same export file twice → second run creates 0 rows.
6. Naive-date conversion: event created for `2026-03-13 00:30` Asia/Karachi round-trips to the same wall clock in listing output.

## 11. Environment Variables (Phase 2 delta)

| Var | Where | Notes |
|---|---|---|
| `SUPABASE_URL` | server only | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | server only, **never** in git/frontend | bypasses RLS; used for provisioning/RPC only |
| `SUPABASE_ANON_KEY` | server only | used with user JWT for user-scoped checks |
| `STORAGE_MODE` | server | `local` (default) / `supabase` |
| `SUPABASE_MIGRATION_*` | CI/CLI only | never application runtime |

`.env.example` updated; `.gitignore` already excludes `.env`; keys are injected at deploy time. (Project creation + keys = external credential decision — will be requested from you when we reach implementation, not before.)

## 12. Open Design Decisions for Your Review

1. **Org per user on signup, auto-created** (recommended: zero-friction, matches single-user today) vs. invite-only orgs.
2. **`brand_voice` as JSONB now, normalize later** (recommended) vs. normalized columns immediately.
3. **Compliance history append-only** (recommended) vs. overwrite-latest-only.
4. **Server-only DB access** (recommended for Phase 2) vs. direct client Supabase access with RLS-only protection.
5. **Demo-org seed migration** — wanted, or start every org empty with import as the data path? (Recommended: seed, so the existing demo experience survives.)

Approval (or amendments) of this document unlocks: `0001`–`0006` migration SQL, RLS policy implementation, the isolation test suite, and the Phase 1.5 export UI — in that order.
