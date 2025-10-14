import { createBrowserEmbeddingQueue, type QueueAdapter } from '@brainstrike/queue';

const singletonQueue: QueueAdapter = createBrowserEmbeddingQueue({
  worker: {
    name: 'desktop-renderer-embedding',
  },
});

export const embeddingQueue: QueueAdapter = singletonQueue;

export function getEmbeddingQueue(): QueueAdapter {
  return singletonQueue;
}

export { createBrowserEmbeddingQueue };
