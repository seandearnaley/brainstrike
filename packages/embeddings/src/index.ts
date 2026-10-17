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
} from './api-key-validation.js';
// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service.js';
// Export device detection utilities (BST-169)
export type {
  DeviceCapabilities,
  DeviceUnavailableGuidance,
  EmbeddingDeviceType,
  WebGPUAdapterInfo,
} from './device-detection.js';
export {
  clearDeviceCapabilitiesCache,
  detectDeviceCapabilities,
  formatDeviceCapabilitiesSummary,
  getCachedDeviceCapabilities,
  getDeviceUnavailableGuidance,
  isDeviceAvailable,
  validateDeviceOrThrow,
} from './device-detection.js';
export {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from './embedding-math.js';
export type {
  EmbeddingSetCreateParams,
  EmbeddingSetValidationError,
} from './embedding-set-validation.js';
// Export embedding set validation utilities (BST-168)
export {
  createEmbeddingSetParamsFromMetadata,
  isProviderCompatibleWithSet,
  validateEmbeddingDimensions,
  validateEmbeddingSetParams,
} from './embedding-set-validation.js';
// Export provider abstraction (Phase 2)
export { EmbeddingProviderFactory } from './factory.js';
export type {
  IEmbeddingProvider,
  IHostedEmbeddingProvider,
  ILocalEmbeddingProvider,
} from './interfaces/provider.js';
// Export model dimension helpers
export { isValidDimension, validateDimensions } from './model-dimensions.js';
export { parseModelSizeEstimateBytes } from './model-size-estimate.js';
export * from './provider-core.js';
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
} from './provider-types.js';
export {
  hostedProviderRequiresApiKey,
  isLocalProviderType,
  STANDARD_EMBEDDING_DIMENSION,
} from './provider-types.js';
export {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  isHostedProvider,
  parseProviderModelKey,
} from './provider-utils.js';
export {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver.js';
export {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
} from './providers/hosted/index.js';
export { TransformersEmbeddingProvider } from './providers/local/transformers-provider.js';
export {
  getRegisteredEmbeddingRuntimeConfig,
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
  resetEmbeddingQueueFactory,
  resetEmbeddingRuntimeConfig,
} from './runtime-config.js';
// Export backend and utilities
export { TransformersBackend } from './transformers-backend.js';
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
} from './types.js';
// Export error class
// Export configuration constants
export { BGE_M3_CONFIG, EmbeddingError, FALLBACK_MODEL_CONFIG } from './types.js';
export type {
  EmbeddingWorkerController,
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
} from './worker/embedding-worker.js';
// Worker
export { startEmbeddingWorker } from './worker/embedding-worker.js';
