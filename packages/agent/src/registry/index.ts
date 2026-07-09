/**
 * Registry Module Exports
 *
 * Live tool metadata shims (categories, descriptions, schema display).
 * Tool assembly uses the Mastra path; UnifiedToolRegistry was removed.
 */

// Tool categories and metadata
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
} from './tool-categories';
