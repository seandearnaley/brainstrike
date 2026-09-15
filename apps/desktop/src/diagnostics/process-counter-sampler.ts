import { MASTRA_BACKGROUND_TASKS_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { ProcessCounterRing, ProcessCounterSample } from './process-counter-ring';
import type { WebAssemblyCounter } from './webassembly-counter';

/** The one database call the sampler makes (the DB host's `RemoteDbClient` in main). */
export interface ProcessCounterDatabase {
  readonly query: <TRecord>(sql: string) => Promise<{ readonly rows: readonly TRecord[] }>;
}

export interface ProcessCounterSamplerDependencies {
  readonly counter: WebAssemblyCounter;
  readonly getDatabase: () => Promise<ProcessCounterDatabase>;
  readonly ring: ProcessCounterRing;
}

export interface ProcessCounterSampler {
  /**
   * One `main-process-health` sample. The database read is deliberately kept
   * OFF the health line's own path: that line must be logged unconditionally
   * (its absence is the freeze signal), so it carries this tick's WebAssembly
   * counts plus the LAST completed background-task count, never an await.
   */
  sample(mem: NodeJS.MemoryUsage): Promise<void>;
}

export function createProcessCounterSampler({
  counter,
  getDatabase,
  ring,
}: ProcessCounterSamplerDependencies): ProcessCounterSampler {
  return {
    sample: async (mem) => {
      const wasm = counter.snapshot();
      let backgroundTasks: ProcessCounterSample['backgroundTasks'] = null;
      let backgroundTasksUnavailableReason: string | undefined;
      try {
        const db = await getDatabase();
        const rows = (
          await db.query<{ count: number; status: 'pending' | 'running' | 'suspended' }>(
            `SELECT status, COUNT(*)::int AS count FROM ${MASTRA_BACKGROUND_TASKS_TABLE}
         WHERE status IN ('pending', 'running', 'suspended') GROUP BY status`
          )
        ).rows;
        const counts = { pending: 0, running: 0, suspended: 0 };
        for (const row of rows) {
          counts[row.status] = row.count;
        }
        backgroundTasks = counts;
      } catch (error) {
        backgroundTasksUnavailableReason = error instanceof Error ? error.message : String(error);
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
  };
}
