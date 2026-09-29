import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(packageRoot, 'vitest-event-loop-watchdog.mjs');
const setupPath = path.join(packageRoot, 'vitest.event-loop-watchdog.setup.mjs');
const vitestBin = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');

interface ProbeResult {
  code: number | null;
  elapsedMs: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd = packageRoot): Promise<ProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code, elapsedMs: Date.now() - startedAt, signal, stderr, stdout });
    });
  });
}

// Budgets are generous on purpose: a heartbeat every 100 ms against a 1 s stall
// leaves nine missed ticks before a kill, so a loaded runner cannot fake a stall.
function probe(body: string, env: NodeJS.ProcessEnv = {}): Promise<ProbeResult> {
  const source = `import { startEventLoopWatchdog } from ${JSON.stringify(modulePath)};\n${body}`;
  return run(['--input-type=module', '-e', source], {
    BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS: '1000',
    ...env,
  });
}

describe('vitest event-loop watchdog', () => {
  it('kills a worker whose event loop is blocked and names the running test', async () => {
    const result = await probe(`
      const watchdog = startEventLoopWatchdog({ heartbeatMs: 100 });
      watchdog.setLabel('probe.test.ts › spins in PGlite');
      const end = Date.now() + 15_000;
      while (Date.now() < end) { /* blocked event loop */ }
    `);

    expect(result.signal).toBe('SIGKILL');
    expect(result.elapsedMs).toBeLessThan(10_000);
    expect(result.stderr).toContain('event loop blocked');
    expect(result.stderr).toContain('probe.test.ts › spins in PGlite');
  });

  it('lets a responsive worker finish and exit on its own', async () => {
    const result = await probe(`
      startEventLoopWatchdog({ heartbeatMs: 100 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    `);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('event loop blocked');
  });

  it('does not start under an attached inspector and says so', async () => {
    const result = await probe(
      `
      startEventLoopWatchdog({ heartbeatMs: 100 });
      const end = Date.now() + 2_500;
      while (Date.now() < end) { /* a paused debugger looks exactly like this */ }
    `,
      { NODE_OPTIONS: '--inspect=0' }
    );

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('inspector attached; watchdog not started');
    expect(result.stderr).not.toContain('event loop blocked');
  });

  it('refuses budgets the heartbeat cannot satisfy or that are not positive integers', async () => {
    const impossible = await probe('startEventLoopWatchdog({ heartbeatMs: 1000 });');
    expect(impossible.code).toBe(1);
    expect(impossible.stderr).toContain('must be shorter than stallMs');

    const impossibleWhileDebugging = await probe('startEventLoopWatchdog({ heartbeatMs: 1000 });', {
      NODE_OPTIONS: '--inspect=0',
    });
    expect(impossibleWhileDebugging.code).toBe(1);
    expect(impossibleWhileDebugging.stderr).toContain('must be shorter than stallMs');

    const invalid = await probe('startEventLoopWatchdog({ stallMs: Number.NaN });');
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('stallMs must be a positive integer');
  });

  it('runs one watchdog per vitest worker across files without a spurious kill, and kills a blocking file by name', async () => {
    // Inside the package so the fixture's `import 'vitest'` resolves; removed in finally.
    const dir = mkdtempSync(path.join(packageRoot, '.watchdog-fixture-'));
    const configFor = (name: string, options: string): string => {
      const file = path.join(dir, name);
      writeFileSync(
        file,
        `export default { test: { include: ['*.test.mjs'], ${options}, setupFiles: [${JSON.stringify(setupPath)}], testTimeout: 40_000 } };\n`
      );
      return file;
    };
    const runVitest = (config: string, files: string[]): Promise<ProbeResult> =>
      run(
        [vitestBin, 'run', '--root', dir, '--config', config, '--no-file-parallelism', ...files],
        {
          // The setup file heartbeats every second; an 8 s fixture budget leaves
          // seven missed ticks before a kill, so a loaded runner cannot fake a
          // stall in the green runs.
          BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS: '8000',
        }
      );
    try {
      const healthy = `import { it } from 'vitest';\nit('waits', async () => { await new Promise((r) => setTimeout(r, 1_200)); });\n`;
      writeFileSync(path.join(dir, 'a.test.mjs'), healthy);
      writeFileSync(path.join(dir, 'b.test.mjs'), healthy);
      writeFileSync(
        path.join(dir, 'c.test.mjs'),
        `import { it } from 'vitest';\nit('spins like PGlite', () => { const end = Date.now() + 30_000; while (Date.now() < end) {} });\n`
      );

      // Isolated forks: every file is a fresh process with a fresh watchdog.
      const isolatedForks = configFor('forks.config.mjs', "pool: 'forks'");
      const green = await runVitest(isolatedForks, ['a.test.mjs', 'b.test.mjs']);
      expect(green.stderr).not.toContain('event loop blocked');
      expect(green.code, `${green.stdout}\n${green.stderr}`).toBe(0);

      // A REUSED worker: `isolate: false` runs both files in one process, so the
      // second file's setup finds the registry entry the first created and must
      // neither start a second watchdog nor kill the healthy worker across the
      // `afterAll` → 'between test files' → `beforeEach` label handoff.
      const reusedForks = configFor('reused.config.mjs', "isolate: false, pool: 'forks'");
      const reused = await runVitest(reusedForks, ['a.test.mjs', 'b.test.mjs']);
      expect(reused.stderr).not.toContain('event loop blocked');
      expect(reused.code, `${reused.stdout}\n${reused.stderr}`).toBe(0);

      // Forks lane: the child dies, the vitest process survives and fails.
      const red = await runVitest(isolatedForks, ['c.test.mjs']);
      expect(red.stderr).toContain('event loop blocked');
      expect(red.stderr).toContain('c.test.mjs › spins like PGlite');
      expect(red.code).not.toBe(0);
      expect(red.elapsedMs).toBeLessThan(30_000);

      // Threads lane: the vitest worker is a thread of the vitest process, so
      // the kill takes the whole run; the stderr line is still the attribution.
      const threads = configFor('threads.config.mjs', "pool: 'threads'");
      const redThreads = await runVitest(threads, ['c.test.mjs']);
      expect(redThreads.stderr).toContain('event loop blocked');
      expect(redThreads.stderr).toContain('c.test.mjs › spins like PGlite');
      expect(redThreads.code).not.toBe(0);
      expect(redThreads.elapsedMs).toBeLessThan(30_000);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 120_000);
});
