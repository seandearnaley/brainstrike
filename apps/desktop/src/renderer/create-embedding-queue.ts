import { embeddingWorkerTelemetrySink } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import {
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';

let singletonQueue: QueueAdapter | null = null;
let retirement: Promise<void> | null = null;

function registerEmbeddingWorkerRuntime(): string {
  const embeddingWorkerUrl: string = resolveViteEmbeddingWorkerUrlHref();
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
      telemetry: embeddingWorkerTelemetrySink,
      workerUrl: embeddingWorkerUrl,
    },
  });

  // Register the canonical renderer queue only after it exists so lazy queue
  // consumers never observe a half-initialized bootstrap module.
  registerEmbeddingQueueFactory(() => getEmbeddingQueue());
  return queue;
}

export function getEmbeddingQueue(): QueueAdapter {
  if (retirement) {
    throw new Error('Embedding queue admission is closed for retirement.');
  }
  if (singletonQueue) {
    return singletonQueue;
  }
  singletonQueue = createSingletonQueue();
  return singletonQueue;
}

/** Retain the first physical join; repeated adapter disposal alone is not a join. */
export function retireEmbeddingQueue(): Promise<void> {
  if (retirement) {
    return retirement;
  }
  const queue = singletonQueue;
  retirement = Promise.resolve().then(async () => {
    if (!queue) {
      return;
    }
    if (!queue.dispose) {
      throw new Error('The renderer embedding queue has no physical disposal capability.');
    }
    await queue.dispose();
  });
  return retirement;
}

/** Only the runtime that has joined its old owner may open a fresh lazy queue. */
export async function reopenEmbeddingQueue(isCurrent: () => boolean): Promise<void> {
  await retirement;
  if (!isCurrent()) {
    return;
  }
  if (retirement) {
    singletonQueue = null;
    retirement = null;
  }
  getEmbeddingQueue();
}

export { createBrowserEmbeddingQueue };
