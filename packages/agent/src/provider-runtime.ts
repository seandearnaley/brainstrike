/**
 * Node host composition borrows the shipped provider/auth/configuration owners.
 * Unlike the root entry, this entry never registers browser-local inference.
 * Credentials remain direct parameters, outside durable runtime configuration.
 */

export {
  type BilledCostReading,
  readOpenRouterBilledCost,
} from './mastra/runtime-assembly/usage-metering';
export {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './mastra/runtime-configuration';
export type { LocalLlmHostClient } from './providers/local/llm-host-client';
export {
  apiKeyAuthInput,
  type ProviderAuthInput,
} from './providers/provider-auth-input';
export {
  type ConcreteLanguageModel,
  createLanguageModelProvider,
  createProvider,
  type ProviderModelConfiguration,
} from './providers/provider-factory';
export type { SupportedProvider } from './providers/types';
export type { RuntimeData } from './types';
