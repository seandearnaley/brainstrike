export interface EmbeddingSetEventCollection {
  category: string | null;
  chunkCount: number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  embeddingCount: number;
  fileCount: number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  statsAvailable?: boolean;
  statsLastRefreshedAt?: string | null;
  tags: string | null;
}

export interface EmbeddingSetUpdatedEventDetail {
  collection?: EmbeddingSetEventCollection;
  id: string | null;
  reason: 'created' | 'deleted' | 'selected' | 'updated';
}

export function dispatchEmbeddingSetUpdated(detail: EmbeddingSetUpdatedEventDetail): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<EmbeddingSetUpdatedEventDetail>('brainstrike:embedding-set-updated', { detail })
  );
}
