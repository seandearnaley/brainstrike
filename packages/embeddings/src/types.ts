import type { EmbeddingModelConfig } from '@brainstrike/indexing-contract';

export type ModelConfig = EmbeddingModelConfig;

/**
 * Result of similarity calculation between two embeddings
 */
export interface SimilarityResult {
  /** Distance score (0-2) */
  distance: number;
  /** Method used for calculation */
  method: 'cosine' | 'euclidean' | 'manhattan' | 'l2' | 'dot_product';
  /** Similarity score (0-1) */
  similarity: number;
}
