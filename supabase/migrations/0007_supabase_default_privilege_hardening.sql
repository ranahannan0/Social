-- 0007: Supabase default-privilege hardening (discovered during REAL cutover).
--
-- On real Supabase, ALTER DEFAULT PRIVILEGES (roles postgres + supabase_admin)
-- grant ALL (incl. TRUNCATE) on every new public-schema table to
-- anon/authenticated/service_role the moment the table is created. The local
-- verification shim has no such mechanism, so this gap only surfaced when the
-- migrations were applied to the live project (2026-11-08, runner verification
-- caught it: role_table_grants still showed anon holding UPDATE/DELETE on
-- compliance_checks and INSERT/UPDATE/DELETE on generation_jobs).
--
-- Why it matters even under ENABLE+FORCE RLS:
-- - RLS never applies to TRUNCATE — it is a table-level operation that
--   bypasses row security entirely. No API role has any use for it.
-- - Append-only semantics (design doc §6) require a HARD denial (permission
--   denied) rather than a silent zero-row filter, for every API role.
--
-- service_role intentionally keeps full rights (server-side writes only).

-- Append-only audit tables: no mutation path for API roles.
REVOKE UPDATE, DELETE, TRUNCATE ON public.compliance_checks FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.generation_jobs FROM anon, authenticated;

-- TRUNCATE is not part of the app vocabulary anywhere: strip it from both API
-- roles on every tenant table (RLS does not protect against TRUNCATE).
REVOKE TRUNCATE ON public.organizations, public.organization_members,
  public.organization_settings, public.brands, public.content_drafts,
  public.calendar_events
  FROM anon, authenticated;
