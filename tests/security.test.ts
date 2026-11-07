/**
 * Automated Security & Validation Test Suite for OMNI CHANNEL PLUS
 *
 * Covers:
 * 1. Missing topic
 * 2. Empty topic
 * 3. Oversized topic (> 300 chars)
 * 4. Invalid platform
 * 5. Null brandVoice
 * 6. Null language
 * 7. Null objective
 * 8. Excessive generation requests (rate limiting - 10 req/min)
 * 9. Excessive AI status probes (rate limiting - 15 req/min)
 * 10. AI status caching within 60-second TTL
 * 11. Missing/unconfigured Gemini key behavior
 * 12. Valid fallback response generation & schema compliance
 * 13. Numeric TRUST_PROXY_HOPS resolution and rejection of boolean true
 */
import { resolveTrustProxyHops } from '../src/utils/proxy';

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

async function runAllTests() {
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
    process.exit(1);
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

  if (totalPassed !== results.length) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
