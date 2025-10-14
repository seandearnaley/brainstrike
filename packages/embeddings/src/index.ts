// Export types and interfaces

// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service';
export {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from './embedding-math';
// Export model registry manager
export { ModelRegistryManager } from './model-registry';
// Export backend and utilities
export {
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
  TransformersBackend,
} from './transformers-backend';
export type {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  ModelConfig,
  ModelRegistry,
  RetrievalMode,
  SimilarityResult,
} from './types';
// Export error class
// Export configuration constants
export { BGE_M3_CONFIG, EmbeddingError, FALLBACK_MODEL_CONFIG } from './types';
export type { EmbeddingWorkerController, EmbeddingWorkerOptions } from './worker/embedding-worker';
// Worker
export { startEmbeddingWorker } from './worker/embedding-worker';
