export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';

export interface EmbeddingSet {
  id: string;
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: EmbeddingDistance;
  createdAt: string;
  // User-facing metadata (added in migration 011)
  name?: string;
  description?: string;
  tags?: string; // Stored as comma-separated string in DB
  category?: string;
}
