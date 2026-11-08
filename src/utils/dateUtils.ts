/**
 * Time-zone-aware calendar date helpers.
 *
 * Calendar dates are stored as YYYY-MM-DD plus a wall-clock HH:mm value in the
 * selected workspace timezone. They must not be derived from UTC ISO strings
 * or the browser's timezone.
 */

export function getIanaTimeZone(timezoneSetting: string): string {
  const candidate = timezoneSetting.trim().split(/\s+/)[0] || 'UTC';

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** Returns a YYYY-MM-DD date string for an instant in the supplied IANA timezone or Settings label. */
export function getDateStringInTimeZone(
  date: Date = new Date(),
  timezoneSetting: string = 'UTC'
): string {
  const timeZone = getIanaTimeZone(timezoneSetting);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const part = (type: 'year' | 'month' | 'day') =>
    parts.find(item => item.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Returns a browser-local Date whose calendar fields match "today" in the
 * workspace timezone. Noon avoids DST transitions around local midnight.
 */
export function getCalendarDateInTimeZone(
  date: Date = new Date(),
  timezoneSetting: string = 'UTC'
): Date {
  const dateString = getDateStringInTimeZone(date, timezoneSetting);
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** Adds calendar days to a YYYY-MM-DD value without relying on the machine timezone. */
export function addDaysToDateString(dateString: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match || !Number.isInteger(days)) {
    throw new RangeError('Expected a YYYY-MM-DD date and an integer day offset.');
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  return date.toISOString().slice(0, 10);
}

/** Returns a browser-local YYYY-MM-DD string for a Date used as a calendar-only date. */
export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
