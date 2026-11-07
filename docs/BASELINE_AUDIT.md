# OMNI CHANNEL PLUS — Technical Baseline Audit

**Audit date:** 2026-11-08
**Repository:** `ranahannan0/Social` (branch `main`)
**Audited commit:** `12428815902da28ecb3b5d0b0207a723ce175a4c` — `feat: implement cascade delete and update dashboard stats`
**Audit branch:** `dev/phase1-stabilization`
**Scope:** Static inspection only. No working files were modified as part of the audit itself. All findings below were verified against the audited commit, not against earlier review notes.

---

## 1. Current Architecture

| Layer | Implementation | Notes |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite 8 + Tailwind CSS 4 | SPA, six views (Dashboard, Brand Workspace, Content Studio, Library, Calendar, Settings) |
| Backend | Express 4.21 (`server.ts`) | Serves API + Vite middleware (dev) / static `dist` (prod). Single process. |
| AI | `@google/genai` v3, server-side only | `/api/generate` with JSON response schema; deterministic local fallback when key missing/unreachable; fallback always labelled (`isFallback: true`) |
| Persistence | Browser localStorage (5 keys, versioned `_v2`) | Brands, drafts, events, settings, active brand |
| Security | Helmet, express-rate-limit (MemoryStore), 64 KB JSON body cap, strict request validation, numeric TRUST_PROXY_HOPS | CSP relaxed in dev; strict in prod; AI Studio iframe handling |
| Auth / DB | None | Health endpoint honestly reports `supabaseReady: false`, `storageMode: localStorage_demo` |

**Assessment:** Coherent, appropriately scoped Phase 1 architecture. The server is stateless; all durable state lives in the browser. This is the documented Phase 1 constraint, not a defect, but every item in the Phase 2 dependency list flows from it.

## 2. Existing Modules (verified in code)

1. **Dashboard** (`DashboardView`) — stats via `calculateComplianceStats`, recent drafts, upcoming events, platform distribution.
2. **Brand Workspace** (`BrandWorkspaceView`) — CRUD brands, delete confirmation modal, active brand reassignment.
3. **Content Studio** (`ContentStudioView`) — Gemini generation with 3 hook variants, fluff highlighting, compliance check, auto-save toggle behavior, manual save, schedule modal.
4. **Content Library** (`ContentLibraryView`) — draft CRUD, delete confirmation (`window.confirm`), scheduling.
5. **Content Calendar** (`ContentCalendarView`) — month/week/day views, standalone event creation, event inspection/delete.
6. **Settings** (`SettingsView`) — workspace defaults, AI status probe, honest "NOT CONNECTED" Supabase/integration panels, reset-to-demo with confirmation.
7. **Server API** — `/api/health`, `/api/ai-status` (15 req/min, 60 s cache), `/api/generate` (10 req/min, strict validation, schema-constrained Gemini, labelled fallback).

## 3. Completed Functionality (verified, not just claimed)

- Helmet, rate limiting, body cap, server-side key handling, request validation — implemented as described in handover.
- Numeric trust-proxy hop resolution with strict rejection of `true` (`src/utils/proxy.ts`) — implemented, unit-testable, tested.
- Cascade brand deletion, active-brand reassignment, event→draft deletion sync, duplicate-free rescheduling for the single-event case — implemented in `src/utils/dataIntegrity.ts` as pure, testable functions.
- Neutral dashboard state for zero drafts — implemented at the view layer.
- Fallback generation is always labelled (`isFallback`, `fallbackReason`) — implemented.
- Auto-save distinction (Issue D) — **verified correct**: `settings.autoSaveDrafts` gates only `saveDraft()` after generation; localStorage persistence of brands/settings is unconditional. No change required.
- Settings honesty (Rule 5) — Supabase tab says `STATUS: NOT CONNECTED`, all integrations say `NOT CONNECTED · Phase 2`. Compliant.

## 4. Incomplete Functionality (acknowledged, planned)

Per master spec and handover: auth, database, publishing, CRM, video, analytics, orchestration, queues. All correctly absent and correctly labelled in UI. No fake features detected.

## 5. Critical Bugs (verified against audited commit)

### B-1 · Editorial-quality pass-rate uses wrong denominator — **P1**
`src/utils/dataIntegrity.ts` → `calculateComplianceStats()`:

```ts
const compliancePassRate = total > 0 ? Math.round((passedQuality / total) * 100) : null;
hasEvaluatedContent: total > 0,
```

- Denominator is **all** drafts instead of drafts with an actual evaluation result. Example: 3 drafts, 1 evaluated+passed → shows 33% instead of 100%.
- `hasEvaluatedContent` is `true` whenever any draft exists, even if none was ever evaluated. The dashboard then claims "Passed style & length checks (non-legal)" for unevaluated content. The existing unit test only covers the empty-library case, which passes even with this bug — a blind spot.
- Dashboard rendering (`DashboardView`) already handles `null` with an em-dash, so the fix is isolated to the calculation.

