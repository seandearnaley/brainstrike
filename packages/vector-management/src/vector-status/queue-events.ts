import { dispatchQueueDrained } from '@brainstrike/utils/browser-events';

/**
 * Announce that the embedding queue drained. Call sites without an active
 * embedding set id (or with a blank one) dispatch the legacy detail-less form;
 * listeners receive a `null` detail and treat it as "refresh everything".
 */
export function dispatchQueueDrainedEvent(embeddingSetId?: string): void {
  if (embeddingSetId && embeddingSetId.trim().length > 0) {
    dispatchQueueDrained({ embeddingSetId, queue: 'embeddings' });
  } else {
    dispatchQueueDrained();
  }
}
