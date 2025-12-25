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
  /** When true, require a workerpool adapter and throw if unavailable. */
  readonly requireWorkerpool?: boolean;
};

export function createBrowserEmbeddingQueue(
  options: CreateBrowserEmbeddingQueueOptions = {}
): QueueAdapter {
  const preferWorkerpool = options.preferWorkerpool ?? true;
  const requireWorkerpool = options.requireWorkerpool ?? false;
  if (preferWorkerpool && supportsWorkers()) {
    try {
      return createWorkerpoolAdapter(options.worker);
    } catch (error) {
      if (requireWorkerpool) {
        throw error;
      }
      logger.warn('Failed to initialize workerpool adapter, falling back to p-queue', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (requireWorkerpool) {
    throw new Error('Embedding queue requires Web Workers; fallback adapter disabled.');
  }
  return createPQueueAdapter(options.fallback);
}

export { createWorkerpoolAdapter, createPQueueAdapter };
