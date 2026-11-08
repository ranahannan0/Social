-- 0002: Core tenancy — profiles, organizations, organization_members (design doc §4.1–4.3)
-- Depends on: auth schema (Supabase-managed; local test shim provides a mock).

-- Shared updated_at maintenance -------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Profiles: 1:1 mirror of auth.users, display data only -------------------------
CREATE TABLE public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text NOT NULL DEFAULT '',
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''));
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Organizations ------------------------------------------------------------------
CREATE TABLE public.organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  default_timezone text NOT NULL DEFAULT 'Asia/Karachi',
  created_by       uuid NOT NULL REFERENCES public.profiles(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_touch_updated_at
BEFORE UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Membership ---------------------------------------------------------------------
CREATE TABLE public.organization_members (
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       public.org_role NOT NULL DEFAULT 'viewer',
  invited_by uuid REFERENCES public.profiles(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Last-owner guard: an org must always keep at least one owner (design doc §10.4).
CREATE OR REPLACE FUNCTION public.guard_last_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_org    uuid;
  v_owners integer;
BEGIN
  -- Cascaded deletes (org deletion removing members) must not be blocked:
  -- at trigger depth > 1 we are inside an FK cascade, not a direct edit.
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  SELECT count(*) INTO v_owners
  FROM public.organization_members
  WHERE org_id = v_org AND role = 'owner';

  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' AND v_owners <= 1 THEN
      RAISE EXCEPTION 'LAST_OWNER_CANNOT_BE_REMOVED';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'owner' AND NEW.role <> 'owner' AND v_owners <= 1 THEN
      RAISE EXCEPTION 'LAST_OWNER_CANNOT_BE_DEMOTED';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER guard_org_last_owner
BEFORE DELETE OR UPDATE OF role ON public.organization_members
FOR EACH ROW EXECUTE FUNCTION public.guard_last_owner();

-- Organization creation RPC: inserts org + owner membership + settings row
-- atomically. SECURITY DEFINER because the creator has no membership yet.
CREATE OR REPLACE FUNCTION public.create_organization(
  p_name     text,
  p_slug     text,
  p_timezone text DEFAULT 'Asia/Karachi'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  uuid;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_timezone !~ '^[A-Za-z_]+/[A-Za-z_+-]+$' THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE';
  END IF;

  INSERT INTO public.organizations (name, slug, default_timezone, created_by)
  VALUES (p_name, p_slug, p_timezone, v_user)
  RETURNING id INTO v_org;

  INSERT INTO public.organization_members (org_id, user_id, role)
  VALUES (v_org, v_user, 'owner');

  INSERT INTO public.organization_settings (org_id) VALUES (v_org);

  RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_organization(text, text, text) FROM PUBLIC, anon;
