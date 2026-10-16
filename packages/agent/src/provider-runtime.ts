/**
 * Node host composition borrows the shipped provider/auth/configuration owners.
 * Unlike the root entry, this entry never registers browser-local inference.
 * Credentials remain direct parameters, outside durable runtime configuration.
 */

export {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from './compaction-summary-schema';
export {
  type AssistantResilienceConfig,
  resolveAssistantResilienceConfig,
} from './config/resilience-config';
export { resolveProviderError } from './mastra-boundary/mastra-chunk-decoding';
export {
  extractProviderRunError,
  isContextOverflowProviderErrorCode,
} from './provider-error-metadata';
export { createAwsCredentialChain } from './providers/aws-credential-chain';
export type { LocalEmbeddingHostClient } from './providers/local/local-host-embedding-model';
export {
  collectRouterGenerateResult,
  materializeHostProviderModel,
} from './providers/model-router-sdk';
export {
  createProviderNativeWebSearchTool,
  providerSupportsNativeWebSearch,
} from './providers/native-web-search';
export {
  apiKeyAuthInput,
  type ProviderAuthInput,
} from './providers/provider-auth-input';
export {
  type ConcreteLanguageModel,
  createEmbeddingProvider,
  createLanguageModelProvider,
  createLocalHostMemoryEmbedder,
  createProvider,
  type ProviderModelConfiguration,
} from './providers/provider-factory';
export type { SupportedProvider } from './providers/types';
export {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
export {
  describeEmptyModelResponse,
  getAbnormalFinishMessage,
  outputLimitContextFor,
} from './stream/abnormal-finish';
export {
  describeStreamStall,
  StreamStalledError,
  withInactivityTimeout,
} from './stream/with-inactivity-timeout';
export {
  describeToolCallInputTimeout,
  ToolCallInputStreamingTimeoutError,
  withToolCallInputTimeout,
} from './stream/with-tool-call-input-timeout';
export type { RuntimeData } from './types';
export {
  type BilledCostReading,
  readOpenRouterBilledCost,
} from './usage-metering';
