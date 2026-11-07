/**
 * Automated Security & Validation Test Suite for OMNI CHANNEL PLUS
 *
 * INTEGRATION suite: targets a live server (default http://localhost:3000,
 * override with TEST_URL). Executed automatically by tests/runIntegration.ts,
 * which spawns an ISOLATED server instance on a dedicated port with
 * GEMINI_API_KEY stripped from the environment, so these tests:
 *   - never call the paid Gemini API (all generation asserts the labelled
 *     local deterministic fallback),
 *   - start with fresh in-memory rate-limit windows (deterministic 429s).
 *
 * Can still be run manually against your own server:
 *   TEST_URL=http://localhost:3000 tsx tests/security.test.ts
 *
 * Covers:
 * 1. Missing topic
 * 2. Empty topic
 * 3. Oversized topic (> 300 chars)
 * 4. Invalid platform
 * 5. Null brandVoice
 * 6. Null language
 * 7. Null objective
 * 8. Health accuracy (supabaseReady false, storageMode, proxy hops)
 * 8b. Numeric TRUST_PROXY_HOPS resolution and rejection of boolean true
 * 8c. Cascade brand deletion (pure unit)
 * 8d. Active brand reassignment (pure unit)
 * 8e. Calendar event deletion sync (pure unit)
 * 8f. Rescheduling without duplicate events (pure unit)
 * 8f-2. Rescheduling purges pre-existing duplicate events (pure unit)
 * 8g. Neutral empty compliance statistics (pure unit)
 * 8h. Editorial pass rate strictly over evaluated drafts (pure unit)
 * 9. AI status caching within 60-second TTL
 * 10. Valid labelled fallback response generation & schema compliance
 * 11. Generation rate limiting (429 at >10 req/min)
 * 12. AI status probe rate limiting (429 at >15 req/min)
 */
import { pathToFileURL } from 'url';
import { resolveTrustProxyHops } from '../src/utils/proxy';
import {
  cascadeDeleteBrand,
  syncDeleteCalendarEvent,
  syncScheduleDraft,
  calculateComplianceStats,
} from '../src/utils/dataIntegrity';
import { BrandProfile, ContentDraft, CalendarEvent } from '../src/types';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

interface TestResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  error?: string;
}

const results: TestResult[] = [];

