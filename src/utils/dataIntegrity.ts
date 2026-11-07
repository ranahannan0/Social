import { BrandProfile, ContentDraft, CalendarEvent, PlatformType } from '../types';
import { eventSortKey, formatEventStamp, toLocalDateTimeStamp } from './dateUtils';

/**
 * Entity ID generator with random suffix (Audit item D-5).
 * Date.now() alone can collide when two entities are created within the
 * same millisecond (fast duplicate clicks, batch seeding, tests).
 */
export function generateEntityId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

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
 * Recompute a draft's schedule state from ALL of its remaining calendar events
 * (Audit items D-2/D-3).
 *
 * A draft is 'scheduled' if and only if at least one of its calendar events is
 * still in 'scheduled' status; its scheduledDate then mirrors the EARLIEST such
 * event. Otherwise the draft falls back to 'ready' with no scheduledDate.
 * This keeps draft state consistent no matter which single event was touched,
 * and is idempotent.
 */
export function recomputeDraftScheduleState(params: {
  drafts: ContentDraft[];
  calendarEvents: CalendarEvent[];
  draftId: string;
}): ContentDraft[] {
  const { drafts, calendarEvents, draftId } = params;

  const scheduledEvents = calendarEvents
    .filter(e => e.draftId === draftId && e.status === 'scheduled')
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));

  return drafts.map(d => {
    if (d.id !== draftId) return d;
    if (scheduledEvents.length > 0) {
      const primary = scheduledEvents[0];
      return {
        ...d,
        status: 'scheduled' as const,
        scheduledDate: formatEventStamp(primary.date, primary.time),
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...d,
      status: 'ready' as const,
      scheduledDate: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Calendar Event Deletion & Draft Synchronization
 * - Removes the specified calendar event
 * - If the event is linked to a draft, the draft's schedule state is recomputed
 *   from its REMAINING events: it stays 'scheduled' if another scheduled event
 *   still exists (Audit item D-2), otherwise it resets to 'ready' and the
 *   scheduledDate is cleared.
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

  const updatedEvents = calendarEvents.filter(e => e.id !== targetEventId);

  let updatedDrafts = drafts;
  if (targetEvent?.draftId) {
    updatedDrafts = recomputeDraftScheduleState({
      drafts,
      calendarEvents: updatedEvents,
      draftId: targetEvent.draftId,
    });
  }

  return {
    drafts: updatedDrafts,
    calendarEvents: updatedEvents,
  };
}

/**
 * Reschedule Draft With Exactly One Calendar Event (Audit item D-1)
 * - Updates draft status to 'scheduled' and assigns scheduledDate
 * - If one or more calendar events already exist for draftId (including legacy
 *   duplicates), the FIRST becomes the single up-to-date event and any
 *   additional duplicates are removed — the operation is idempotent.
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

  const scheduledDateIso = formatEventStamp(date, time);
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

  // Keep the FIRST existing event as canonical (position preserved) and purge
  // any additional duplicates (audit item D-1; parallel upstream fix a8c68ed
  // resolves the same issue with an equivalent purge).
  const existingEvents = calendarEvents.filter(e => e.draftId === draftId);
  let updatedEvents: CalendarEvent[];

  if (existingEvents.length > 0) {
    const primaryId = existingEvents[0].id;
    const duplicateIds = new Set(existingEvents.slice(1).map(e => e.id));
    updatedEvents = calendarEvents
      .filter(e => !duplicateIds.has(e.id))
      .map(e =>
        e.id === primaryId
          ? {
              ...e,
              date,
              time,
              status: 'scheduled' as const,
              title: draft.title,
              platform: draft.platform,
              summary: draft.caption.slice(0, 100),
            }
          : e
      );
  } else {
    const newEvent: CalendarEvent = {
      id: generateEntityId('event'),
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
 * Upcoming Calendar Selection (Audit item D-6)
 * - Keeps only events at or after `now` (compared as local YYYY-MM-DDTHH:mm)
 * - Sorts chronologically ascending
 * - Returns at most `limit` events
 * Used by the Dashboard "Upcoming Calendar" widget so past events never appear
 * as upcoming.
 */
export function selectUpcomingEvents(
  events: CalendarEvent[],
  now: Date,
  limit: number
): CalendarEvent[] {
  const nowKey = toLocalDateTimeStamp(now).slice(0, 16); // YYYY-MM-DDTHH:mm
  return events
    .filter(e => eventSortKey(e) >= nowKey)
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)))
    .slice(0, limit);
}

/**
 * Editorial Quality Statistics (Audit item B-1)
 * - Pass-rate denominator counts ONLY drafts with an actual evaluation result
 *   (complianceStatus present), never all drafts.
 * - Returns a neutral null pass rate when no drafts have been evaluated.
 * - hasEvaluatedContent is true only when at least one evaluation exists.
 * - These are EDITORIAL quality checks (anti-fluff, length): never presented
 *   as legal or regulatory compliance.
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

  // Only drafts with an ACTUAL evaluation result count as evaluated
  // (guards against both undefined and legacy null values).
  const evaluatedDrafts = drafts.filter(d => d.complianceStatus !== undefined && d.complianceStatus !== null);
  const evaluatedCount = evaluatedDrafts.length;
  const passedQuality = evaluatedDrafts.filter(d => d.complianceStatus?.passed).length;

  // Pass rate is calculated ONLY over evaluated drafts; neutral null when none.
  const compliancePassRate: number | null =
    evaluatedCount > 0 ? Math.round((passedQuality / evaluatedCount) * 100) : null;
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
    evaluatedCount: evaluatedDrafts.length,
    compliancePassRate,
    hasEvaluatedContent,
    platformBreakdown: breakdown,
  };
}
