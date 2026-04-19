const QUEUE_DRAINED_EVENT_NAME = 'brainstrike:queue-drained' as const;

export function dispatchQueueDrainedEvent(embeddingSetId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const detail =
    embeddingSetId && embeddingSetId.trim().length > 0
      ? { embeddingSetId, queue: 'embeddings' as const }
      : undefined;

  window.dispatchEvent(
    detail
      ? new CustomEvent(QUEUE_DRAINED_EVENT_NAME, { detail })
      : new CustomEvent(QUEUE_DRAINED_EVENT_NAME)
  );
}
