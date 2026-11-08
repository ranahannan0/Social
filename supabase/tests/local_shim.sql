-- LOCAL TEST SHIM — NEVER applied to Supabase.
-- Provides minimal stand-ins for Supabase-managed objects so the exact
-- migration files can be verified against vanilla PostgreSQL locally:
--   - roles anon / authenticated / service_role (Supabase pre-creates these)
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
END $$;

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
