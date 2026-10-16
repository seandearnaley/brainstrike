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
  DESKTOP_NATIVE_TOOL_IDS,
  type DesktopNativeToolId,
  getCategoryInfo,
  getNativeToolDefaults,
  getTierInfo,
  isDesktopNativeToolId,
  isNativeTool,
  isNativeToolId,
  isSkillNativeToolId,
  NATIVE_TOOL_DEFAULTS,
  NATIVE_TOOL_ID,
  NATIVE_TOOL_IDS,
  type NativeToolDefaultMetadata,
  type NativeToolId,
  SKILL_NATIVE_TOOL_IDS,
  type SkillNativeToolId,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
  type ToolCategory,
  type ToolCategoryInfo,
  type ToolLoadingTier,
  type ToolLoadingTierInfo,
  type ToolSource,
} from './registry/tool-categories';
export { TOOL_DESCRIPTIONS } from './registry/tool-descriptions';
