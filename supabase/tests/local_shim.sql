-- LOCAL TEST SHIM — NEVER applied to Supabase.
-- Provides minimal stand-ins for Supabase-managed objects so the exact
-- migration files can be verified against vanilla PostgreSQL locally:
--   - roles anon / authenticated / service_role / supabase_admin (Supabase
--     pre-creates these)
--   - Supabase's ALTER DEFAULT PRIVILEGES behaviour: every new public-schema
--     table starts GRANT ALL to the API roles (discovered during the real
--     cutover 2026-11-08; migrations 0007/0008 harden against exactly this)
--   - schema auth with a users table and auth.uid() reading the JWT GUC
-- On Supabase, auth.uid() resolves claims from the real JWT; here tests set
-- `request.jwt.claims` per connection to impersonate a user.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN;
  END IF;
END $$;

-- Mirror Supabase's real default-privilege exposure (see 0007/0008):
-- new public tables start with ALL privileges for the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                uuid PRIMARY KEY,
  email             text UNIQUE,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Mirrors Supabase semantics: NULL when no JWT claims are set.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
BEGIN
  v := current_setting('request.jwt.claims', true);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN (v::jsonb ->> 'sub')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END $$;
