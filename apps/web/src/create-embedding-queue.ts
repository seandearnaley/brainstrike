import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';
import { resolveEmbeddingWorkerUrlHref } from './resolve-embedding-worker-url';

const embeddingWorkerUrl: string = resolveEmbeddingWorkerUrlHref();

registerEmbeddingRuntimeConfig({
  streamingWorkerUrl: embeddingWorkerUrl,
});

const singletonQueue: QueueAdapter = createBrowserEmbeddingQueue({
  requireWorkerpool: true,
  worker: {
    workerUrl: embeddingWorkerUrl,
  },
});

// Register the canonical app queue immediately so local embedding startup never
// depends on a later provider mount to discover the browser workerpool.
registerEmbeddingQueueFactory(() => singletonQueue);

export const embeddingQueue: QueueAdapter = singletonQueue;

export function getEmbeddingQueue(): QueueAdapter {
  return singletonQueue;
}

export { createBrowserEmbeddingQueue };
