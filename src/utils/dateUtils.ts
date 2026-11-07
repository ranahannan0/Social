/**
 * Local Date-Only Utilities (Phase 1 Stabilization — Audit item B-2/B-3/B-4)
 *
 * Problem this module solves:
 * `date.toISOString().split('T')[0]` converts the Date to UTC before extracting
 * the calendar date. For any server/browser timezone east of UTC (the primary
 * audience is Asia/Karachi, UTC+5), a local date between 00:00 and 04:59 shifts
 * to the PREVIOUS day, which mis-filed calendar events by one day in week/day
 * views and produced wrong "tomorrow" defaults in the ScheduleModal.
 *
 * Policy (Phase 1):
 * - Date-only values (calendar grid keys, event dates) are derived strictly
 *   from LOCAL date components via these helpers. Never via toISOString().
 * - Date-only strings (YYYY-MM-DD) and local naive timestamps
 *   (YYYY-MM-DDTHH:mm:00) are kept as separate concerns, matching the
 *   CalendarEvent.date and ContentDraft.scheduledDate storage formats.
 * - Full IANA-timezone-aware scheduling (converting a stored zone-aware
 *   timestamp to a viewer timezone) is a Phase 2 concern once timestamps are
 *   persisted as timestamptz server-side. In Phase 1 the browser-local
 *   timezone of the operator IS the workspace timezone (initially PKT).
 */

/** Returns the LOCAL calendar date key `YYYY-MM-DD` for a Date. */
export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Returns a new Date shifted by N days, preserving local time-of-day. */
export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

/** Returns the local naive timestamp `YYYY-MM-DDTHH:mm:00` for a Date. */
export function toLocalDateTimeStamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${toLocalDateKey(date)}T${hours}:${minutes}:00`;
}

/**
 * Combines a date-only key and an HH:mm time into the stored local naive
 * timestamp format used by ContentDraft.scheduledDate.
 */
export function formatEventStamp(dateKey: string, timeKey: string): string {
  return `${dateKey}T${timeKey}:00`;
}

/**
 * Comparable stamp for an event: `YYYY-MM-DDTHH:mm` in local terms.
 * Zero-padded ISO-style components make plain lexicographic comparison valid.
 */
export function eventSortKey(event: { date: string; time: string }): string {
  return `${event.date}T${event.time}`;
}
