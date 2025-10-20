import { createLogger } from '@brainstrike/utils';
import { createPQueueAdapter, type PQueueAdapterOptions } from './adapters/browser-pqueue';
import {
  createWorkerpoolAdapter,
  type WorkerpoolAdapterOptions,
} from './adapters/browser-workerpool';
import type { QueueAdapter } from './types';
import { supportsWorkers } from './util';

export type { PQueueAdapterOptions } from './adapters/browser-pqueue';
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
  ProviderDimensionParameter,
  QueueAdapter,
  QueueErrorEvent,
  QueueProgressEvent,
  QueueResult,
  TaskPayload,
} from './types';

const logger = createLogger('EmbeddingQueue');

export type CreateBrowserEmbeddingQueueOptions = {
  readonly preferWorkerpool?: boolean;
  readonly worker?: WorkerpoolAdapterOptions;
  readonly fallback?: PQueueAdapterOptions;
};

export function createBrowserEmbeddingQueue(
  options: CreateBrowserEmbeddingQueueOptions = {}
): QueueAdapter {
  const preferWorkerpool = options.preferWorkerpool ?? true;
  if (preferWorkerpool && supportsWorkers()) {
    try {
      return createWorkerpoolAdapter(options.worker);
    } catch (error) {
      logger.warn('Failed to initialize workerpool adapter, falling back to p-queue', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return createPQueueAdapter(options.fallback);
}

export { createWorkerpoolAdapter, createPQueueAdapter };
