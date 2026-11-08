-- 0003: Brands and content drafts (design doc §4.4–4.5)
-- Maps Phase 1 BrandProfile and ContentDraft shapes; JSONB kept for shapes
-- still evolving (brand_voice, hooks) per design decision #2.

CREATE TABLE public.brands (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  tagline            text NOT NULL DEFAULT '',
  industry           text NOT NULL DEFAULT '',
  target_audience    text NOT NULL DEFAULT '',
  brand_voice        jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferred_language text NOT NULL DEFAULT 'English',
  products_services  text[] NOT NULL DEFAULT '{}',
  created_by         uuid NOT NULL REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brands_org_name_unique UNIQUE (org_id, name)
);

CREATE INDEX brands_org_idx ON public.brands (org_id);

CREATE TRIGGER brands_touch_updated_at
BEFORE UPDATE ON public.brands
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.content_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand_id           uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  title              text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  topic              text NOT NULL CHECK (char_length(btrim(topic)) BETWEEN 1 AND 300),
  platform           public.platform_type NOT NULL,
  objective          text NOT NULL DEFAULT '',
  language           text NOT NULL DEFAULT 'English',
  audience           text NOT NULL DEFAULT '',
  selected_hook_type text NOT NULL DEFAULT 'patternInterrupt',
  hooks              jsonb NOT NULL DEFAULT '{}'::jsonb,
  caption            text NOT NULL DEFAULT '',
  call_to_action     text NOT NULL DEFAULT '',
  hashtags           text[] NOT NULL DEFAULT '{}',
  status             public.draft_status NOT NULL DEFAULT 'ready',
  -- Invariant I-2: a draft is 'scheduled' if and only if it carries a
  -- scheduled_at instant (audit D-2/D-3 enforced at the data layer).
  scheduled_at       timestamptz,
  latest_check_id    uuid,  -- FK added in 0004 once compliance_checks exists
  created_by         uuid NOT NULL REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drafts_scheduled_has_timestamp CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CONSTRAINT drafts_nonscheduled_no_timestamp CHECK (status = 'scheduled' OR scheduled_at IS NULL)
);

CREATE INDEX drafts_org_brand_idx ON public.content_drafts (org_id, brand_id);
CREATE INDEX drafts_org_status_idx ON public.content_drafts (org_id, status);
CREATE INDEX drafts_org_scheduled_idx ON public.content_drafts (org_id, scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE TRIGGER drafts_touch_updated_at
BEFORE UPDATE ON public.content_drafts
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
