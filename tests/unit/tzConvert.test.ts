import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNaiveToUtcIso, tzOffsetMinutes, isValidTimezone } from '../../src/utils/tzConvert';

test('Karachi (fixed UTC+5, no DST): naive midnight maps to previous day 19:00Z', () => {
  assert.equal(localNaiveToUtcIso('2026-03-13T00:30', 'Asia/Karachi'), '2026-03-12T19:30:00.000Z');
});

test('Karachi: end-of-day naive maps to same UTC day', () => {
  assert.equal(localNaiveToUtcIso('2026-03-13T23:30', 'Asia/Karachi'), '2026-03-13T18:30:00.000Z');
});

test('New York: DST summer offset (-4) respected', () => {
  assert.equal(localNaiveToUtcIso('2026-07-01T12:00', 'America/New_York'), '2026-07-01T16:00:00.000Z');
});

test('New York: winter offset (-5) respected', () => {
  assert.equal(localNaiveToUtcIso('2026-01-15T12:00', 'America/New_York'), '2026-01-15T17:00:00.000Z');
});

test('Malformed naive strings return null', () => {
  assert.equal(localNaiveToUtcIso('not-a-date', 'Asia/Karachi'), null);
  assert.equal(localNaiveToUtcIso('2026-13-45T99:99', 'Asia/Karachi'), null);
  assert.equal(localNaiveToUtcIso('', 'Asia/Karachi'), null);
});

test('Unknown timezone returns null instead of throwing', () => {
  assert.equal(localNaiveToUtcIso('2026-03-13T10:00', 'Mars/Olympus'), null);
});

test('tzOffsetMinutes: Karachi is +300, New York summer is -240', () => {
  const july = new Date('2026-07-01T12:00:00Z');
  assert.equal(tzOffsetMinutes(july, 'Asia/Karachi'), 300);
  assert.equal(tzOffsetMinutes(july, 'America/New_York'), -240);
});

test('isValidTimezone accepts real zones and rejects junk', () => {
  assert.equal(isValidTimezone('Asia/Karachi'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
});
