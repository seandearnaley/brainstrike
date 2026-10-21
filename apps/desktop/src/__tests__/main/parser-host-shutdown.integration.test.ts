import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ParserHostParseRequest } from '../../parser-host-shared';

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));

class HeldParserProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

const request: ParserHostParseRequest = {
  content: 'const value = 1;',
  options: { errorRecovery: true, jsx: false, language: 'javascript' },
  requestId: 'held-parser',
};

/** Main's shutdown shape: each step runs until it settles, and a failure never skips the next. */
async function runShutdownSequence(
  steps: readonly { readonly name: string; readonly run: () => unknown }[]
): Promise<{ readonly steps: readonly Record<string, unknown>[] }> {
  const settled: Record<string, unknown>[] = [];
  for (const step of steps) {
    try {
      await step.run();
      settled.push({ outcome: 'succeeded', step: step.name });
    } catch (error) {
      settled.push({ error, outcome: 'failed', step: step.name });
    }
  }
  return { steps: settled };
}

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

it('joins a held parser exit before any later shutdown step runs (ADR-0026 R4)', async () => {
  const host = new HeldParserProcess();
  forkMock.mockReturnValue(host);
  const { ParserHostManager } = await import('../../parser-host-manager');
  const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
  const parse = manager.parse(request);
  const later = vi.fn();
  const running = runShutdownSequence([
    { name: 'parser-host', run: () => manager.stop() },
    { name: 'database', run: later },
  ]);
  await expect(parse).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
  await turns(5);
  expect(host.kill).toHaveBeenCalledTimes(1);
  // The killed utility has not exited yet: nothing after it runs, nothing gives up.
  expect(later).not.toHaveBeenCalled();
  expect(host.listenerCount('exit')).toBe(1);

  host.emit('exit', 0);
  const report = await running;
  expect(report.steps).toEqual([
    expect.objectContaining({ outcome: 'succeeded', step: 'parser-host' }),
    expect.objectContaining({ outcome: 'succeeded', step: 'database' }),
  ]);
  expect(later).toHaveBeenCalledTimes(1);
  expect(host.listenerCount('exit')).toBe(0);
  expect(host.listenerCount('message')).toBe(0);
});

it('reports a failed kill while later shutdown owners proceed and the generation stays owned', async () => {
  const host = new HeldParserProcess();
  host.kill.mockReturnValue(false);
  forkMock.mockReturnValue(host);
  const { ParserHostManager } = await import('../../parser-host-manager');
  const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
  const parse = manager.parse({ ...request, requestId: 'local' });
  const database = vi.fn();
  const errorLog = vi.fn();
  try {
    const report = await runShutdownSequence([
      { name: 'parser-host', run: () => manager.stop() },
      { name: 'database', run: database },
      { name: 'error-log-sink', run: errorLog },
    ]);
    expect(report.steps).toEqual([
      expect.objectContaining({
        error: new Error('parser host could not be stopped'),
        outcome: 'failed',
        step: 'parser-host',
      }),
      expect.objectContaining({ outcome: 'succeeded', step: 'database' }),
      expect.objectContaining({ outcome: 'succeeded', step: 'error-log-sink' }),
    ]);
    expect(database).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    await expect(parse).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
    // A failed kill stays visible and retryable: the generation is still owned.
    expect(host.listenerCount('exit')).toBe(1);
    expect(host.listenerCount('message')).toBe(1);
  } finally {
    host.kill.mockReturnValue(true);
    const retried = manager.stop();
    host.emit('exit', 0);
    await retried;
  }
  expect(host.kill).toHaveBeenCalledTimes(2);
  expect(host.listenerCount('exit')).toBe(0);
  expect(host.listenerCount('message')).toBe(0);
});
