// Export types and interfaces
export type {
  EmbeddingService,
  EmbeddingResult,
  EmbeddingConfig,
  SimilarityResult,
  EmbeddingStatus,
  EmbeddingProgress,
  RetrievalMode,
  ModelConfig,
  ModelRegistry,
} from './types';

// Export error class
export { EmbeddingError } from './types';

// Export configuration constants
export { BGE_M3_CONFIG, FALLBACK_MODEL_CONFIG } from './types';

// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service';

// Export model registry manager
export { ModelRegistryManager } from './model-registry';

// Export backend and utilities
export { TransformersBackend } from './transformers-backend';
export {
  calculateCosineSimilarity,
  calculateL2Distance,
  calculateDotProduct,
  normalize,
  magnitude,
} from './embedding-math';
