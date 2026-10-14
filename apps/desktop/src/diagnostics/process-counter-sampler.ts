import type { ProcessCounterRing } from './process-counter-ring';
import type { WebAssemblyCounter } from './webassembly-counter';

/** Process observations remain memory-only; desktop has no legacy PG background-task queue. */
export function createProcessCounterSampler({
  counter,
  ring,
}: {
  readonly counter: WebAssemblyCounter;
  readonly ring: ProcessCounterRing;
}): { sample(mem: NodeJS.MemoryUsage): Promise<void>; stop(): void } {
  let stopped = false;
  return {
    sample: async (mem) => {
      if (stopped) {
        return;
      }
      const wasm = counter.snapshot();
      ring.push({
        at: new Date().toISOString(),
        backgroundTasks: null,
        backgroundTasksUnavailableReason:
          'Legacy database background-task queue is not part of the desktop runtime.',
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
