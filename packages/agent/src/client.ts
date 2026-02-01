/**
 * Client-safe exports from agent package.
 * This file has NO dependencies on Mastra or any server-only code.
 * Safe to import in browser/renderer contexts.
 */

// Context packer utilities (browser-safe, no Mastra dependencies)
export {
  ContextPacker,
  type ContextPackerChunk,
  type ContextPackerOptions,
  type ContextPackerResult,
  type PackedContextChunk,
} from './context-packer';
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
export {
  addAllowedModels,
  getAllowedModels,
  isModelAllowed,
  LocalLlmBackend,
  setModelChecksums,
  verifyModelIntegrity,
} from './providers/local';
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
  PROVIDER_DEFAULT_ENABLED_MODELS,
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
// Tool categories and tiers (browser-safe, no Mastra dependencies)
export {
  compareByLoadPriority,
  getCategoryInfo,
  getNativeToolDefaults,
  getTierInfo,
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
  type NativeToolDefaultMetadata,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
  type ToolCategory,
  type ToolCategoryInfo,
  type ToolLoadingTier,
  type ToolLoadingTierInfo,
  type ToolSource,
} from './registry/tool-categories';
// Tool schema display info (browser-safe, for UI parameter display)
export {
  generateExampleInput,
  getToolSchemaDisplay,
  NATIVE_TOOL_SCHEMAS,
  type ParameterType,
  type ToolParameterDisplay,
  type ToolSchemaDisplay,
} from './registry/tool-schemas-display';
