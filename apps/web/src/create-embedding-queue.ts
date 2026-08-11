import { embeddingWorkerTelemetrySink } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';

let singletonQueue: QueueAdapter | null = null;

function registerEmbeddingWorkerRuntime(): string {
  const embeddingWorkerUrl: string = resolveViteEmbeddingWorkerUrlHref();
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
      telemetry: embeddingWorkerTelemetrySink,
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
