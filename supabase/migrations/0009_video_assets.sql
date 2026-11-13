-- 0009: Video assets (P6 vertical slice) — org-scoped uploads + AI analysis
-- results, plus a private Supabase Storage bucket that mirrors org membership.
--
-- Post-0008 discipline: every new table starts with ZERO API-role privileges.
-- This migration grants exactly what the app needs and nothing else:
--   authenticated: SELECT/INSERT/UPDATE/DELETE on video_assets (RLS-gated)
--   anon: nothing. TRUNCATE: nobody (never part of the app vocabulary).
-- Storage objects live in the `storage` schema, which is Supabase-managed and
-- unaffected by the public-schema lockdown; policies there are scoped to the
-- org-videos bucket and re-use the same org-membership helpers as the tables.
--
-- The local verification shim has no `storage` schema, so every storage-schema
-- statement is guarded on its existence (no-op locally, live on Supabase).

CREATE TABLE public.video_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Storage object name inside bucket 'org-videos': '<orgId>/<uuid>.<ext>'.
  -- UNIQUE because one DB row owns exactly one object; the path is server-
  -- generated and never derived from user input.
  storage_path  text NOT NULL UNIQUE,
  file_name     text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 200),
  mime_type     text NOT NULL CHECK (mime_type IN ('video/mp4', 'video/webm', 'video/quicktime')),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  status        text NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded', 'analyzing', 'analyzed', 'failed')),
  -- AI (or honest fallback) analysis payload — shape in src/utils/videoAssets.ts.
  analysis      jsonb,
  analysis_is_fallback boolean,
  analyzed_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER video_assets_touch_updated_at
BEFORE UPDATE ON public.video_assets
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX video_assets_org_created_idx ON public.video_assets (org_id, created_at DESC);

-- RLS: same posture as every tenant table (0005 style).
ALTER TABLE public.video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_assets FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.video_assets TO authenticated;
REVOKE ALL ON public.video_assets FROM anon;
REVOKE TRUNCATE ON public.video_assets FROM anon, authenticated;

-- Read: every org member (can_read) — the library card shows assets to all
-- roles, exactly like drafts.
CREATE POLICY videos_select ON public.video_assets FOR SELECT USING (public.can_read(org_id));
-- Write: editors and above (can_write), creator pinned to the caller.
CREATE POLICY videos_insert ON public.video_assets FOR INSERT
  WITH CHECK (public.can_write(org_id) AND created_by = auth.uid());
CREATE POLICY videos_update ON public.video_assets FOR UPDATE
  USING (public.can_write(org_id)) WITH CHECK (public.can_write(org_id));
-- Manage: admins and above (can_admin) — matches the brands delete policy.
CREATE POLICY videos_delete ON public.video_assets FOR DELETE USING (public.can_admin(org_id));

-- Storage bucket + org-membership-scoped object policies. Guarded on the
-- storage schema so the local shim skips cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'org-videos', 'org-videos', false, 26214400,
      ARRAY['video/mp4', 'video/webm', 'video/quicktime']
    )
    ON CONFLICT (id) DO UPDATE
      SET file_size_limit = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;

    -- The first path folder is the org UUID (server-controlled). The regex
    -- guard makes the cast safe even if a stray object ever appeared.
    CREATE POLICY videos_storage_select ON storage.objects FOR SELECT
      TO authenticated
      USING (
        bucket_id = 'org-videos'
        AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
        AND public.can_read(((storage.foldername(name))[1])::uuid)
      );
    CREATE POLICY videos_storage_insert ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (
        bucket_id = 'org-videos'
        AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
        AND public.can_write(((storage.foldername(name))[1])::uuid)
      );
    CREATE POLICY videos_storage_delete ON storage.objects FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'org-videos'
        AND (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
        AND public.can_admin(((storage.foldername(name))[1])::uuid)
      );
  END IF;
END $$;
