import type { WebAssemblyCounts, WebAssemblyFailure } from './webassembly-counter';

export interface ProcessCounterBackgroundTasks {
  readonly pending: number;
  readonly running: number;
  readonly suspended: number;
}

export interface ProcessCounterSample {
  readonly at: string;
  /** Null when the count could not be read; the reason then names why. */
  readonly backgroundTasks: ProcessCounterBackgroundTasks | null;
  readonly backgroundTasksUnavailableReason?: string;
  readonly heapUsedKb: number;
  readonly rssKb: number;
  readonly wasm: WebAssemblyCounts;
  readonly wasmRecentFailures: readonly WebAssemblyFailure[];
}

export interface ProcessCounterSnapshot {
  /** When the WebAssembly counter was installed; null only before main's install ran. */
  readonly installedAt: string | null;
  readonly samples: readonly ProcessCounterSample[];
}

/** 2 hours at the 30 s `main-process-health` cadence. */
export const PROCESS_COUNTER_RING_CAPACITY = 240;

/** Bounded, in-memory, newest-last. Cleared by the factory-reset runtime disposer. */
export class ProcessCounterRing {
  private readonly samples: ProcessCounterSample[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `Process counter ring capacity must be a positive integer, got ${String(capacity)}.`
      );
    }
  }

  push(sample: ProcessCounterSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) {
      this.samples.shift();
    }
  }

  list(): ProcessCounterSample[] {
    return [...this.samples];
  }

  clear(): void {
    this.samples.length = 0;
  }
}
