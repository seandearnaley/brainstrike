export type { ApiKeyValidationResult } from './api-key-validation.js';
export {
  checkApiKeyAvailability,
  getApiKeyConfigInstructions,
  requiresApiKey,
} from './api-key-validation.js';
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
export type { ParsedProviderModel } from './provider-utils.js';
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
export { CohereEmbeddingProvider } from './providers/hosted/cohere-provider.js';
export { GoogleEmbeddingProvider } from './providers/hosted/google-provider.js';
export { OpenAIEmbeddingProvider } from './providers/hosted/openai-provider.js';
export { VoyageEmbeddingProvider } from './providers/hosted/voyage-provider.js';
export type { ModelConfig } from './types.js';
