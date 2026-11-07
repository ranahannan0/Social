/**
 * Date utilities for local date formatting without timezone offsets or one-day mismatches.
 */

/**
 * Returns a local YYYY-MM-DD date string for a given Date object (defaulting to now).
 * Avoids toISOString() which uses UTC and can cause a one-day shift depending on local timezone.
 */
export function getLocalDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats a Date object or YYYY-MM-DD string into Asia/Karachi (PKT, UTC+5) display string.
 */
export function formatKarachiDateTime(dateInput: Date | string, timeStr?: string): string {
  const d = typeof dateInput === 'string' ? new Date(`${dateInput}T${timeStr || '00:00'}:00`) : dateInput;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}
