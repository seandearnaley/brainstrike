import { MASTRA_BACKGROUND_TASKS_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { DatabaseWorkRunOptions } from '@brainstrike/db';
import type { ProcessCounterRing, ProcessCounterSample } from './process-counter-ring';
import type { WebAssemblyCounter } from './webassembly-counter';

/** The one database call the sampler makes (the DB host's `RemoteDbClient` in main). */
export interface ProcessCounterDatabase {
  readonly query: <TRecord>(sql: string) => Promise<{ readonly rows: readonly TRecord[] }>;
}

/**
 * The count is ordinary background-lane database work, never a raw DB host
 * call: scheduled work waits out the factory-reset barrier (so a tick cannot
 * reopen the database while reset replaces the profile) and is joined by the
 * shutdown idle drain.
 */
export const PROCESS_COUNTER_SAMPLE_WORK_OPTIONS: DatabaseWorkRunOptions = {
  label: 'process-counter-sample',
  priority: 'background',
};

const PENDING_SAMPLE_REASON = 'previous sample still pending';

export interface ProcessCounterSamplerDependencies {
  readonly counter: WebAssemblyCounter;
  readonly getDatabase: () => Promise<ProcessCounterDatabase>;
  readonly ring: ProcessCounterRing;
  readonly runScheduledWork: <T>(
    options: DatabaseWorkRunOptions,
    operation: () => Promise<T>
  ) => Promise<T>;
}

export interface ProcessCounterSampler {
  /**
   * One `main-process-health` sample. The database read is deliberately kept
   * OFF the health line's own path: that line must be logged unconditionally
   * (its absence is the freeze signal), so it carries this tick's WebAssembly
   * counts plus the LAST completed background-task count, never an await.
   *
   * At most ONE read is outstanding: a tick arriving while the previous read
   * is still queued records `previous sample still pending` instead of
   * submitting another, so a long factory reset cannot build a backlog that
   * lands at once and evicts real history from the ring.
   */
  sample(mem: NodeJS.MemoryUsage): Promise<void>;
  /**
   * Shutdown: later ticks record nothing and never submit a read, and a read
   * already in flight records nothing when it finishes. Call it before the
   * scheduler idle join so a sample already submitted is drained.
   */
  stop(): void;
}

export function createProcessCounterSampler({
  counter,
  getDatabase,
  ring,
  runScheduledWork,
}: ProcessCounterSamplerDependencies): ProcessCounterSampler {
  let pending = false;
  let stopped = false;
  return {
    sample: async (mem) => {
      if (stopped) {
        return;
      }
      const wasm = counter.snapshot();
      let backgroundTasks: ProcessCounterSample['backgroundTasks'] = null;
      let backgroundTasksUnavailableReason: string | undefined;
      if (pending) {
        backgroundTasksUnavailableReason = PENDING_SAMPLE_REASON;
      } else {
        pending = true;
        try {
          const rows = await runScheduledWork(PROCESS_COUNTER_SAMPLE_WORK_OPTIONS, async () => {
            const db = await getDatabase();
            return (
              await db.query<{ count: number; status: 'pending' | 'running' | 'suspended' }>(
                `SELECT status, COUNT(*)::int AS count FROM ${MASTRA_BACKGROUND_TASKS_TABLE}
         WHERE status IN ('pending', 'running', 'suspended') GROUP BY status`
              )
            ).rows;
          });
          const counts = { pending: 0, running: 0, suspended: 0 };
          for (const row of rows) {
            counts[row.status] = row.count;
          }
          backgroundTasks = counts;
        } catch (error) {
          backgroundTasksUnavailableReason = error instanceof Error ? error.message : String(error);
        } finally {
          pending = false;
        }
      }
      if (stopped) {
        // Shutdown landed while this read was in flight.
        return;
      }
      ring.push({
        at: new Date().toISOString(),
        backgroundTasks,
        ...(backgroundTasksUnavailableReason === undefined
          ? {}
          : { backgroundTasksUnavailableReason }),
        heapUsedKb: Math.round(mem.heapUsed / 1024),
        rssKb: Math.round(mem.rss / 1024),
        wasm: wasm.counts,
        wasmRecentFailures: wasm.recentFailures,
      });
    },
    stop: () => {
      stopped = true;
    },
  };
}
