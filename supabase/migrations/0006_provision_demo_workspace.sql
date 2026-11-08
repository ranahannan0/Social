-- 0006: Demo workspace provisioning (design decision #5 — recommended: seed)
-- Creates an idempotent RPC a new owner calls once after create_organization()
-- to reproduce the familiar Phase 1 demo experience with real, consistent data.
-- On Supabase this runs as the authenticated user; SECURITY DEFINER lets the
-- function verify admin rights and insert across tables atomically.

CREATE OR REPLACE FUNCTION public.provision_demo_workspace(p_org uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_brand uuid;
  v_draft uuid;
  v_tz    text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF NOT public.can_admin(p_org) THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN';
  END IF;

  SELECT default_timezone INTO v_tz FROM public.organizations WHERE id = p_org;

  -- Idempotent: a second call changes nothing.
  IF EXISTS (SELECT 1 FROM public.brands WHERE org_id = p_org AND name = 'Demo Brand') THEN
    RETURN false;
  END IF;

  INSERT INTO public.brands (org_id, name, tagline, industry, target_audience,
                             brand_voice, preferred_language, products_services, created_by)
  VALUES (p_org, 'Demo Brand',
          'Quality you can measure', 'SaaS',
          'Marketing teams at small businesses',
          jsonb_build_object(
            'tone', 'Professional, clear, friendly',
            'banned_words', jsonb_build_array('revolutionary', 'game-changer'),
            'style_guidelines', 'Short sentences. Concrete claims. No hype.',
            'sample_copy', 'Our customers save 5 hours a week on reporting.'),
          'English', ARRAY['Analytics dashboard'], v_user)
  RETURNING id INTO v_brand;

  -- Draft 1: evaluated and passed (mirrors Phase 1 seed semantics).
  INSERT INTO public.content_drafts (org_id, brand_id, title, topic, platform,
                                     objective, language, audience, hooks, caption,
                                     hashtags, status, created_by)
  VALUES (p_org, v_brand, 'Launch announcement draft', 'Launch announcement',
          'linkedin', 'Authority', 'English', 'Marketing teams',
          jsonb_build_object('patternInterrupt', '', 'curiosityGap', '', 'directBenefit', ''),
          'Reporting should not eat your week. Our dashboard gives teams back five hours.',
          ARRAY['productivity', 'analytics'], 'ready', v_user)
  RETURNING id INTO v_draft;

  INSERT INTO public.compliance_checks (org_id, draft_id, provider, passed,
                                        detected_fluff, char_count, max_limit, warnings)
  VALUES (p_org, v_draft, 'rule_local', true, '{}', 91, 3000, '[]');

  -- Draft 2: scheduled with a matching calendar event (invariant I-2 holds:
  -- status='scheduled' AND scheduled_at set AND exactly one live event).
  INSERT INTO public.content_drafts (org_id, brand_id, title, topic, platform,
                                     objective, language, audience, hooks, caption,
                                     hashtags, status, scheduled_at, created_by)
  VALUES (p_org, v_brand, 'Customer story teaser', 'Customer success story',
          'linkedin', 'Engagement', 'English', 'Marketing teams',
          jsonb_build_object('patternInterrupt', '', 'curiosityGap', '', 'directBenefit', ''),
          'How a three-person team automated their weekly report. Story on Thursday.',
          ARRAY['casestudy'], 'scheduled',
          (date_trunc('day', now() AT TIME ZONE v_tz) + interval '1 day 10 hours') AT TIME ZONE v_tz,
          v_user)
  RETURNING id INTO v_draft;

  INSERT INTO public.calendar_events (org_id, brand_id, draft_id, title, platform,
                                      scheduled_at, timezone, status, summary, created_by)
  SELECT p_org, v_brand, v_draft, 'Customer story teaser', 'linkedin',
         d.scheduled_at, v_tz, 'scheduled', left(d.caption, 100), v_user
  FROM public.content_drafts d WHERE d.id = v_draft;

  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION public.provision_demo_workspace(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_demo_workspace(uuid) TO authenticated;
