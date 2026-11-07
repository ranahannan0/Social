/**
 * Integration Test Runner — isolated, repeatable, cost-safe.
 *
 * Responsibilities (audit item E / handover section 6.E):
 * 1. Spawn a DEDICATED server instance on a dedicated port so tests never
 *    depend on (or pollute) a manually started dev server.
 * 2. Strip GEMINI_API_KEY from the child environment so the paid Gemini API
 *    is never called; every generation response must be the LABELLED local
 *    deterministic fallback. This is asserted by the suite itself.
 * 3. Wait for /api/health readiness with a bounded timeout.
 * 4. Execute tests/security.test.ts against the spawned instance.
 * 5. Always terminate the child process, then exit with the suite's verdict.
 */
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TEST_PORT = process.env.TEST_PORT || '3177';
const TEST_URL = `http://localhost:${TEST_PORT}`;
const HEALTH_TIMEOUT_MS = 45_000;

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      lastError = `health returned ${res.status}`;
    } catch (err: any) {
      lastError = err?.message || 'connection failed';
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms (last error: ${lastError})`);
}

async function main(): Promise<number> {
  // Environment for the spawned server: never inherit a real Gemini key.
  const serverEnv: NodeJS.ProcessEnv = { ...process.env };
  delete serverEnv.GEMINI_API_KEY; // cost control: force labelled local fallback
  serverEnv.PORT = TEST_PORT;
  serverEnv.NODE_ENV = process.env.NODE_ENV || 'development';

  console.log(`[runner] Spawning isolated server on port ${TEST_PORT} (GEMINI_API_KEY stripped)...`);

  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'server.ts')], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLogs = '';
  child.stdout?.on('data', chunk => {
    serverLogs += chunk.toString();
  });
  child.stderr?.on('data', chunk => {
    serverLogs += chunk.toString();
  });

  // Guarantee teardown no matter how this process exits.
  const killChild = () => {
    if (child.pid && !child.killed) {
      child.kill('SIGTERM');
    }
  };
  process.on('exit', killChild);
  process.on('SIGINT', () => {
    killChild();
    process.exit(130);
  });

  try {
    await waitForHealth(TEST_URL, HEALTH_TIMEOUT_MS);
    console.log(`[runner] Server healthy at ${TEST_URL}. Running integration suite...\n`);

    // Set TEST_URL before importing the suite — it reads the env at module load.
    process.env.TEST_URL = TEST_URL;
    const { runAllTests } = await import('./security.test');

    const passed = await runAllTests();
    return passed ? 0 : 1;
  } catch (err: any) {
    console.error('[runner] Integration run failed:', err?.message || err);
    if (serverLogs.trim()) {
      console.error('---- server output (tail) ----');
      console.error(serverLogs.split('\n').slice(-40).join('\n'));
    }
    return 1;
  } finally {
    killChild();
    // Give the child a moment, then force-kill if needed.
    setTimeout(() => {
      if (child.pid && !child.killed) child.kill('SIGKILL');
    }, 2000);
  }
}

main().then(code => {
  process.exit(code);
});
