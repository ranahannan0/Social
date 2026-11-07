import { BrandProfile, ContentDraft, CalendarEvent, PlatformType } from '../types';

/**
 * Brand Deletion & Cascading Record Cleanup
 * - Removes the brand from the brand list
 * - Removes all drafts associated with the brand to prevent orphaned drafts
 * - Removes all calendar events associated with the brand or its drafts
 * - Reassigns activeBrandId to the first remaining brand if the deleted brand was active
 */
export function cascadeDeleteBrand(params: {
  brands: BrandProfile[];
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  activeBrandId: string;
  targetBrandId: string;
}): {
  brands: BrandProfile[];
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  activeBrandId: string;
} {
  const { brands, drafts, calendarEvents, activeBrandId, targetBrandId } = params;

  if (brands.length <= 1) {
    // Keep at least one brand profile
    return { brands, drafts, calendarEvents, activeBrandId };
  }

  const brandDraftIds = new Set(drafts.filter(d => d.brandId === targetBrandId).map(d => d.id));
  const remainingDrafts = drafts.filter(d => d.brandId !== targetBrandId);
  const remainingEvents = calendarEvents.filter(
    e => e.brandId !== targetBrandId && (!e.draftId || !brandDraftIds.has(e.draftId))
  );
  const remainingBrands = brands.filter(b => b.id !== targetBrandId);

  const newActiveBrandId =
    activeBrandId === targetBrandId || !remainingBrands.some(b => b.id === activeBrandId)
      ? remainingBrands[0]?.id || ''
      : activeBrandId;

  return {
    brands: remainingBrands,
    drafts: remainingDrafts,
    calendarEvents: remainingEvents,
    activeBrandId: newActiveBrandId,
  };
}

/**
 * Calendar Event Deletion & Draft Synchronization
 * - Removes the specified calendar event
 * - If the event is linked to a draft, resets the draft's status to 'ready' and clears scheduledDate
 */
export function syncDeleteCalendarEvent(params: {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  targetEventId: string;
}): {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
} {
  const { drafts, calendarEvents, targetEventId } = params;
  const targetEvent = calendarEvents.find(e => e.id === targetEventId);

  let updatedDrafts = drafts;
  if (targetEvent?.draftId) {
    updatedDrafts = drafts.map(d => {
      if (d.id === targetEvent.draftId) {
        return {
          ...d,
          status: 'ready' as const,
          scheduledDate: undefined,
          updatedAt: new Date().toISOString(),
        };
      }
      return d;
    });
  }

  const updatedEvents = calendarEvents.filter(e => e.id !== targetEventId);
  return {
    drafts: updatedDrafts,
    calendarEvents: updatedEvents,
  };
}

/**
 * Reschedule Draft Without Duplicate Calendar Events
 * - Updates draft status to 'scheduled' and assigns scheduledDate
 * - If a calendar event already exists for draftId, updates it in-place
 * - If no calendar event exists, creates a single new event
 */
export function syncScheduleDraft(params: {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  draftId: string;
  date: string;
  time: string;
}): {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
} {
  const { drafts, calendarEvents, draftId, date, time } = params;
  const draft = drafts.find(d => d.id === draftId);
  if (!draft) return { drafts, calendarEvents };

  const scheduledDateIso = `${date}T${time}:00`;
  const updatedDrafts = drafts.map(d =>
    d.id === draftId
      ? {
          ...d,
          status: 'scheduled' as const,
          scheduledDate: scheduledDateIso,
          updatedAt: new Date().toISOString(),
        }
      : d
  );

  // Find all existing events for this draft to prevent and remove duplicates
  const matchingEvents = calendarEvents.filter(e => e.draftId === draftId);
  let updatedEvents: CalendarEvent[];

  if (matchingEvents.length > 0) {
    // Retain the first matching event as canonical and purge all duplicate events
    const canonicalEvent = matchingEvents[0];
    const updatedCanonical: CalendarEvent = {
      ...canonicalEvent,
      date,
      time,
      status: 'scheduled',
      title: draft.title,
      platform: draft.platform,
      summary: draft.caption.slice(0, 100),
    };

    // Filter out all events linked to this draftId, then put back only the updated canonical one
    const otherEvents = calendarEvents.filter(e => e.draftId !== draftId);
    updatedEvents = [...otherEvents, updatedCanonical];
  } else {
    const newEvent: CalendarEvent = {
      id: `event-${Date.now()}`,
      draftId: draft.id,
      brandId: draft.brandId,
      title: draft.title,
      platform: draft.platform,
      date,
      time,
      status: 'scheduled',
      summary: draft.caption.slice(0, 100),
    };
    updatedEvents = [...calendarEvents, newEvent];
  }

  return {
    drafts: updatedDrafts,
    calendarEvents: updatedEvents,
  };
}

/**
 * Editorial Quality Statistics Calculation
 * - Calculates pass rate using evaluated drafts only (drafts with complianceStatus).
 * - If no drafts have been evaluated (evaluatedCount === 0), returns neutral null pass rate.
 * - Sets hasEvaluatedContent strictly based on evaluatedDrafts.length > 0.
 * - Never labels editorial quality checks as legal compliance.
 */
export function calculateComplianceStats(params: {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  brands: BrandProfile[];
}) {
  const { drafts, calendarEvents, brands } = params;
  const total = drafts.length;
  const ready = drafts.filter(d => d.status === 'ready').length;
  const scheduled = calendarEvents.filter(e => e.status === 'scheduled').length;

  // Filter drafts that have been evaluated by compliance check
  const evaluatedDrafts = drafts.filter(d => d.complianceStatus !== undefined);
  const evaluatedCount = evaluatedDrafts.length;
  const passedQuality = evaluatedDrafts.filter(d => d.complianceStatus?.passed).length;

  // Pass rate is calculated ONLY over evaluated drafts. If evaluatedCount === 0, return null empty state.
  const compliancePassRate: number | null = evaluatedCount > 0 ? Math.round((passedQuality / evaluatedCount) * 100) : null;
  const hasEvaluatedContent = evaluatedCount > 0;

  const breakdown: Record<PlatformType, number> = {
    linkedin: 0,
    x: 0,
    instagram_reels: 0,
    instagram_feed: 0,
    youtube: 0,
    tiktok: 0,
    pinterest: 0,
    whatsapp: 0,
    email: 0,
    blog_seo: 0,
  };

  drafts.forEach(d => {
    if (breakdown[d.platform] !== undefined) {
      breakdown[d.platform]++;
    }
  });

  return {
    totalDrafts: total,
    readyDrafts: ready,
    scheduledCount: scheduled,
    totalBrands: brands.length,
    compliancePassRate,
    hasEvaluatedContent,
    platformBreakdown: breakdown,
  };
}
