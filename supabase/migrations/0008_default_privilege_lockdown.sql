-- 0008: Lock down Supabase default-privilege exposure (follow-up to 0007).
--
-- Discovery from the live cutover: Supabase's ALTER DEFAULT PRIVILEGES grant
-- ALL (incl. TRUNCATE, which RLS never applies to) on every NEW public-schema
-- table to anon/authenticated. Per-migration REVOKEs (0005/0007) cover the
-- tables those migrations know about — future tables would silently re-enter
-- the over-exposed state. This migration flips the environment itself into
-- "manual exposure" mode: the SQL equivalent of unticking "Automatically
-- expose new tables" at project creation (the configuration originally
-- recommended in PHASE2_SCHEMA_DESIGN §12).
--
-- After this: every new table starts with ZERO API-role privileges and each
-- migration must grant exactly what its tables need (already the design-doc
-- discipline). runRemote.mjs verification enforces it from now on.

-- 1. Future tables created by our runner role start locked.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- 2. supabase_admin's defaults are Supabase-managed; try to align them but do
--    not fail the migration if privilege geometry forbids it.
DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'supabase_admin default privileges left as-is (not owner)';
END $$;

-- 3. One-off sweep: strip TRUNCATE from both API roles on EVERY existing
--    public table (0007 enumerated tenant tables and missed profiles).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- 4. Re-assert the append-only hard-deny (idempotent, closes 0007's scope).
REVOKE UPDATE, DELETE ON public.compliance_checks FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.generation_jobs FROM anon, authenticated;
