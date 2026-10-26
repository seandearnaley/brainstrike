/**
 * Node host composition borrows the shipped provider/auth/configuration owners.
 * Credentials remain direct parameters, outside durable runtime configuration.
 */

export {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from './compaction-summary-schema.ts';
export {
  type AssistantResilienceConfig,
  resolveAssistantResilienceConfig,
} from './config/resilience-config.ts';
export { resolveProviderError } from './mastra-boundary/mastra-chunk-decoding.ts';
export {
  extractProviderRunError,
  isContextOverflowProviderErrorCode,
  isLocalRunErrorClassification,
} from './provider-error-metadata.ts';
export { createAwsCredentialChain } from './providers/aws-credential-chain.ts';
export {
  collectRouterGenerateResult,
  materializeHostProviderModel,
} from './providers/model-router-sdk.ts';
export {
  createProviderNativeWebSearchTool,
  providerSupportsNativeWebSearch,
} from './providers/native-web-search.ts';
export {
  apiKeyAuthInput,
  type ProviderAuthInput,
} from './providers/provider-auth-input.ts';
export {
  type ConcreteLanguageModel,
  createEmbeddingProvider,
  createLanguageModelProvider,
  createProvider,
  type ProviderModelConfiguration,
} from './providers/provider-factory.ts';
export type { SupportedProvider } from './providers/types.ts';
export {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration.ts';
export {
  describeEmptyModelResponse,
  getAbnormalFinishMessage,
  outputLimitContextFor,
} from './stream/abnormal-finish.ts';
export { type ModelStepFields, modelStepFields } from './stream/model-step.ts';
export {
  describeStreamStall,
  StreamStalledError,
  ToolExecutions,
  withInactivityTimeout,
} from './stream/with-inactivity-timeout.ts';
export {
  describeToolCallInputTimeout,
  ToolCallInputStreamingTimeoutError,
  withToolCallInputTimeout,
} from './stream/with-tool-call-input-timeout.ts';
export type { RuntimeData } from './types.ts';
export {
  type BilledCostReading,
  readOpenRouterBilledCost,
} from './usage-metering.ts';
