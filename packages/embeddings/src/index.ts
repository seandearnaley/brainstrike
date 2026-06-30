// Export types and interfaces

// Re-export power broadcast channel name for renderer ↔ worker coordination
export { POWER_BROADCAST_CHANNEL } from '@brainstrike/embedding-worker';
// Export API key validation utilities
export {
  type ApiKeyValidationResult,
  type ApiKeyValidationUnavailableReason,
  checkApiKeyAvailability,
  getApiKeyConfigInstructions,
  requiresApiKey,
} from './api-key-validation';
// Export service implementation
export { SimpleEmbeddingService } from './bge-m3-service';
// Export device detection utilities (BST-169)
export type {
  DeviceCapabilities,
  DeviceUnavailableGuidance,
  EmbeddingDeviceType,
  WebGPUAdapterInfo,
} from './device-detection';
export {
  clearDeviceCapabilitiesCache,
  detectDeviceCapabilities,
  formatDeviceCapabilitiesSummary,
  getCachedDeviceCapabilities,
  getDeviceUnavailableGuidance,
  isDeviceAvailable,
  validateDeviceOrThrow,
} from './device-detection';
export {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from './embedding-math';
export type {
  EmbeddingSetCreateParams,
  EmbeddingSetValidationError,
} from './embedding-set-validation';
// Export embedding set validation utilities (BST-168)
export {
  createEmbeddingSetParamsFromMetadata,
  isProviderCompatibleWithSet,
  validateEmbeddingDimensions,
  validateEmbeddingSetParams,
} from './embedding-set-validation';
// Export provider abstraction (Phase 2)
export { EmbeddingProviderFactory } from './factory';
export type {
  IEmbeddingProvider,
  IHostedEmbeddingProvider,
  ILocalEmbeddingProvider,
} from './interfaces/provider';
// Export model dimension helpers
export { isValidDimension, validateDimensions } from './model-dimensions';
export * from './provider-core';
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
} from './provider-types';
export {
  hostedProviderRequiresApiKey,
  isLocalProviderType,
  STANDARD_EMBEDDING_DIMENSION,
} from './provider-types';
export {
  canonicalizeProviderModelKey,
  formatProviderModelKey,
  isHostedProvider,
  parseProviderModelKey,
} from './provider-utils';
export {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
} from './providers/hosted';
export {
  clearHostedProviderApiKeyCache,
  resolveHostedProviderApiKey,
} from './providers/hosted/api-key-resolver';
export { TransformersEmbeddingProvider } from './providers/local/transformers-provider';
export {
  getRegisteredEmbeddingRuntimeConfig,
  registerEmbeddingQueueFactory,
  registerEmbeddingRuntimeConfig,
  resetEmbeddingQueueFactory,
  resetEmbeddingRuntimeConfig,
} from './runtime-config';
// Export backend and utilities
export { TransformersBackend } from './transformers-backend';
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
export type {
  EmbeddingWorkerController,
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
} from './worker/embedding-worker';
// Worker
export { startEmbeddingWorker } from './worker/embedding-worker';
export type {
  EmbeddingWorkerClaimedJob,
  EmbeddingWorkerClaimParams,
  EmbeddingWorkerCompleteEmbeddingChunkParams,
  EmbeddingWorkerFailBatchParams,
  EmbeddingWorkerFailParams,
  EmbeddingWorkerJobLeaseRef,
  EmbeddingWorkerQueuePort,
  EmbeddingWorkerStatsControllerOptions,
  EmbeddingWorkerStorage,
} from './worker/embedding-worker-storage';
export {
  createPGliteEmbeddingWorkerStorage,
  createTursoEmbeddingWorkerStorage,
} from './worker/embedding-worker-storage';
