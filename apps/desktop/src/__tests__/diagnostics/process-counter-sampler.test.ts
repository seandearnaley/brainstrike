import { MASTRA_BACKGROUND_TASKS_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
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
/**
 * One row per status the statement selects, so the row -> counts mapping is
 * exercised for EVERY status. Without a `pending` row the asserted
 * `pending: 0` only proves the zero-filled initial counts, not the mapping —
 * and a fixture that covers every status cannot also prove the zero fill, so
 * the absent-status case supplies its own rows below.
 */
const TASK_ROWS = [
  { count: 3, status: 'pending' },
  { count: 2, status: 'running' },
  { count: 1, status: 'suspended' },
] as const;
const EXPECTED_COUNTS = { pending: 3, running: 2, suspended: 1 };
const SCHEDULED = 'scheduled:background:process-counter-sample';

const counter: WebAssemblyCounter = {
  snapshot: () => ({
    counts: { compile: 0, failures: 0, instance: 0, instantiate: 0, memory: 0 },
    installedAt: '2026-09-15T02:00:00.000Z',
    recentFailures: [],
  }),
};

interface TaskRow {
  readonly count: number;
  readonly status: string;
}

/** `gate` holds a submitted read open so a later tick lands mid-flight. */
function createHarness({
  gate,
  refusal,
  rows = TASK_ROWS,
}: {
  gate?: Promise<void>;
  refusal?: Error;
  rows?: readonly TaskRow[];
} = {}) {
  const events: string[] = [];
  const statements: string[] = [];
  const database: ProcessCounterDatabase = {
    query: <TRecord>(sql: string) => {
      events.push('query');
      statements.push(sql);
      return Promise.resolve({ rows: rows as unknown as TRecord[] });
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
  return { events, getDatabase, ring, sampler, statements };
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
        backgroundTasks: EXPECTED_COUNTS,
        heapUsedKb: 2,
        rssKb: 4,
      }),
    ]);
  });

  it('counts unfinished tasks by status, in the native background-task table only', async () => {
    // The harness answers any SQL, so without this the statement itself is
    // unasserted: it could read another table or count finished rows and the
    // mapping tests would still pass.
    const { sampler, statements } = createHarness();

    await sampler.sample(MEMORY);

    expect(statements).toHaveLength(1);
    const sql = (statements[0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain(`FROM ${MASTRA_BACKGROUND_TASKS_TABLE} `);
    // Finished rows must never inflate the health line, and every status the
    // counts expose must be selected — a status dropped here would report 0
    // forever rather than its real backlog.
    expect(sql).toContain("WHERE status IN ('pending', 'running', 'suspended')");
    expect(sql).toContain('GROUP BY status');
  });

  it('reports a status with no row as 0, never a missing count', async () => {
    // `GROUP BY status` returns NO row for a status with no tasks, so the
    // zero-filled counts are the production path: the health line must read 0
    // rather than undefined. The all-statuses fixture above cannot prove this.
    const { ring, sampler } = createHarness({ rows: [{ count: 2, status: 'running' }] });

    await sampler.sample(MEMORY);

    expect(ring.list().at(-1)).toEqual(
      expect.objectContaining({ backgroundTasks: { pending: 0, running: 2, suspended: 0 } })
    );
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
      expect.objectContaining({ backgroundTasks: EXPECTED_COUNTS })
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
