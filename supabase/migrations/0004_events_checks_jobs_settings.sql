-- 0004: Calendar events, compliance checks, generation jobs, org settings (design doc §4.6–4.9)
-- The timezone fix (audit B-2/B-4) lands here: scheduled_at is a real
-- timestamptz instant; the server converts from the org timezone on write.

CREATE TABLE public.calendar_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand_id     uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  -- NULL = standalone event; CASCADE matches Phase 1 semantics where deleting
  -- a draft removes its scheduled events.
  draft_id     uuid REFERENCES public.content_drafts(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  platform     public.platform_type NOT NULL,
  scheduled_at timestamptz NOT NULL,
  timezone     text NOT NULL,
  status       public.event_status NOT NULL DEFAULT 'scheduled',
  summary      text NOT NULL DEFAULT '',
  created_by   uuid NOT NULL REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Audit D-1 enforced structurally: at most one live scheduled/published event
-- per draft per org. Legacy duplicate data cannot re-enter the system.
CREATE UNIQUE INDEX one_scheduled_event_per_draft
ON public.calendar_events (org_id, draft_id)
WHERE draft_id IS NOT NULL AND status IN ('scheduled', 'published');

CREATE INDEX events_org_brand_idx ON public.calendar_events (org_id, brand_id);
CREATE INDEX events_org_schedule_idx ON public.calendar_events (org_id, scheduled_at);

CREATE TRIGGER events_touch_updated_at
BEFORE UPDATE ON public.calendar_events
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Append-only compliance check history (design decision #3). A draft's
-- displayed verdict = latest row, denormalized into content_drafts.latest_check_id.
CREATE TABLE public.compliance_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  draft_id       uuid NOT NULL REFERENCES public.content_drafts(id) ON DELETE CASCADE,
  provider       public.check_provider NOT NULL,
  passed         boolean NOT NULL,
  detected_fluff text[] NOT NULL DEFAULT '{}',
  char_count     integer NOT NULL CHECK (char_count >= 0),
  max_limit      integer NOT NULL CHECK (max_limit > 0),
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  check_version  text NOT NULL DEFAULT 'v1',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checks_draft_idx ON public.compliance_checks (draft_id, created_at DESC);

-- Keep content_drafts.latest_check_id pointing at the newest check.
CREATE OR REPLACE FUNCTION public.set_latest_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.content_drafts
  SET latest_check_id = NEW.id
  WHERE id = NEW.draft_id;
  RETURN NEW;
END $$;

CREATE TRIGGER checks_set_latest
AFTER INSERT ON public.compliance_checks
FOR EACH ROW EXECUTE FUNCTION public.set_latest_check();

ALTER TABLE public.content_drafts
  ADD CONSTRAINT content_drafts_latest_check_fk
  FOREIGN KEY (latest_check_id) REFERENCES public.compliance_checks(id) ON DELETE SET NULL;

-- AI generation audit trail: honest cost/quota visibility; closes audit S-1
-- once routes are auth-gated (design doc §9).
CREATE TABLE public.generation_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  draft_id        uuid REFERENCES public.content_drafts(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  model           text NOT NULL DEFAULT '',
  topic           text NOT NULL DEFAULT '',
  is_fallback     boolean NOT NULL DEFAULT false,
  fallback_reason text,
  latency_ms      integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_org_created_idx ON public.generation_jobs (org_id, created_at DESC);

-- 1:1 with organizations; preserves audited auto-save semantics (audit item D):
-- auto_save_drafts gates library persistence only, never settings durability.
CREATE TABLE public.organization_settings (
  org_id           uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  auto_save_drafts boolean NOT NULL DEFAULT true,
  ui_prefs         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER org_settings_touch_updated_at
BEFORE UPDATE ON public.organization_settings
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
