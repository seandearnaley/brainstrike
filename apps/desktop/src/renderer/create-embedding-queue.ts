import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings';
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
    name: 'desktop-renderer-embedding',
    workerUrl: embeddingWorkerUrl,
  },
});

// Register the canonical renderer queue immediately so local embedding startup
// does not rely on a later metrics/provider mount to resolve the workerpool.
registerEmbeddingQueueFactory(() => singletonQueue);

export const embeddingQueue: QueueAdapter = singletonQueue;

export function getEmbeddingQueue(): QueueAdapter {
  return singletonQueue;
}

export { createBrowserEmbeddingQueue };
