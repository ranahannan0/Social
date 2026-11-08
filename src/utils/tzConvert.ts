/**
 * Timezone conversion helpers (pure, Node + browser safe).
 *
 * Phase 1 stored local-naive values ("YYYY-MM-DDTHH:mm:00", wall clock in the
 * operator's timezone). Phase 2 stores real instants (timestamptz). This
 * module converts naive wall-clock strings to UTC ISO instants using the
 * IANA timezone recorded for the workspace (organizations.default_timezone).
 *
 * No external library: uses Intl.DateTimeFormat offset probing (the standard
 * two-pass algorithm), correct across DST boundaries for zoned rules.
 */

const NATIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Offset of `tz` from UTC, in minutes, at the given instant (east positive). */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUTC = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second')
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/**
 * Converts a local-naive timestamp interpreted in `tz` to a UTC ISO instant.
 * Returns null when the input is malformed or the timezone is unknown.
 */
export function localNaiveToUtcIso(naive: string, tz: string): string | null {
  const m = NATIVE_RE.exec(naive.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = +y, month = +mo, day = +d, hour = +h, minute = +mi, second = +(s || 0);

  // Strict calendar validation — Date.UTC silently normalizes out-of-range
  // values (month 13 becomes Feb of the next year), which would fabricate
  // instants from garbage input.
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);

  try {
    const off1 = tzOffsetMinutes(new Date(utcGuess), tz);
    const adjusted = utcGuess - off1 * 60000;
    const off2 = tzOffsetMinutes(new Date(adjusted), tz);
    // Near DST transitions the two probes may disagree; one more pass settles.
    const off3 = tzOffsetMinutes(new Date(utcGuess - off2 * 60000), tz);
    const finalOffset = off3 === off1 ? off1 : off2;
    return new Date(utcGuess - finalOffset * 60000).toISOString();
  } catch {
    return null;
  }
}

/** True when the string is a well-formed IANA zone understood by Intl. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Inverse of localNaiveToUtcIso: takes a UTC ISO instant and an IANA zone,
 * returns the wall-clock `{ date: 'YYYY-MM-DD', time: 'HH:mm' }` as observed
 * at that zone. Returns null when the input is malformed or the zone is
 * unknown. Used by the workspace hydrator to map DB `scheduled_at` back into
 * the frontend's naive CalendarEvent shape.
 */
export function utcIsoToLocalNaive(
  utcIso: string,
  tz: string
): { date: string; time: string } | null {
  let instant: number;
  try {
    instant = Date.parse(utcIso);
    if (Number.isNaN(instant)) return null;
  } catch {
    return null;
  }
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(instant));
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hourRaw = get('hour');
    // Intl can emit '24' for midnight in some environments; normalise.
    const hour = hourRaw === '24' ? '00' : hourRaw;
    const minute = get('minute');
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
  } catch {
    return null;
  }
}
