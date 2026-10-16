/**
 * Browser-safe agent exports.
 *
 * This boundary was drawn to keep the Transformers-backed local chat runtime
 * (top-level await and async chunk initialization when bundled for the
 * browser) out of browser bundles. That runtime was retired with the local chat
 * engine (#3685); the entry stays as the narrow subset browser code imports.
 */

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
