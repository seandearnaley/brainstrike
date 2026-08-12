import type {
  EmbedWorkerBatch,
  EmbedWorkerPipelineCacheDiagnostic,
} from '@brainstrike/indexing-contract';
import type { EmbeddingDeviceHint } from './types.js';

export interface WorkerpoolEmbeddingTelemetrySink {
  readonly recordBatch: (sourceId: string, event: EmbedWorkerBatch) => void;
  readonly recordFailure: (reason: string) => void;
  readonly recordPipelineCache: (
    sourceId: string,
    event: EmbedWorkerPipelineCacheDiagnostic
  ) => void;
  readonly removeSource: (sourceId: string) => void;
}

export function assertWorkerpoolEmbeddingTelemetrySink(
  value: unknown
): asserts value is WorkerpoolEmbeddingTelemetrySink {
  if (!(typeof value === 'object' && value !== null)) {
    throw new Error('Workerpool embedding telemetry sink is required.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['recordBatch'] !== 'function' ||
    typeof candidate['recordFailure'] !== 'function' ||
    typeof candidate['recordPipelineCache'] !== 'function' ||
    typeof candidate['removeSource'] !== 'function'
  ) {
    throw new Error(
      'Workerpool embedding telemetry sink requires recordBatch, recordFailure, recordPipelineCache, and removeSource functions.'
    );
  }
}

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
  /**
   * Renderer-owned sink for source-scoped embedding runtime telemetry.
   *
   * Browser workerpools have no compatibility mode without this sink. Renderer
   * composition roots should pass `embeddingWorkerTelemetrySink` from
   * `@brainstrike/embedding-worker`.
   */
  readonly telemetry: WorkerpoolEmbeddingTelemetrySink;
  /** Canonical worker URL supplied by the host app or caller. */
  readonly workerUrl?: string;
}
