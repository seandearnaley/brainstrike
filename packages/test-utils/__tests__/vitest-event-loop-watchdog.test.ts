import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'vitest-event-loop-watchdog.mjs'
);

function runProbe(body: string): Promise<{
  code: number | null;
  elapsedMs: number;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const source = `import { startEventLoopWatchdog } from ${JSON.stringify(modulePath)};\n${body}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS: '300' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code, elapsedMs: Date.now() - startedAt, signal, stderr });
    });
  });
}

describe('vitest event-loop watchdog', () => {
  it('kills a worker whose event loop is blocked and names the running test', async () => {
    const result = await runProbe(`
      const watchdog = startEventLoopWatchdog({ heartbeatMs: 50 });
      watchdog.setLabel('probe.test.ts › spins in PGlite');
      const end = Date.now() + 10_000;
      while (Date.now() < end) { /* blocked event loop */ }
    `);

    expect(result.signal).toBe('SIGKILL');
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.stderr).toContain('event loop blocked');
    expect(result.stderr).toContain('probe.test.ts › spins in PGlite');
  });

  it('lets a responsive worker finish and exit on its own', async () => {
    const result = await runProbe(`
      startEventLoopWatchdog({ heartbeatMs: 50 });
      await new Promise((resolve) => setTimeout(resolve, 900));
    `);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('event loop blocked');
  });

  it('refuses a stall budget that the heartbeat cannot satisfy', async () => {
    const result = await runProbe(`
      startEventLoopWatchdog({ heartbeatMs: 300 });
    `);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must be shorter than stallMs');
  });
});
