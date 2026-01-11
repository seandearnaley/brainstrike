import {
  createWorkerpoolAdapter,
  type WorkerpoolAdapterOptions,
} from './adapters/browser-workerpool';
import type { QueueAdapter } from './types';
import { supportsWorkers } from './util';

export type { WorkerpoolAdapterOptions } from './adapters/browser-workerpool';
export {
  initializeQueueTelemetrySink,
  type QueueTelemetryRuntime,
  type QueueTelemetrySink,
  type QueueTelemetrySinkOptions,
} from './remote-telemetry-sink';
export {
  addQueueTelemetryListener,
  createQueueTelemetryAggregator,
  emitQueueTelemetry,
  type QueueTelemetryAdapter,
  type QueueTelemetryEvent,
  type QueueTelemetrySnapshot,
} from './telemetry';
export type {
  // Queue Health Diagnostics (BST-166)
  DurableQueueStats,
  EphemeralQueueMetrics,
  ProviderDimensionParameter,
  QueueAdapter,
  QueueErrorEvent,
  QueueHealthListener,
  QueueHealthMetrics,
  QueueProgressEvent,
  QueueResult,
  TaskPayload,
  // WorkerClient base pattern (BST-165)
  WorkerClient,
  WorkerClientError,
  WorkerClientErrorType,
  WorkerClientState,
  WorkerClientWithTimeout,
  WorkerHealthStatus,
} from './types';
export {
  createTimeoutPromise,
  createWorkerReadyWaiter,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  type WorkerReadyWaiterOptions,
} from './util';

export interface CreateBrowserEmbeddingQueueOptions {
  readonly worker?: WorkerpoolAdapterOptions;
  /**
   * When true, require a workerpool adapter and throw if unavailable.
   * @deprecated Always true - workers are required. Kept for API compatibility.
   */
  readonly requireWorkerpool?: boolean;
}

/**
 * Create a browser embedding queue using Web Workers.
 * Workers are required - this function throws if Web Workers are unavailable.
 */
export function createBrowserEmbeddingQueue(
  options: CreateBrowserEmbeddingQueueOptions = {}
): QueueAdapter {
  if (!supportsWorkers()) {
    throw new Error(
      'Embedding queue requires Web Workers; this environment does not support them.'
    );
  }
  return createWorkerpoolAdapter(options.worker);
}

export { createWorkerpoolAdapter };
