import type { DatabaseWorkRunOptions } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { ProcessCounterRing } from '../../diagnostics/process-counter-ring';
import {
  createProcessCounterSampler,
  PROCESS_COUNTER_SAMPLE_WORK_OPTIONS,
  type ProcessCounterDatabase,
} from '../../diagnostics/process-counter-sampler';
import type { WebAssemblyCounter } from '../../diagnostics/webassembly-counter';

const MEMORY = { heapUsed: 2048, rss: 4096 } as NodeJS.MemoryUsage;
const SCHEDULED = 'scheduled:background:process-counter-sample';

const counter: WebAssemblyCounter = {
  snapshot: () => ({
    counts: { compile: 0, failures: 0, instance: 0, instantiate: 0, memory: 0 },
    installedAt: '2026-09-15T02:00:00.000Z',
    recentFailures: [],
  }),
};

/** `gate` holds a submitted read open so a later tick lands mid-flight. */
function createHarness({ gate, refusal }: { gate?: Promise<void>; refusal?: Error } = {}) {
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
    if (gate) {
      await gate;
    }
    const result = await operation();
    events.push('scheduled:done');
    return result;
  };
  const ring = new ProcessCounterRing(4);
  const sampler = createProcessCounterSampler({ counter, getDatabase, ring, runScheduledWork });
  return { events, getDatabase, ring, sampler };
}

function createGate(): { gate: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = () => {
      resolve();
    };
  });
  return { gate, open };
}

describe('createProcessCounterSampler', () => {
  it('reads background task counts only inside background-priority scheduled work', async () => {
    // Scheduled work waits out the factory-reset barrier and joins the
    // shutdown idle drain; a raw DB host read would do neither.
    const { events, ring, sampler } = createHarness();

    await sampler.sample(MEMORY);

    expect(events).toEqual([SCHEDULED, 'getDatabase', 'query', 'scheduled:done']);
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: { pending: 0, running: 2, suspended: 1 },
        heapUsedKb: 2,
        rssKb: 4,
      }),
    ]);
  });

  it('submits the sample on the background lane under a stable label', () => {
    expect(PROCESS_COUNTER_SAMPLE_WORK_OPTIONS).toEqual({
      label: 'process-counter-sample',
      priority: 'background',
    });
  });

  it('records why the counts are unavailable when the scheduler refuses the read', async () => {
    const { events, getDatabase, ring, sampler } = createHarness({
      refusal: new Error('database work refused'),
    });

    await sampler.sample(MEMORY);

    expect(events).toEqual([SCHEDULED]);
    expect(getDatabase).not.toHaveBeenCalled();
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: null,
        backgroundTasksUnavailableReason: 'database work refused',
      }),
    ]);
  });

  it('skips the read while the previous sample is still outstanding and records why', async () => {
    // A long factory reset holds background work; queueing a read per tick
    // would land a backlog at once and evict real history from the ring.
    const { gate, open } = createGate();
    const { events, ring, sampler } = createHarness({ gate });

    const first = sampler.sample(MEMORY);
    const skipped = sampler.sample(MEMORY);

    expect(events).toEqual([SCHEDULED]);
    expect(ring.list()).toEqual([
      expect.objectContaining({
        backgroundTasks: null,
        backgroundTasksUnavailableReason: 'previous sample still pending',
      }),
    ]);

    open();
    await Promise.all([first, skipped]);

    expect(ring.list()).toHaveLength(2);
    expect(ring.list().at(-1)).toEqual(
      expect.objectContaining({ backgroundTasks: { pending: 0, running: 2, suspended: 1 } })
    );

    // The guard clears with the sample: the next tick reads again.
    await sampler.sample(MEMORY);
    expect(events.filter((event) => event === 'scheduled:done')).toHaveLength(2);
  });

  it('stop() makes later ticks record nothing and never reach the database', async () => {
    const { events, getDatabase, ring, sampler } = createHarness();

    sampler.stop();
    await sampler.sample(MEMORY);

    expect(events).toEqual([]);
    expect(getDatabase).not.toHaveBeenCalled();
    expect(ring.list()).toEqual([]);
  });

  it('stop() during an in-flight read keeps that finished sample out of the ring', async () => {
    const { gate, open } = createGate();
    const { ring, sampler } = createHarness({ gate });

    const inFlight = sampler.sample(MEMORY);
    sampler.stop();
    open();
    await inFlight;

    expect(ring.list()).toEqual([]);
  });
});