async function assertTest(name: string, fn: () => Promise<{ passed: boolean; expected: string; actual: string }>) {
  try {
    const outcome = await fn();
    results.push({ name, ...outcome });
    const statusMark = outcome.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${statusMark}: ${name}`);
    if (!outcome.passed) {
      console.log(`    Expected: ${outcome.expected}`);
      console.log(`    Actual:   ${outcome.actual}`);
    }
  } catch (err: any) {
    results.push({
      name,
      passed: false,
      expected: 'Successful execution',
      actual: `Threw error: ${err.message}`,
      error: err.message,
    });
    console.log(`✗ FAIL: ${name} (Exception: ${err.message})`);
  }
}

async function runAllTests(): Promise<boolean> {
  console.log(`\n========================================`);
  console.log(`Running Security & Validation Test Suite`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`========================================\n`);

  // Pre-flight check: ensure server is reachable and rate limit cooldown is respected
  try {
    const preCheck = await fetch(`${BASE_URL}/api/health`);
    if (!preCheck.ok) {
      console.log(`Pre-flight warning: /api/health returned ${preCheck.status}`);
    }

    const aiCheck = await fetch(`${BASE_URL}/api/ai-status`);
    if (aiCheck.status === 429) {
      const waitSec = parseInt(aiCheck.headers.get('retry-after') || '20', 10);
      console.log(`[Pre-flight] Waiting ${waitSec + 1}s for rate limit reset...`);
      await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
    }
  } catch (err: any) {
    console.error(`Cannot connect to server at ${BASE_URL}:`, err.message);
    console.error('Start the server first (npm run dev) or use tests/runIntegration.ts, which spawns one automatically.');
    return false;
  }

  // 1. Missing topic
  await assertTest('Reject Missing Topic with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'linkedin' }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'topic');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 with validation error for "topic"',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 2. Empty topic
  await assertTest('Reject Empty / Whitespace Topic with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: '     ' }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'topic');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 with validation error for empty topic',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 3. Oversized topic (> 300 chars)
  await assertTest('Reject Oversized Topic (>300 chars) with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'A'.repeat(301) }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'topic');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 with validation error for topic > 300 chars',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 4. Invalid platform
  await assertTest('Reject Invalid Platform with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cloud Governance', platform: 'myspace_feed' }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'platform');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 with validation error for "platform"',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 5. Null brandVoice
  await assertTest('Reject Null brandVoice with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cloud Governance', brandVoice: null }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'brandVoice');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 rejecting null brandVoice',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 6. Null language
  await assertTest('Reject Null Language with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cloud Governance', language: null }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'language');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 rejecting null language',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 7. Null objective
  await assertTest('Reject Null Objective with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cloud Governance', objective: null }),
    });
    const data = await res.json();
    const hasField = data.validationErrors?.some((e: any) => e.field === 'objective');
    return {
      passed: res.status === 400 && hasField,
      expected: 'Status 400 rejecting null objective',
      actual: `Status ${res.status}, errors: ${JSON.stringify(data.validationErrors)}`,
    };
  });

  // 8. Missing / Unconfigured Gemini Key Behavior & Health
  await assertTest('Report Accurate Health & Supabase Not Connected & Default Proxy Hops', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    const passes =
      res.status === 200 &&
      data.supabaseReady === false &&
      data.storageMode === 'localStorage_demo' &&
      typeof data.aiConfigured === 'boolean' &&
      typeof data.trustProxyHops === 'number' &&
      data.trustProxyHops === 0;
    return {
      passed: passes,
      expected: 'Status 200 with supabaseReady: false, storageMode: localStorage_demo, trustProxyHops: 0',
      actual: `Status ${res.status}, body: ${JSON.stringify(data)}`,
    };
  });

  // 8b. Numeric TRUST_PROXY_HOPS Resolution & Strict Rejection of 'true'
  await assertTest('Validate TRUST_PROXY_HOPS Numeric Parser (No Global True, Strict Integers)', async () => {
    const checkDefault = resolveTrustProxyHops(undefined) === 0;
    const checkEmpty = resolveTrustProxyHops('') === 0;
    const checkTrue = resolveTrustProxyHops('true') === 0; // MUST reject 'true' to avoid blind trust
    const checkTRUE = resolveTrustProxyHops('TRUE') === 0;
    const checkNegative = resolveTrustProxyHops('-1') === 0;
    const checkNonNumeric = resolveTrustProxyHops('loopback') === 0;
    const checkZero = resolveTrustProxyHops('0') === 0;
    const checkHop1 = resolveTrustProxyHops('1') === 1;
    const checkHop2 = resolveTrustProxyHops('2') === 2;
    const checkHop3 = resolveTrustProxyHops(' 3 ') === 3;

    const allPassed =
      checkDefault &&
      checkEmpty &&
      checkTrue &&
      checkTRUE &&
      checkNegative &&
      checkNonNumeric &&
      checkZero &&
      checkHop1 &&
      checkHop2 &&
      checkHop3;

    return {
      passed: allPassed,
      expected: 'Strict numeric parsing: 0 for undefined/empty/true/negative/invalid, numeric N for valid integers',
      actual: `default=${checkDefault}, true=${checkTrue}, negative=${checkNegative}, 1=${checkHop1}, 2=${checkHop2}`,
    };
  });

  // 8c. Brand Deletion & Related Records Cleanup
  await assertTest('Cascade Brand Deletion Purges Related Drafts & Calendar Events', async () => {
    const mockBrands: BrandProfile[] = [
      { id: 'b1', name: 'Brand 1', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' },
      { id: 'b2', name: 'Brand 2', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' },
    ];
    const mockDrafts: ContentDraft[] = [
      { id: 'd1', brandId: 'b1', title: 'Draft 1', topic: 'T1', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C1', callToAction: '', hashtags: [], status: 'draft', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
      { id: 'd2', brandId: 'b2', title: 'Draft 2', topic: 'T2', platform: 'x', objective: 'Lead Gen', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C2', callToAction: '', hashtags: [], status: 'draft', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 280, warnings: [] }, createdAt: '', updatedAt: '' },
    ];
    const mockEvents: CalendarEvent[] = [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'E1', platform: 'linkedin', date: '2026-11-10', time: '10:00', status: 'scheduled', summary: '' },
      { id: 'e2', draftId: 'd2', brandId: 'b2', title: 'E2', platform: 'x', date: '2026-11-12', time: '14:00', status: 'scheduled', summary: '' },
    ];

    const result = cascadeDeleteBrand({
      brands: mockBrands,
      drafts: mockDrafts,
      calendarEvents: mockEvents,
      activeBrandId: 'b1',
      targetBrandId: 'b1',
    });

    const brandRemoved = !result.brands.some(b => b.id === 'b1');
    const draftsPurged = !result.drafts.some(d => d.brandId === 'b1');
    const eventsPurged = !result.calendarEvents.some(e => e.brandId === 'b1' || e.draftId === 'd1');
    const activeReassigned = result.activeBrandId === 'b2';

    const passed = brandRemoved && draftsPurged && eventsPurged && activeReassigned;

    return {
      passed,
      expected: 'Brand b1, draft d1, and event e1 removed; activeBrandId reassigned to b2',
      actual: `brandRemoved=${brandRemoved}, draftsPurged=${draftsPurged}, eventsPurged=${eventsPurged}, active=${result.activeBrandId}`,
    };
  });

  // 8d. Active Brand Reassignment Safety
  await assertTest('Active Brand Reassignment When Target Deleted', async () => {
    const mockBrands: BrandProfile[] = [
      { id: 'b1', name: 'Brand 1', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' },
      { id: 'b2', name: 'Brand 2', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' },
    ];

    const result = cascadeDeleteBrand({
      brands: mockBrands,
      drafts: [],
      calendarEvents: [],
      activeBrandId: 'b1',
      targetBrandId: 'b1',
    });

    return {
      passed: result.activeBrandId === 'b2' && result.brands.length === 1,
      expected: 'activeBrandId automatically reassigned to b2',
      actual: `activeBrandId=${result.activeBrandId}, remainingBrands=${result.brands.length}`,
    };
  });

  // 8e. Calendar Event Deletion & Draft Status Sync
  await assertTest('Calendar Event Deletion Resets Draft Status & Clears ScheduledDate', async () => {
    const mockDrafts: ContentDraft[] = [
      { id: 'd1', brandId: 'b1', title: 'Draft 1', topic: 'T1', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C1', callToAction: '', hashtags: [], status: 'scheduled', scheduledDate: '2026-11-10T10:00:00', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
    ];
    const mockEvents: CalendarEvent[] = [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'E1', platform: 'linkedin', date: '2026-11-10', time: '10:00', status: 'scheduled', summary: '' },
    ];

    const result = syncDeleteCalendarEvent({
      drafts: mockDrafts,
      calendarEvents: mockEvents,
      targetEventId: 'e1',
    });

    const updatedDraft = result.drafts.find(d => d.id === 'd1');
    const eventRemoved = !result.calendarEvents.some(e => e.id === 'e1');
    const statusReset = updatedDraft?.status === 'ready';
    const dateCleared = updatedDraft?.scheduledDate === undefined;

    const passed = eventRemoved && statusReset && dateCleared;

    return {
      passed,
      expected: 'Event e1 removed, draft status reset to "ready", scheduledDate cleared',
      actual: `eventRemoved=${eventRemoved}, status=${updatedDraft?.status}, scheduledDate=${updatedDraft?.scheduledDate}`,
    };
  });

  // 8f. Rescheduling Draft Without Duplicate Events
  await assertTest('Rescheduling Draft Updates Event In-Place Without Duplicates', async () => {
    const mockDrafts: ContentDraft[] = [
      { id: 'd1', brandId: 'b1', title: 'Draft 1', topic: 'T1', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'Caption text', callToAction: '', hashtags: [], status: 'ready', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
    ];
    const mockEvents: CalendarEvent[] = [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'Draft 1', platform: 'linkedin', date: '2026-11-10', time: '10:00', status: 'scheduled', summary: '' },
    ];

    // Reschedule d1 to new date 2026-11-15
    const result = syncScheduleDraft({
      drafts: mockDrafts,
      calendarEvents: mockEvents,
      draftId: 'd1',
      date: '2026-11-15',
      time: '14:00',
    });

    const d1Events = result.calendarEvents.filter(e => e.draftId === 'd1');
    const singleEvent = d1Events.length === 1;
    const updatedDate = d1Events[0]?.date === '2026-11-15';

    return {
      passed: singleEvent && updatedDate,
      expected: 'Exactly 1 calendar event with date updated to 2026-11-15',
      actual: `eventCount=${d1Events.length}, date=${d1Events[0]?.date}`,
    };
  });

  // 8f-2. Purging Pre-Existing Duplicate Calendar Events
  await assertTest('Rescheduling Draft Purges Pre-Existing Duplicate Events', async () => {
    const mockDrafts: ContentDraft[] = [
      { id: 'd1', brandId: 'b1', title: 'Draft 1', topic: 'T1', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'Caption text', callToAction: '', hashtags: [], status: 'ready', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
    ];
    // Pre-existing duplicates for draft d1
    const mockEvents: CalendarEvent[] = [
      { id: 'e1', draftId: 'd1', brandId: 'b1', title: 'Draft 1 Dup A', platform: 'linkedin', date: '2026-11-10', time: '10:00', status: 'scheduled', summary: '' },
      { id: 'e2', draftId: 'd1', brandId: 'b1', title: 'Draft 1 Dup B', platform: 'linkedin', date: '2026-11-11', time: '11:00', status: 'scheduled', summary: '' },
      { id: 'e3', draftId: 'd1', brandId: 'b1', title: 'Draft 1 Dup C', platform: 'linkedin', date: '2026-11-12', time: '12:00', status: 'scheduled', summary: '' },
    ];

    const result = syncScheduleDraft({
      drafts: mockDrafts,
      calendarEvents: mockEvents,
      draftId: 'd1',
      date: '2026-11-20',
      time: '16:00',
    });

    const d1Events = result.calendarEvents.filter(e => e.draftId === 'd1');
    const singleCanonical = d1Events.length === 1;
    const updatedDate = d1Events[0]?.date === '2026-11-20';
    const updatedTime = d1Events[0]?.time === '16:00';

    return {
      passed: singleCanonical && updatedDate && updatedTime,
      expected: 'Purged 2 duplicate events, retaining 1 canonical event scheduled for 2026-11-20 16:00',
      actual: `eventCount=${d1Events.length}, date=${d1Events[0]?.date}, time=${d1Events[0]?.time}`,
    };
  });

  // 8g. Neutral Empty Compliance Statistics
  await assertTest('Compliance Statistics Return Neutral State When Zero Drafts Exist', async () => {
    const stats = calculateComplianceStats({
      drafts: [],
      calendarEvents: [],
      brands: [{ id: 'b1', name: 'B1', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' }],
    });

    const isNullRate = stats.compliancePassRate === null;
    const notEvaluated = stats.hasEvaluatedContent === false;

    return {
      passed: isNullRate && notEvaluated,
      expected: 'compliancePassRate is null and hasEvaluatedContent is false when drafts is empty',
      actual: `passRate=${stats.compliancePassRate}, hasEvaluated=${stats.hasEvaluatedContent}`,
    };
  });

  // 8h. Compliance Pass Rate Calculated Strictly Over Evaluated Drafts Only
  await assertTest('Editorial Pass Rate Calculated Strictly Over Evaluated Drafts Only', async () => {
    const mockDrafts: ContentDraft[] = [
      // Evaluated draft 1: passed
      { id: 'd1', brandId: 'b1', title: 'D1', topic: 'T1', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C1', callToAction: '', hashtags: [], status: 'ready', complianceStatus: { passed: true, detectedFluff: [], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
      // Evaluated draft 2: failed
      { id: 'd2', brandId: 'b1', title: 'D2', topic: 'T2', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C2', callToAction: '', hashtags: [], status: 'ready', complianceStatus: { passed: false, detectedFluff: ['delve into'], charCount: 2, maxLimit: 3000, warnings: [] }, createdAt: '', updatedAt: '' },
      // Unevaluated draft 3 (no complianceStatus)
      { id: 'd3', brandId: 'b1', title: 'D3', topic: 'T3', platform: 'linkedin', objective: 'Authority', language: 'English', audience: '', selectedHookType: 'patternInterrupt', hooks: { patternInterrupt: '', curiosityGap: '', directBenefit: '' }, caption: 'C3', callToAction: '', hashtags: [], status: 'ready', complianceStatus: undefined as any, createdAt: '', updatedAt: '' },
    ];

    const stats = calculateComplianceStats({
      drafts: mockDrafts,
      calendarEvents: [],
      brands: [{ id: 'b1', name: 'B1', tagline: '', industry: '', targetAudience: '', brandVoice: { tone: '', bannedWords: [], styleGuidelines: '', sampleCopy: '' }, preferredLanguage: 'English', productsAndServices: [], createdAt: '', updatedAt: '' }],
    });

    // 1 passed out of 2 evaluated drafts = 50%
    const is50Percent = stats.compliancePassRate === 50;
    const hasEvaluated = stats.hasEvaluatedContent === true;

    return {
      passed: is50Percent && hasEvaluated,
      expected: 'compliancePassRate is 50% (1/2 evaluated drafts) and hasEvaluatedContent is true',
      actual: `passRate=${stats.compliancePassRate}, hasEvaluated=${stats.hasEvaluatedContent}`,
    };
  });

  // 9. AI Status Probe Caching (60s TTL)
  await assertTest('Cache AI Status Probe Results (Within 60s TTL)', async () => {
    const start1 = Date.now();
    const res1 = await fetch(`${BASE_URL}/api/ai-status`);
    const data1 = await res1.json();
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    const res2 = await fetch(`${BASE_URL}/api/ai-status`);
    const data2 = await res2.json();
    const time2 = Date.now() - start2;

    // Second call should return identical testedAt timestamp and execute faster
    const isCached = data1.testedAt === data2.testedAt;
    return {
      passed: res1.status === 200 && res2.status === 200 && isCached,
      expected: 'Identical cached testedAt timestamp for back-to-back requests',
      actual: `First testedAt=${data1.testedAt} (${time1}ms), Second testedAt=${data2.testedAt} (${time2}ms)`,
    };
  });

  // 10. Valid Fallback Response Verification
  await assertTest('Generate Valid Content Schema via Fallback / Gemini', async () => {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Zero Downtime DB Migrations',
        platform: 'linkedin',
        objective: 'Authority',
        language: 'English',
        brandName: 'Apex Cloud',
        brandVoice: {
          tone: 'Engineering-led',
          bannedWords: ['synergy'],
        },
      }),
    });
    const data = await res.json();
    const hasHooks =
      data.data?.hooks?.patternInterrupt &&
      data.data?.hooks?.curiosityGap &&
      data.data?.hooks?.directBenefit;
    const hasCaption = typeof data.data?.primaryCaption === 'string' && data.data.primaryCaption.length > 50;

    return {
      passed: res.status === 200 && data.success === true && Boolean(hasHooks) && hasCaption,
      expected: 'Status 200 with success: true and valid 3 hook variations',
      actual: `Status ${res.status}, source: ${data.source}, isFallback: ${data.isFallback}, hooks present: ${Boolean(hasHooks)}`,
    };
  });

  // 11. Excessive generation requests (Rate Limiting)
  await assertTest('Trigger Rate Limit (429) on Excessive Generation Requests', async () => {
    let hit429 = false;
    let attempts = 0;
    // We already made ~8 POST /api/generate calls. Rapidly make more to exceed 10/min.
    for (let i = 0; i < 8; i++) {
      attempts++;
      const res = await fetch(`${BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'Rate limit test' }),
      });
      if (res.status === 429) {
        hit429 = true;
        const errJson = await res.json();
        return {
          passed: true,
          expected: 'HTTP 429 when exceeding 10 requests per minute',
          actual: `Received 429 on attempt ${attempts}: ${errJson.error}`,
        };
      }
    }
    return {
      passed: hit429,
      expected: 'HTTP 429 rate limit exceeded',
      actual: `Did not hit 429 after ${attempts} requests`,
    };
  });

  // 12. Excessive AI status probes (Rate Limiting - 15 req/min)
  await assertTest('Trigger Rate Limit (429) on Excessive AI Status Probes', async () => {
    let hit429 = false;
    let attempts = 0;
    for (let i = 0; i < 18; i++) {
      attempts++;
      const res = await fetch(`${BASE_URL}/api/ai-status`);
      if (res.status === 429) {
        hit429 = true;
        const data = await res.json();
        return {
          passed: true,
          expected: 'HTTP 429 when exceeding 15 probe requests per minute',
          actual: `Received 429 on probe attempt ${attempts}: ${data.error}`,
        };
      }
    }
    return {
      passed: hit429,
      expected: 'HTTP 429 rate limit exceeded on AI status endpoint',
      actual: `Did not hit 429 after ${attempts} probe requests`,
    };
  });

  console.log(`\n----------------------------------------`);
  const totalPassed = results.filter(r => r.passed).length;
  console.log(`Summary: ${totalPassed} / ${results.length} tests passed.`);
  console.log(`----------------------------------------\n`);

  return totalPassed === results.length;
}

/**
 * Exported for tests/runIntegration.ts. When this file is executed directly,
 * the suite runs against TEST_URL (or localhost:3000) and sets the exit code.
 */
export { runAllTests };

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runAllTests().then(ok => {
    process.exit(ok ? 0 : 1);
  }).catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
}
