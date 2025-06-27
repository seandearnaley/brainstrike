// Export types and interfaces
export type {
  EmbeddingService,
  EmbeddingResult,
  EmbeddingConfig,
  SimilarityResult,
  EmbeddingStatus,
  EmbeddingProgress,
  RetrievalMode,
} from './types';

// Export error class
export { EmbeddingError } from './types';

// Export configuration constants
export { BGE_M3_CONFIG, FALLBACK_MODEL_CONFIG } from './types';

// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service';

// Export React component (will be created separately)
// export { EmbeddingPanel } from './embedding-panel';
