import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';

const singletonQueue: QueueAdapter = createBrowserEmbeddingQueue({
  requireWorkerpool: true,
  worker: {
    name: 'desktop-renderer-embedding',
  },
});

export const embeddingQueue: QueueAdapter = singletonQueue;

export function getEmbeddingQueue(): QueueAdapter {
  return singletonQueue;
}

export { createBrowserEmbeddingQueue };
