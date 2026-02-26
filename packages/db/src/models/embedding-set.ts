export type EmbeddingDistance = 'cosine' | 'l2' | 'ip';

export interface EmbeddingSet {
  category?: string;
  createdAt: string;
  description?: string;
  dimensions: number;
  distance: EmbeddingDistance;
  id: string;
  modelId: string;
  modelKey: string;
  // User-facing metadata (added in migration 011)
  name?: string;
  tags?: string; // Stored as comma-separated string in DB
}