### B-2 · Calendar week/day views use UTC-shifted date keys — **P1**
`ContentCalendarView.tsx` lines 286, 346, 351, 354:

```ts
const dateStr = d.toISOString().split('T')[0];
```

`toISOString()` converts to UTC. For the configured audience timezone **Asia/Karachi (UTC+5)**, a local midnight–04:59 date becomes the *previous* day. Concrete failure: week view cell built from `new Date(2026, 10, 7)` (00:00 PKT) resolves to key `2026-11-06`, so events filed under `2026-11-07` do not render in that cell. Day view has the same shift. Events are silently displayed on the wrong day for any UTC+ timezone (and shifted forward for UTC−).

### B-3 · Hardcoded calendar reference and default dates — **P1**
- `ContentCalendarView.tsx:26` — `useState<Date>(new Date(2026, 10, 7))`: calendar opens frozen at Nov 2026 regardless of the actual date.
- `ContentCalendarView.tsx:36, 112` — new-event default date hardcoded to `2026-11-10` (and built with the same UTC-shift bug).
- `services/constants.ts` — all `INITIAL_CALENDAR_EVENTS` dates (`2026-11-10` … `2026-11-16`) and draft `scheduledDate`/`createdAt` values are static; demo data goes stale and the dashboard "upcoming" list fills with past dates.

### B-4 · ScheduleModal "tomorrow" default is UTC-shifted — **P2**
`ScheduleModal.tsx:22-24` — between 00:00 and 04:59 PKT the default publication date equals **today**, not tomorrow (`toISOString()` shift). Cosmetic-to-annoying; same root cause as B-2.

## 6. Security Weaknesses

| ID | Severity | Finding |
|---|---|---|
| S-1 | P2 | `/api/ai-status` triggers a real Gemini call per unique 60 s window per IP when a key is configured. Unauthenticated visitors can consume ~1,440 probes/day of paid quota. Acceptable for Phase 1 single-user; must require auth in Phase 2. |
| S-2 | P3 | Production CSP allows `scriptSrc 'unsafe-inline'`. Vite builds emit external scripts; this directive can likely be dropped after build verification. Hardening, not exposure. |
| S-3 | P3 | Rate-limit MemoryStore is per-instance (already documented in code). Correct call: defer Redis to Phase 2/10 as planned. |
| S-4 | P3 | No security automation in CI (no `npm audit` step). Cheap to add later. |

No P0 security issues found: no key exposure client-side, no blind proxy trust, no injection surface (validation + parameterized schema), destructive ops confirmed by UI.

## 7. Data Integrity Risks

| ID | Severity | Finding |
|---|---|---|
| D-1 | P2 | `syncScheduleDraft` updates only the **first** event matching a `draftId` (`findIndex`). If legacy data or future code paths leave two events for one draft, rescheduling silently leaves duplicates in place. |
| D-2 | P2 | `syncDeleteCalendarEvent` resets the linked draft to `ready` even when a *second* scheduled event for the same draft remains — draft and calendar then disagree. |
| D-3 | P2 | `AppContext.updateCalendarEvent` copies the single event's status onto the draft with the same multi-event caveat. |
| D-4 | P3 | Seed inconsistency: `draft-101` is `ready` with no `scheduledDate`, but `event-02` links it as `scheduled`. Demo data contradicts the invariants the code enforces. |
| D-5 | P3 | Entity IDs use `Date.now()` (`draft-`, `event-`, `brand-`); two creations in the same millisecond collide. Low probability, trivial to harden. |
| D-6 | P3 | Dashboard "Upcoming Calendar" shows `calendarEvents.slice(0, 3)` — unsorted, unfiltered; past events can appear as "upcoming" (compounded by B-3 static seeds). |

## 8. Database Readiness

- No database layer exists. Data shapes (`BrandProfile`, `ContentDraft`, `CalendarEvent`) are clean, JSON-serializable, and map naturally to future tables.
- `scheduledDate` is a **local naive** string (`YYYY-MM-DDTHH:mm:00`) and events store `date` + `time` separately with no zone — correct for Phase 1 local-time semantics, must become `timestamptz` (or date + time + zone columns) at Phase 2 migration. Date-only values are already kept separate from full timestamps where it matters (`CalendarEvent.date` vs `ContentDraft.scheduledDate`).
- localStorage keys are versioned (`_v2`), which gives a clean seam for an export/migration path. A localStorage backup/export utility is **required before** any Phase 2 cutover (handover requirement; not yet built — planned, not forgotten).

## 9. Testing Readiness

