/**
 * Client-safe exports from agent package.
 * This file has NO dependencies on Mastra or any server-only code.
 * Safe to import in browser/renderer contexts.
 */

export type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmModelCapabilities,
  LocalLlmModelParameters,
  LocalLlmProgressCallback,
  LocalLlmProviderStatus,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
} from './providers/local';

// Local LLM backend for browser-based inference with transformers.js
export { LocalLlmBackend } from './providers/local';
export {
  getProviderDefaultModel,
  getProviderDefinition,
  getProviderDisplayName,
  getProviderModelDefinitions,
  getProviderModels,
  isSupportedProvider,
  isValidModelForProvider,
  listEmbeddingModels,
  listProviders,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODELS,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderModelDefinition,
  type ProviderRuntime,
  providerEnvKeys,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from './providers/types';
