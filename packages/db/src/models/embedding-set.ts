export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';

export interface EmbeddingSet {
  id: string;
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: EmbeddingDistance;
  createdAt: string;
}
