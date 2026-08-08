import {
  getRegisteredEmbeddingQueueFactory,
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import type { QueueAdapter } from '@brainstrike/queue';
import { useEffect } from 'react';

export function useEmbeddingQueueRegistration(embeddingQueue: QueueAdapter | null): void {
  useEffect(() => {
    if (!embeddingQueue) {
      return;
    }

    const previousFactory = getRegisteredEmbeddingQueueFactory();
    const queueFactory = () => embeddingQueue;
    registerEmbeddingQueueFactory(queueFactory);

    return () => {
      if (getRegisteredEmbeddingQueueFactory() !== queueFactory) {
        return;
      }
      if (previousFactory) {
        registerEmbeddingQueueFactory(previousFactory);
        return;
      }
      resetEmbeddingQueueFactory();
    };
  }, [embeddingQueue]);
}
