-- 0001: Enums for OMNI CHANNEL PLUS Phase 2 (design doc §3)
-- Forward-only. Never edit after applied; fix forward with a new migration.
-- gen_random_uuid() is native since PG13 — no extension required.

-- Member roles; capability ordering (viewer < editor < admin < owner) is
-- encoded in can_read/can_write/can_admin helpers (0005), not by enum order.
CREATE TYPE public.org_role AS ENUM ('viewer', 'editor', 'admin', 'owner');

-- Phase 1 uses 'ready' and 'scheduled'. 'published'/'archived' are reserved
-- for Phase 4 (platform publishing) — columns accept them only when that
-- phase actually writes them. No fake states.
CREATE TYPE public.draft_status AS ENUM ('ready', 'scheduled', 'published', 'archived');

-- Matches Phase 1 CalendarEvent statuses.
CREATE TYPE public.event_status AS ENUM ('draft', 'scheduled', 'published', 'cancelled');

-- Exact parity with PlatformType in src/types/index.ts.
CREATE TYPE public.platform_type AS ENUM (
  'linkedin', 'x', 'instagram_reels', 'instagram_feed', 'youtube',
  'tiktok', 'pinterest', 'whatsapp', 'email', 'blog_seo'
);

-- Which engine produced a compliance check result.
CREATE TYPE public.check_provider AS ENUM ('rule_local', 'gemini');
