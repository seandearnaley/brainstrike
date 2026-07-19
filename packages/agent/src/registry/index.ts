/**
 * Registry Module Exports
 *
 * Live tool metadata shims (categories, descriptions, schema display).
 * Tool assembly uses the Mastra path; UnifiedToolRegistry was removed.
 */

// Tool categories and metadata
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
} from './tool-categories';
