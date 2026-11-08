-- 0005: Row Level Security — helpers, policies, grants (design doc §6)
-- RLS is defense in depth: the Express server verifies the user JWT and
-- asserts org membership before every query (§9). Policies are the safety
-- net behind that gate, never the only line.

-- Membership lookup helpers (SECURITY DEFINER: they must read
-- organization_members regardless of the caller's own RLS visibility;
-- they return only a role flag, never row data).

CREATE OR REPLACE FUNCTION public.org_role_at(p_org uuid) RETURNS public.org_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role FROM public.organization_members m
  WHERE m.org_id = p_org AND m.user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.can_read(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.org_role_at(p_org) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.can_write(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.org_role_at(p_org) IN ('editor', 'admin', 'owner')
$$;

CREATE OR REPLACE FUNCTION public.can_admin(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.org_role_at(p_org) IN ('admin', 'owner')
$$;

REVOKE EXECUTE ON FUNCTION public.org_role_at(uuid), public.can_read(uuid),
  public.can_write(uuid), public.can_admin(uuid) FROM PUBLIC, anon;
-- Policies evaluate under the caller's role, so the calling role needs EXECUTE.
GRANT EXECUTE ON FUNCTION public.org_role_at(uuid), public.can_read(uuid),
  public.can_write(uuid), public.can_admin(uuid) TO authenticated, service_role;
-- (Append-only privilege revocations live at the end of this file, after all GRANTs.)

-- Enable + FORCE RLS on every tenant table (FORCE: applies even to table
-- owners, so nothing bypasses policies by accident).
ALTER TABLE public.profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_drafts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_checks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_jobs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organizations         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brands                FORCE ROW LEVEL SECURITY;
ALTER TABLE public.content_drafts        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_checks     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.generation_jobs       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings FORCE ROW LEVEL SECURITY;

-- profiles: a user sees and edits only their own profile.
CREATE POLICY profiles_select ON public.profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY profiles_update ON public.profiles FOR UPDATE USING (id = auth.uid());

-- organizations: members read; admins update; only the owner deletes.
-- No INSERT policy: creation goes through create_organization() RPC.
CREATE POLICY orgs_select ON public.organizations FOR SELECT USING (public.can_read(id));
CREATE POLICY orgs_update ON public.organizations FOR UPDATE USING (public.can_admin(id));
CREATE POLICY orgs_delete ON public.organizations FOR DELETE USING (public.org_role_at(id) = 'owner');

-- organization_members: members see the roster; admins manage it.
CREATE POLICY members_select ON public.organization_members FOR SELECT
  USING (user_id = auth.uid() OR public.can_read(org_id));
CREATE POLICY members_insert ON public.organization_members FOR INSERT
  WITH CHECK (public.can_admin(org_id));
CREATE POLICY members_update ON public.organization_members FOR UPDATE
  USING (public.can_admin(org_id)) WITH CHECK (public.can_admin(org_id));
CREATE POLICY members_delete ON public.organization_members FOR DELETE
  USING (public.can_admin(org_id));

-- Tenant data: read = any member, write = editor+, delete = admin+.
-- INSERT additionally pins created_by to the acting user.

CREATE POLICY brands_select ON public.brands FOR SELECT USING (public.can_read(org_id));
CREATE POLICY brands_insert ON public.brands FOR INSERT
  WITH CHECK (public.can_write(org_id) AND created_by = auth.uid());
CREATE POLICY brands_update ON public.brands FOR UPDATE
  USING (public.can_write(org_id)) WITH CHECK (public.can_write(org_id));
CREATE POLICY brands_delete ON public.brands FOR DELETE USING (public.can_admin(org_id));

CREATE POLICY drafts_select ON public.content_drafts FOR SELECT USING (public.can_read(org_id));
CREATE POLICY drafts_insert ON public.content_drafts FOR INSERT
  WITH CHECK (public.can_write(org_id) AND created_by = auth.uid());
CREATE POLICY drafts_update ON public.content_drafts FOR UPDATE
  USING (public.can_write(org_id)) WITH CHECK (public.can_write(org_id));
CREATE POLICY drafts_delete ON public.content_drafts FOR DELETE USING (public.can_admin(org_id));

CREATE POLICY events_select ON public.calendar_events FOR SELECT USING (public.can_read(org_id));
CREATE POLICY events_insert ON public.calendar_events FOR INSERT
  WITH CHECK (public.can_write(org_id) AND created_by = auth.uid());
CREATE POLICY events_update ON public.calendar_events FOR UPDATE
  USING (public.can_write(org_id)) WITH CHECK (public.can_write(org_id));
CREATE POLICY events_delete ON public.calendar_events FOR DELETE USING (public.can_admin(org_id));

-- compliance_checks: append-only for editors (no UPDATE/DELETE policies =
-- denied). History is never rewritten.
CREATE POLICY checks_select ON public.compliance_checks FOR SELECT USING (public.can_read(org_id));
CREATE POLICY checks_insert ON public.compliance_checks FOR INSERT
  WITH CHECK (public.can_write(org_id));

-- generation_jobs: admins read (privacy of cost data); rows are written by
-- the server through the service role only — no INSERT policy for users.
CREATE POLICY jobs_select ON public.generation_jobs FOR SELECT USING (public.can_admin(org_id));

-- organization_settings: read by members, write by editors; no delete.
CREATE POLICY settings_select ON public.organization_settings FOR SELECT USING (public.can_read(org_id));
CREATE POLICY settings_insert ON public.organization_settings FOR INSERT
  WITH CHECK (public.can_write(org_id));
CREATE POLICY settings_update ON public.organization_settings FOR UPDATE
  USING (public.can_write(org_id)) WITH CHECK (public.can_write(org_id));

-- Grants: application traffic uses the authenticated role through the
-- server. anon gets schema usage only — tenant tables yield nothing.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.create_organization(text, text, text) TO authenticated;
-- provision_demo_workspace (0006) grants its own EXECUTE right after creation.

-- Hard append-only enforcement (design doc §4.7/§4.8): missing policies only
-- filter rows (silent no-op), so the privileges themselves are revoked for a
-- hard denial. Must run AFTER the broad GRANTs above. service_role keeps
-- full rights (server-side writes only).
REVOKE UPDATE, DELETE ON public.compliance_checks FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.generation_jobs FROM authenticated;
