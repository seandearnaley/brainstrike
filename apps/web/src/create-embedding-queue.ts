import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';
import { resolveEmbeddingWorkerUrlHref } from './resolve-embedding-worker-url';

let singletonQueue: QueueAdapter | null = null;

function registerEmbeddingWorkerRuntime(): string {
  const embeddingWorkerUrl: string = resolveEmbeddingWorkerUrlHref();
  registerEmbeddingRuntimeConfig({
    streamingWorkerUrl: embeddingWorkerUrl,
  });
  return embeddingWorkerUrl;
}

export function registerWebEmbeddingRuntimeConfig(): void {
  registerEmbeddingWorkerRuntime();
  registerEmbeddingQueueFactory(() => getEmbeddingQueue());
}

function createSingletonQueue(): QueueAdapter {
  const embeddingWorkerUrl = registerEmbeddingWorkerRuntime();

  const queue: QueueAdapter = createBrowserEmbeddingQueue({
    requireWorkerpool: true,
    worker: {
      workerUrl: embeddingWorkerUrl,
    },
  });

  // Register the canonical app queue only after it exists so lazy queue
  // consumers never observe a half-initialized bootstrap module.
  registerEmbeddingQueueFactory(() => queue);
  return queue;
}

export function getEmbeddingQueue(): QueueAdapter {
  if (singletonQueue) {
    return singletonQueue;
  }
  singletonQueue = createSingletonQueue();
  return singletonQueue;
}

export { createBrowserEmbeddingQueue };