- Single integration file `tests/security.test.ts` requires a **manually started** server at `localhost:3000`; `npm test` fails unhelpfully otherwise (`process.exit(1)` on connect error).
- Rate-limit tests are order- and window-dependent (they rely on earlier tests having consumed 8 of 10 generation slots within one minute). Deterministic on a freshly spawned server, fragile against a long-running one.
- With `GEMINI_API_KEY` present in the environment, the fallback-schema test can hit the paid API. Cost-control rule violation risk.
- Zero coverage for: evaluated-draft denominator (B-1), UTC-shifted keys (B-2), multi-event consolidation (D-1/D-2), upcoming-event selection (D-6), date helpers.
- No test framework, no split between fast pure-unit tests and server integration tests.

## 10. Scalability Limitations (acknowledged, deferred by design)

MemoryStore rate limits, single process, no DB, no queues, no CDN consideration, localStorage caps (~5 MB). All are correct Phase 1 trade-offs and already documented in code comments; each has a named Phase 2+ owner technology (Supabase, Redis/BullMQ, R2). Nothing in the current code obstructs those migrations.

---

## 11. Verification of Handover Items A–E

| Item | Verdict | Evidence |
|---|---|---|
| A. Calendar date handling | **Still broken** | B-2, B-3, B-4 above |
| B. Editorial-quality statistics | **Still broken** | B-1 above |
| C. Rescheduling integrity | **Partially fixed** | Single-event path correct; multi-event edges remain (D-1, D-2, D-3) |
| D. Auto-save behaviour | **Correct — no change needed** | `autoSaveDrafts` gates only library persistence; settings persistence unconditional |
| E. Automated testing | **Still unreliable** | Section 9 above |

## 12. Remediation Plan (executed on `dev/phase1-stabilization`)

1. New pure helper module `src/utils/dateUtils.ts` — `toLocalDateKey`, `addDays`, `toLocalDateTimeStamp`, `formatEventStamp`. No `toISOString()` for date-only keys anywhere.
2. Calendar views + ScheduleModal use actual current date; default event date = tomorrow (local); dynamic seed data via factory functions in `constants.ts`; seed inconsistency D-4 fixed.
3. `calculateComplianceStats` — denominator = evaluated drafts; `hasEvaluatedContent = evaluatedCount > 0`; dashboard neutral label updated ("No evaluated drafts yet").
4. `syncScheduleDraft` — consolidates **all** events of a draft into exactly one (idempotent dedupe). `syncDeleteCalendarEvent` / `updateCalendarEvent` — draft state recomputed from **remaining** events via new `recomputeDraftScheduleState` helper.
5. `selectUpcomingEvents(events, now, limit)` — filtered + sorted; used by Dashboard.
6. ID generation hardened with random suffix.
7. Tests: `tests/unit/*.test.ts` (node:test, no server, no network, no API cost) + `tests/security.test.ts` (integration, auto-spawned isolated server on a dedicated port with `GEMINI_API_KEY` stripped from the child environment). `npm test` = unit + integration; `npm run test:unit` runs standalone.
8. Honest footer: static "Gemini 3.8 Flash SDK" text replaced by config-independent "Server-side Gemini SDK" (Rule 5: the configured model is env-dependent; the footer must not claim a specific model).

## 13. Phase 1 Exit Criteria Status

| Criterion | Status |
|---|---|
| No hardcoded calendar dates; local date-only helper used | Fixed in this branch |
| Pass rate over evaluated drafts only; neutral empty state | Fixed in this branch |
| Duplicate-free rescheduling incl. legacy multi-event data | Fixed in this branch |
| Auto-save distinction | Already correct (verified) |
| Test suite runs via `npm test` with no manual server start, no paid API calls | Fixed in this branch |
| TypeScript check + production build pass | Run after fixes; exact results in commit `docs/` and chat report |
| Multi-event/denominator regressions covered by unit tests | Added in this branch |

## 14. Recommendation

Phase 1 exit is achievable in this branch. **Phase 2 (Supabase database + auth) is the correct next phase** once the Phase 1 verification checklist below passes. The first Phase 2 deliverable presented for review must be the multi-tenant schema (profiles / organizations / organization_members / brands / drafts / calendar_events / compliance_checks …) with RLS policies and the localStorage export/migration plan — design before SQL, per the master development order.

---

## 15. Post-Audit Update (2026-11-08, commit 2ecc9b4)

- Phase 1 remediation was executed on this branch (commits 90fddec, d5e0913, eee21bc) and **verified**: `tsc --noEmit` clean, production build OK, 25/25 unit + 20/20 integration tests pass (isolated server, `GEMINI_API_KEY` stripped — no paid API calls).
- Upstream independently pushed commit `a8c68ed` fixing overlapping issues (B-1, D-1, partial B-2). It was **merged** (2ecc9b4) keeping the superset implementation; upstream's two regression tests (8f-2, 8h) were retained and now pass. Upstream-only items that remain addressed solely by this branch: B-2 week/day cell keys, B-3 dynamic seeds, B-4 ScheduleModal default, D-2, D-3, D-5, D-6.
- Phase 1 exit criteria: **all met**. Phase 2 schema design proposal published at `docs/PHASE2_SCHEMA_DESIGN.md` (design before SQL).
