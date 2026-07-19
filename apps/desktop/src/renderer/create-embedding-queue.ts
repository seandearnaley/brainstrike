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

/**
 * Eager startup registration for the desktop visible renderer (mirrors web's
 * `registerWebEmbeddingRuntimeConfig`): registers the streaming worker URL and
 * a LAZY queue factory so a local-model semantic search can initialize the
 * transformers backend before any database panel has loaded the queue. The
 * workerpool itself is still only constructed on first use.
 */
export function registerDesktopEmbeddingRuntimeConfig(): void {
  registerEmbeddingWorkerRuntime();
  registerEmbeddingQueueFactory(() => getEmbeddingQueue());
}

function createSingletonQueue(): QueueAdapter {
  const embeddingWorkerUrl = registerEmbeddingWorkerRuntime();

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
