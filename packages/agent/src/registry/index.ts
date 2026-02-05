/**
 * Registry Module Exports
 *
 * Unified tool registry, categories, budget management, and loading.
 */

// Token budget management
export {
  type BudgetAllocation,
  type BudgetUtilizationReport,
  COMMON_CONTEXT_WINDOWS,
  createBudgetManagerForTier,
  createTokenBudgetManager,
  DEFAULT_BUDGET_ALLOCATION,
  DEFAULT_SELECTION_PRIORITY,
  TokenBudgetManager,
  type TokenBudgetManagerOptions,
  type ToolSelectionPriority,
  type ToolSelectionResult,
} from './token-budget-manager';
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
// Tool loader
export {
  createToolLoader,
  loadToolsForAgent,
  type OnDemandLoadOptions,
  type OnDemandLoadResult,
  ToolLoader,
  type ToolLoadingOptions,
  type ToolLoadingResult,
} from './tool-loader';
// Unified registry
export {
  createUnifiedToolRegistry,
  type McpToolRegistrationOptions,
  type NativeToolRegistrationOptions,
  type ToolFilterConfig,
  type ToolRegistryListener,
  type ToolRegistryStats,
  type ToolsByCategory,
  type ToolsBySource,
  type UnifiedToolMetadata,
  UnifiedToolRegistry,
  unifiedToolRegistry,
} from './unified-registry';
