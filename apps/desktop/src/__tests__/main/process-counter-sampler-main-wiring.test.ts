import { describe, expect, it, vi } from 'vitest';
import { ProcessCounterRing } from '../../diagnostics/process-counter-ring';
import { createProcessCounterSampler } from '../../diagnostics/process-counter-sampler';
import { installWebAssemblyCounter } from '../../diagnostics/webassembly-counter';
import {
  createDesktopGracefulShutdown,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';

vi.mock('../../db-main', () => {
  throw new Error('Process observations must not acquire PostgreSQL');
});

function createObservation() {
  const target = Object.create(WebAssembly) as typeof WebAssembly;
  const counter = installWebAssemblyCounter(target);
  const ring = new ProcessCounterRing(3);
  const sampler = createProcessCounterSampler({ counter, ring });
  return { counter, ring, sampler, target };
}

describe('Main process sampler owner composition', () => {
  it('starts with real process and WASM observations while the retired queue stays explicitly unavailable', async () => {
    const { target, counter, ring, sampler } = createObservation();
    await target.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const memory = process.memoryUsage();
    await sampler.sample(memory);
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: null,
        backgroundTasksUnavailableReason: expect.any(String),
        heapUsedKb: Math.round(memory.heapUsed / 1024),
        rssKb: Math.round(memory.rss / 1024),
        wasm: counter.snapshot().counts,
      }),
    ]);
    expect(counter.snapshot().counts.instantiate).toBe(1);
    sampler.stop();
  });

  it.each([false, true])(
    'stops publication before physical shutdown joins, including preceding owner failure=%s',
    async (failEarlierOwner) => {
      const { ring, sampler } = createObservation();
      await sampler.sample(process.memoryUsage());
      const retained = ring.list();
      const enteredClose = Promise.withResolvers<void>();
      const releaseClose = Promise.withResolvers<void>();
      const exit = vi.fn();
      const closeLog = vi.fn();
      const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const steps: Record<DesktopShutdownStepName, DesktopShutdownStepRun> = {
        'child-processes': () => {},
        'chunking-host': () => {},
        'database-drain': () => {},
        'embedding-host': () => {},
        'factory-reset': () => {},
        'file-system': () => {},
        forge: () => {},
        'git-inventory': () => {},
        'llm-host': () => {},
        'mcp-runtime': () => {},
        'native-index': () => {},
        'parser-host': () => {},
        renderers: () => {},
      };
      steps['native-index'] = () => {
        if (failEarlierOwner) {
          throw new Error('Recorded native owner retirement failure');
        }
      };
      steps['database-drain'] = () => sampler.stop();
      const shutdown = createDesktopGracefulShutdown({
        deadlineMs: 5000,
        exitProcess: exit,
        logger,
        markShuttingDown: vi.fn(),
        planRun: () => ({
          closeDatabase: async () => {
            enteredClose.resolve();
            await releaseClose.promise;
          },
          closeErrorLogSink: closeLog,
          steps,
        }),
        retireBackgroundAdmission: vi.fn(),
      });
      const closing = shutdown.run('before-quit', 'before-quit');
      try {
        await enteredClose.promise;
        await sampler.sample(process.memoryUsage());
        expect(ring.list()).toEqual(retained);
        expect(closeLog).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
      } finally {
        releaseClose.resolve();
        await closing;
      }
      await sampler.sample(process.memoryUsage());
      expect(ring.list()).toEqual(retained);
      expect(closeLog).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledTimes(failEarlierOwner ? 1 : 0);
    }
  );
});
