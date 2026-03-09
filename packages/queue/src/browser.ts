import {
  createWorkerpoolAdapter,
  type WorkerpoolAdapterOptions,
} from './adapters/browser-workerpool';
import type { QueueAdapter } from './types';
import { supportsWorkers } from './util';

export type { WorkerpoolAdapterOptions } from './adapters/browser-workerpool';

export interface CreateBrowserEmbeddingQueueOptions {
  /**
   * When true, require a workerpool adapter and throw if unavailable.
   * @deprecated Always true - workers are required. Kept for API compatibility.
   */
  readonly requireWorkerpool?: boolean;
  readonly worker?: WorkerpoolAdapterOptions;
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
