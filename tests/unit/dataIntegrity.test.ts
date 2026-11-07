/**
 * Unit tests for data integrity helpers (audit items B-1, D-1, D-2, D-4, D-6).
 * Pure functions only: no server, no network, no Gemini API cost.
 *
 * The compliance-stats tests are direct regression tests for the shipped bug
 * where the pass-rate denominator counted ALL drafts instead of only
 * evaluated drafts, and hasEvaluatedContent was true whenever any draft
 * existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cascadeDeleteBrand,
  syncDeleteCalendarEvent,
  syncScheduleDraft,
  calculateComplianceStats,
  recomputeDraftScheduleState,
  selectUpcomingEvents,
  generateEntityId,
} from '../../src/utils/dataIntegrity';
import { BrandProfile, ContentDraft, CalendarEvent } from '../../src/types';

// ---------- fixtures ----------

function makeBrand(id: string): BrandProfile {
  return {
    id,
    name: `Brand ${id}`,
    tagline: '',
    industry: '',
    targetAudience: '',
    brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' },
    preferredLanguage: 'English',
    productsAndServices: [],
    createdAt: '',
    updatedAt: '',
  };
}

function makeDraft(id: string, brandId: string, overrides: Partial<ContentDraft> = {}): ContentDraft {
  return {
    id,
    brandId,
    title: `Draft ${id}`,
    topic: 'T',
    platform: 'linkedin',
    objective: 'Authority',
    language: 'English',
    audience: '',
    selectedHookType: 'patternInterrupt',
    hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' },
    caption: 'C',
    callToAction: '',
    hashtags: [],
    status: 'draft',
    complianceStatus: undefined,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function makeEvent(id: string, draftId: string | undefined, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    draftId,
    brandId: 'b1',
    title: `Event ${id}`,
    platform: 'linkedin',
    date: '2026-11-10',
    time: '10:00',
    status: 'scheduled',
    summary: '',
    ...overrides,
  };
}

function evalResult(passed: boolean) {
  return { passed, detectedFluff: [], charCount: 10, maxLimit: 3000, warnings: [] };
}

// ---------- Editorial quality statistics (B-1 regression) ----------

test('pass rate uses evaluated drafts as denominator, not all drafts', () => {
  const drafts = [
    makeDraft('d1', 'b1', { complianceStatus: evalResult(true) }),
    makeDraft('d2', 'b1'), // never evaluated
    makeDraft('d3', 'b1'), // never evaluated
  ];
  const stats = calculateComplianceStats({ drafts, calendarEvents: [], brands: [] });
  // OLD BUG: 1/3 total = 33%. CORRECT: 1/1 evaluated = 100%.
  assert.equal(stats.compliancePassRate, 100);
});

test('pass rate includes evaluated failures in the denominator', () => {
  const drafts = [
    makeDraft('d1', 'b1', { complianceStatus: evalResult(true) }),
    makeDraft('d2', 'b1', { complianceStatus: evalResult(false) }),
    makeDraft('d3', 'b1', { complianceStatus: evalResult(false) }),
    makeDraft('d4', 'b1'), // never evaluated — must NOT dilute the rate
  ];
  const stats = calculateComplianceStats({ drafts, calendarEvents: [], brands: [] });
  assert.equal(stats.compliancePassRate, 33); // 1 passed / 3 evaluated
  assert.equal(stats.evaluatedCount, 3);
});

test('hasEvaluatedContent is false when drafts exist but none evaluated', () => {
  const drafts = [makeDraft('d1', 'b1'), makeDraft('d2', 'b1')];
  const stats = calculateComplianceStats({ drafts, calendarEvents: [], brands: [] });
  assert.equal(stats.compliancePassRate, null);
  assert.equal(stats.hasEvaluatedContent, false);
});

test('neutral state for an empty library', () => {
  const stats = calculateComplianceStats({ drafts: [], calendarEvents: [], brands: [makeBrand('b1')] });
  assert.equal(stats.compliancePassRate, null);
  assert.equal(stats.hasEvaluatedContent, false);
  assert.equal(stats.totalDrafts, 0);
  assert.equal(stats.totalBrands, 1);
});

test('all evaluated and passed yields 100 percent', () => {
  const drafts = [
    makeDraft('d1', 'b1', { complianceStatus: evalResult(true) }),
    makeDraft('d2', 'b1', { complianceStatus: evalResult(true) }),
  ];
  const stats = calculateComplianceStats({ drafts, calendarEvents: [], brands: [] });
  assert.equal(stats.compliancePassRate, 100);
  assert.equal(stats.hasEvaluatedContent, true);
});

// ---------- Rescheduling without duplicates (D-1) ----------

test('rescheduling consolidates legacy duplicate events into exactly one', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'ready' })];
  const events = [
    makeEvent('e1', 'd1', { date: '2026-11-10', time: '10:00' }),
    makeEvent('e2', 'd1', { date: '2026-11-11', time: '11:00' }), // legacy duplicate
  ];

  const result = syncScheduleDraft({ drafts, calendarEvents: events, draftId: 'd1', date: '2026-11-15', time: '14:00' });

  const d1Events = result.calendarEvents.filter(e => e.draftId === 'd1');
  assert.equal(d1Events.length, 1);
  assert.equal(d1Events[0].id, 'e1'); // first becomes primary
  assert.equal(d1Events[0].date, '2026-11-15');
  assert.equal(d1Events[0].time, '14:00');
  assert.equal(result.drafts.find(d => d.id === 'd1')?.status, 'scheduled');
});

test('rescheduling creates exactly one event when none exists', () => {
  const drafts = [makeDraft('d1', 'b1')];
  const result = syncScheduleDraft({ drafts, calendarEvents: [], draftId: 'd1', date: '2026-11-15', time: '09:00' });
  const d1Events = result.calendarEvents.filter(e => e.draftId === 'd1');
  assert.equal(d1Events.length, 1);
  assert.equal(d1Events[0].date, '2026-11-15');
});

test('rescheduling is idempotent — same inputs, single event, no growth', () => {
  const drafts = [makeDraft('d1', 'b1')];
  let events: CalendarEvent[] = [];
  let state = { drafts, calendarEvents: events };
  for (let i = 0; i < 3; i++) {
    state = syncScheduleDraft({ ...state, draftId: 'd1', date: '2026-11-15', time: '09:00' });
  }
  assert.equal(state.calendarEvents.filter(e => e.draftId === 'd1').length, 1);
});

test('rescheduling an unknown draft is a no-op', () => {
  const drafts = [makeDraft('d1', 'b1')];
  const events = [makeEvent('e1', undefined)];
  const result = syncScheduleDraft({ drafts, calendarEvents: events, draftId: 'missing', date: '2026-11-15', time: '09:00' });
  assert.equal(result.drafts, drafts);
  assert.equal(result.calendarEvents, events);
});

// ---------- Event deletion sync (D-2) ----------

test('deleting the only event resets the draft to ready and clears the date', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'scheduled', scheduledDate: '2026-11-10T10:00:00' })];
  const events = [makeEvent('e1', 'd1')];

  const result = syncDeleteCalendarEvent({ drafts, calendarEvents: events, targetEventId: 'e1' });

  assert.equal(result.calendarEvents.length, 0);
  const d1 = result.drafts.find(d => d.id === 'd1');
  assert.equal(d1?.status, 'ready');
  assert.equal(d1?.scheduledDate, undefined);
});

test('deleting one event keeps the draft scheduled when another scheduled event remains', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'scheduled', scheduledDate: '2026-11-10T10:00:00' })];
  const events = [
    makeEvent('e1', 'd1', { date: '2026-11-10', time: '10:00' }),
    makeEvent('e2', 'd1', { date: '2026-11-12', time: '15:00' }),
  ];

  const result = syncDeleteCalendarEvent({ drafts, calendarEvents: events, targetEventId: 'e1' });

  const d1 = result.drafts.find(d => d.id === 'd1');
  // OLD BUG: draft reset to ready even though e2 is still scheduled.
  assert.equal(d1?.status, 'scheduled');
  assert.equal(d1?.scheduledDate, '2026-11-12T15:00:00');
});

test('deleting a standalone event leaves drafts untouched', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'draft' })];
  const events = [makeEvent('e1', undefined)];
  const result = syncDeleteCalendarEvent({ drafts, calendarEvents: events, targetEventId: 'e1' });
  assert.equal(result.drafts, drafts);
  assert.equal(result.calendarEvents.length, 0);
});

// ---------- recomputeDraftScheduleState (D-3) ----------

test('recompute picks the earliest scheduled event for scheduledDate', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'draft' })];
  const events = [
    makeEvent('e1', 'd1', { date: '2026-11-12', time: '15:00' }),
    makeEvent('e2', 'd1', { date: '2026-11-10', time: '08:00', status: 'scheduled' }),
  ];
  const updated = recomputeDraftScheduleState({ drafts, calendarEvents: events, draftId: 'd1' });
  const d1 = updated.find(d => d.id === 'd1');
  assert.equal(d1?.status, 'scheduled');
  assert.equal(d1?.scheduledDate, '2026-11-10T08:00:00');
});

test('recompute marks draft ready when only draft-status events remain', () => {
  const drafts = [makeDraft('d1', 'b1', { status: 'scheduled', scheduledDate: '2026-11-10T10:00:00' })];
  const events = [makeEvent('e1', 'd1', { status: 'draft' })];
  const updated = recomputeDraftScheduleState({ drafts, calendarEvents: events, draftId: 'd1' });
  const d1 = updated.find(d => d.id === 'd1');
  assert.equal(d1?.status, 'ready');
  assert.equal(d1?.scheduledDate, undefined);
});

// ---------- Upcoming event selection (D-6) ----------

test('selectUpcomingEvents filters past events, sorts ascending, and respects the limit', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0); // 2026-11-08 12:00 local
  const events = [
    makeEvent('e-past', undefined, { date: '2026-11-08', time: '09:00' }),   // earlier today
    makeEvent('e-late', undefined, { date: '2026-11-09', time: '20:00' }),
    makeEvent('e-soon', undefined, { date: '2026-11-08', time: '18:00' }),   // later today
    makeEvent('e-far', undefined, { date: '2026-11-20', time: '10:00' }),
  ];
  const upcoming = selectUpcomingEvents(events, now, 2);
  assert.deepEqual(upcoming.map(e => e.id), ['e-soon', 'e-late']);
});

test('selectUpcomingEvents includes events exactly now', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0);
  const events = [makeEvent('e-now', undefined, { date: '2026-11-08', time: '12:00' })];
  assert.equal(selectUpcomingEvents(events, now, 5).length, 1);
});

// ---------- Cascade brand deletion (unchanged behaviour, guarded) ----------

test('cascade delete removes brand, its drafts, related events, and reassigns active', () => {
  const brands = [makeBrand('b1'), makeBrand('b2')];
  const drafts = [makeDraft('d1', 'b1'), makeDraft('d2', 'b2')];
  const events = [makeEvent('e1', 'd1', { brandId: 'b1' }), makeEvent('e2', 'd2', { brandId: 'b2' })];

  const result = cascadeDeleteBrand({ brands, drafts, calendarEvents: events, activeBrandId: 'b1', targetBrandId: 'b1' });

  assert.equal(result.brands.length, 1);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.calendarEvents.length, 1);
  assert.equal(result.activeBrandId, 'b2');
});

test('cascade delete refuses to remove the last remaining brand', () => {
  const brands = [makeBrand('b1')];
  const result = cascadeDeleteBrand({ brands, drafts: [], calendarEvents: [], activeBrandId: 'b1', targetBrandId: 'b1' });
  assert.equal(result.brands.length, 1);
});

// ---------- ID generation (D-5) ----------

test('generated ids are unique even within the same millisecond', () => {
  const a = generateEntityId('event');
  const b = generateEntityId('event');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('event-'));
});
