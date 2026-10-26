// Export API key validation utilities
export {
  type ApiKeyValidationResult,
  type ApiKeyValidationUnavailableReason,
  checkApiKeyAvailability,
  getApiKeyConfigInstructions,
  requiresApiKey,
} from './api-key-validation.ts';
export {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from './embedding-math.ts';
export type {
  EmbeddingSetCreateParams,
  EmbeddingSetValidationError,
} from './embedding-set-validation.ts';
// Export embedding set validation utilities (BST-168)
export {
  createEmbeddingSetParamsFromMetadata,
  isProviderCompatibleWithSet,
  validateEmbeddingDimensions,
  validateEmbeddingSetParams,
} from './embedding-set-validation.ts';
// Export provider abstraction (Phase 2)
export { EmbeddingProviderFactory } from './factory.ts';
export type { IEmbeddingProvider } from './interfaces/provider.ts';
// Export model dimension helpers
export { isValidDimension, validateDimensions } from './model-dimensions.ts';
export * from './provider-core.ts';
export type { ModelConfig, SimilarityResult } from './types.ts';
