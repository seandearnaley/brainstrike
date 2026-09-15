import type { DatabaseWorkRunOptions } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { ProcessCounterRing } from '../../diagnostics/process-counter-ring';
import {
  createProcessCounterSampler,
  type ProcessCounterDatabase,
} from '../../diagnostics/process-counter-sampler';
import type { WebAssemblyCounter } from '../../diagnostics/webassembly-counter';

const MEMORY = { heapUsed: 2048, rss: 4096 } as NodeJS.MemoryUsage;

const counter: WebAssemblyCounter = {
  snapshot: () => ({
    counts: { compile: 0, failures: 0, instance: 0, instantiate: 0, memory: 0 },
    installedAt: '2026-09-15T02:00:00.000Z',
    recentFailures: [],
  }),
};

function createHarness(refusal?: Error) {
  const events: string[] = [];
  const database: ProcessCounterDatabase = {
    query: <TRecord>() => {
      events.push('query');
      return Promise.resolve({
        rows: [
          { count: 2, status: 'running' },
          { count: 1, status: 'suspended' },
        ] as unknown as TRecord[],
      });
    },
  };
  const getDatabase = vi.fn(() => {
    events.push('getDatabase');
    return Promise.resolve(database);
  });
  const runScheduledWork = async <T>(
    options: DatabaseWorkRunOptions,
    operation: () => Promise<T>
  ): Promise<T> => {
    events.push(`scheduled:${options.priority}:${String(options.label)}`);
    if (refusal) {
      throw refusal;
    }
    const result = await operation();
    events.push('scheduled:done');
    return result;
  };
  const ring = new ProcessCounterRing(4);
  const sampler = createProcessCounterSampler({ counter, getDatabase, ring, runScheduledWork });
  return { events, getDatabase, ring, sampler };
}

describe('createProcessCounterSampler', () => {
  it('reads background task counts only inside background-priority scheduled work', async () => {
    // Scheduled work waits out the factory-reset barrier and joins the
    // shutdown idle drain; a raw DB host read would do neither.
    const { events, ring, sampler } = createHarness();

    await sampler.sample(MEMORY);

    expect(events).toEqual([
      'scheduled:background:process-counter-sample',
      'getDatabase',
      'query',
      'scheduled:done',
    ]);
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: { pending: 0, running: 2, suspended: 1 },
        heapUsedKb: 2,
        rssKb: 4,
      }),
    ]);
  });

  it('records why the counts are unavailable when the scheduler refuses the read', async () => {
    const { events, getDatabase, ring, sampler } = createHarness(
      new Error('database work refused')
    );

    await sampler.sample(MEMORY);

    expect(events).toEqual(['scheduled:background:process-counter-sample']);
    expect(getDatabase).not.toHaveBeenCalled();
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: null,
        backgroundTasksUnavailableReason: 'database work refused',
      }),
    ]);
  });

  it('stop() makes later ticks record nothing and never reach the database', async () => {
    const { events, getDatabase, ring, sampler } = createHarness();

    sampler.stop();
    await sampler.sample(MEMORY);

    expect(events).toEqual([]);
    expect(getDatabase).not.toHaveBeenCalled();
    expect(ring.list()).toEqual([]);
  });
});
