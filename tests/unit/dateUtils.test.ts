/**
 * Unit tests for local date-only helpers (audit items B-2/B-3/B-4).
 *
 * These tests intentionally construct Date objects from LOCAL components and
 * assert against the same LOCAL components. Because toLocalDateKey must be
 * timezone-independent BY CONTRACT (it must return the local calendar date,
 * not the UTC date), the assertions hold in any test environment.
 *
 * Run: node --import tsx --test tests/unit/*.test.ts  (no server, no network)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLocalDateKey, addDays, toLocalDateTimeStamp, formatEventStamp, eventSortKey } from '../../src/utils/dateUtils';

test('toLocalDateKey returns local calendar date, not UTC date', () => {
  // 00:30 local time on the 7th: in UTC+5 zones the UTC date is still the 6th,
  // in UTC-5 zones it is the 7th — the LOCAL date is the 7th in both.
  const earlyMorning = new Date(2026, 10, 7, 0, 30, 0);
  assert.equal(toLocalDateKey(earlyMorning), '2026-11-07');

  // Late-evening local date: UTC date is the next day in UTC+ zones.
  const lateEvening = new Date(2026, 10, 7, 23, 45, 0);
  assert.equal(toLocalDateKey(lateEvening), '2026-11-07');

  // Month boundaries keep local components.
  const monthStart = new Date(2026, 0, 1, 0, 5, 0);
  assert.equal(toLocalDateKey(monthStart), '2026-01-01');

  const monthEnd = new Date(2026, 1, 28, 23, 59, 0);
  assert.equal(toLocalDateKey(monthEnd), '2026-02-28');
});

test('toLocalDateKey derives strictly from local components in any timezone', () => {
  // Invariant: the key always equals manual formatting of the LOCAL
  // components — never a UTC-converted date. Runs identically in any CI TZ.
  const samples = [
    new Date(2026, 10, 7, 0, 30, 0),   // local just after midnight
    new Date(2026, 10, 7, 23, 45, 0),  // local just before midnight
    new Date(2026, 1, 29, 12, 0, 0),   // local noon
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const d of samples) {
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    assert.equal(toLocalDateKey(d), expected);
  }
});

test('addDays shifts calendar days preserving local time-of-day', () => {
  const base = new Date(2026, 10, 7, 14, 30, 0);
  const next = addDays(base, 1);
  assert.equal(toLocalDateKey(next), '2026-11-08');
  assert.equal(next.getHours(), 14);
  assert.equal(next.getMinutes(), 30);

  // Month rollover
  const jan31 = new Date(2026, 0, 31, 9, 0, 0);
  assert.equal(toLocalDateKey(addDays(jan31, 1)), '2026-02-01');

  // Year rollover
  const dec31 = new Date(2026, 11, 31, 9, 0, 0);
  assert.equal(toLocalDateKey(addDays(dec31, 1)), '2027-01-01');

  // Negative direction
  assert.equal(toLocalDateKey(addDays(base, -7)), '2026-10-31');

  // Input is not mutated
  assert.equal(toLocalDateKey(base), '2026-11-07');
});

test('toLocalDateTimeStamp formats local naive timestamp with zero padding', () => {
  const d = new Date(2026, 2, 5, 9, 5, 0);
  assert.equal(toLocalDateTimeStamp(d), '2026-03-05T09:05:00');

  const d2 = new Date(2026, 11, 31, 23, 59, 0);
  assert.equal(toLocalDateTimeStamp(d2), '2026-12-31T23:59:00');
});

test('formatEventStamp matches the stored scheduledDate format', () => {
  assert.equal(formatEventStamp('2026-11-10', '19:00'), '2026-11-10T19:00:00');
});

test('eventSortKey is lexicographically comparable', () => {
  assert.ok(eventSortKey({ date: '2026-11-10', time: '09:00' }) < eventSortKey({ date: '2026-11-10', time: '19:00' }));
  assert.ok(eventSortKey({ date: '2026-11-10', time: '09:00' }) < eventSortKey({ date: '2026-11-12', time: '08:00' }));
});
