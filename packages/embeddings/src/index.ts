// Export types and interfaces

// Re-export power broadcast channel name for renderer ↔ worker coordination
export {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingPipelineCacheTelemetryEntry,
  type EmbeddingTelemetrySnapshot,
  getEmbeddingTelemetrySnapshot,
  POWER_BROADCAST_CHANNEL,
  subscribeEmbeddingTelemetry,
  subscribeEmbeddingTelemetryThrottled,
} from '@brainstrike/embedding-worker';
// Export API key validation utilities
export {
  type ApiKeyValidationResult,
  type ApiKeyValidationUnavailableReason,
  checkApiKeyAvailability,
  getApiKeyConfigInstructions,
  requiresApiKey,
} from './api-key-validation.ts';
// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service.ts';
// Export device detection utilities (BST-169)
export type {
  DeviceCapabilities,
  DeviceUnavailableGuidance,
  EmbeddingDeviceType,
  WebGPUAdapterInfo,
} from './device-detection.ts';
export {
  clearDeviceCapabilitiesCache,
  detectDeviceCapabilities,
  formatDeviceCapabilitiesSummary,
  getCachedDeviceCapabilities,
  getDeviceUnavailableGuidance,
  isDeviceAvailable,
  validateDeviceOrThrow,
} from './device-detection.ts';
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
export type {
  IEmbeddingProvider,
  IHostedEmbeddingProvider,
  ILocalEmbeddingProvider,
} from './interfaces/provider.ts';
// Export model dimension helpers
export { isValidDimension, validateDimensions } from './model-dimensions.ts';
export { parseModelSizeEstimateBytes } from './model-size-estimate.ts';
export * from './provider-core.ts';
export type {
  DistanceMetric,
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderType,
  EmbeddingRuntime,
  HostedProviderType,
  LocalProviderType,
  ProviderMetadata,
  Result,
} from './provider-types.ts';
export {
  hostedProviderRequiresApiKey,
  isLocalProviderType,
  STANDARD_EMBEDDING_DIMENSION,
} from './provider-types.ts';
export {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  isHostedProvider,
  parseProviderModelKey,
} from './provider-utils.ts';
export {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver.ts';
export {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
} from './providers/hosted/index.ts';
export { TransformersEmbeddingProvider } from './providers/local/transformers-provider.ts';
export {
  getRegisteredEmbeddingRuntimeConfig,
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
  resetEmbeddingQueueFactory,
  resetEmbeddingRuntimeConfig,
} from './runtime-config.ts';
// Export backend and utilities
export { TransformersBackend } from './transformers-backend.ts';
export type {
  EmbeddingConfig,
  EmbeddingExecutionOptions,
  EmbeddingProgress,
  EmbeddingRequestProgress,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStatus,
  ModelConfig,
  ModelRegistry,
  RetrievalMode,
  SimilarityResult,
} from './types.ts';
// Export error class
// Export configuration constants
export { BGE_M3_CONFIG, EmbeddingError, FALLBACK_MODEL_CONFIG } from './types.ts';
