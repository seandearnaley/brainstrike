import type { EmbeddingDeviceHint } from './types';

export interface WorkerpoolAdapterOptions {
  readonly defaultDeviceHint?: EmbeddingDeviceHint;
  readonly maxQueueSize?: number;
  readonly maxWorkers?: number;
  /**
   * Minimum workers to keep alive (default: 1).
   *
   * Prevents repeated WASM/WebGPU model load-unload cycles that cause 300 MB
   * memory spikes. Also ensures workerpool auto-spawns a replacement if a
   * worker crashes (e.g. WebGPU device loss → self.close() in the worker).
   * See: docs/debug-handoff-renderer-crash.md
   */
  readonly minWorkers?: number;
  readonly name?: string;
  /** Canonical worker URL supplied by the host app or caller. */
  readonly workerUrl?: string;
}
