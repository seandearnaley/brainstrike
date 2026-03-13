import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';
import { resolveEmbeddingWorkerUrlHref } from './resolve-embedding-worker-url';

let singletonQueue: QueueAdapter | null = null;

function createSingletonQueue(): QueueAdapter {
  const embeddingWorkerUrl: string = resolveEmbeddingWorkerUrlHref();
  registerEmbeddingRuntimeConfig({
    streamingWorkerUrl: embeddingWorkerUrl,
  });

  const queue: QueueAdapter = createBrowserEmbeddingQueue({
    requireWorkerpool: true,
    worker: {
      name: 'desktop-renderer-embedding',
      workerUrl: embeddingWorkerUrl,
    },
  });

  // Register the canonical renderer queue only after it exists so lazy queue
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
