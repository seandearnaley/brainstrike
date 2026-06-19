/**
 * Tool Categories and Loading Tiers
 *
 * Defines the categorization system for agent tools, enabling:
 * - Logical grouping in the settings UI
 * - Priority-based loading with token budget management
 * - Consistent tool organization across native and MCP tools
 */

import { resolveToolRiskCategory, type ToolRiskCategory } from './tool-risk.js';

/**
 * Source of a tool - either built into the application or from an MCP server.
 */
export type ToolSource = 'native' | 'mcp';

/**
 * Functional category for organizing tools in the UI and for search prioritization.
 *
 * - `retrieval`: Tools that search, query, or retrieve information (highest priority for search tasks)
 * - `action`: Tools that modify state or trigger operations (mutations)
 * - `analysis`: Tools that analyze or summarize data without modification
 * - `configuration`: Tools for system configuration and settings
 * - `validation`: Tools that check or validate state/data
 */
export type ToolCategory = 'retrieval' | 'action' | 'analysis' | 'configuration' | 'validation';

/**
 * Loading tier determines when a tool is loaded into the agent context.
 *
 * - `critical`: Always loaded at agent initialization (essential for core functionality)
 * - `conditional`: Loaded based on token budget and context (search-discovered)
 * - `deferred`: Only loaded when explicitly requested or triggered
 */
export type ToolLoadingTier = 'critical' | 'conditional' | 'deferred';

/**
 * Display metadata for tool categories (used in settings UI).
 */
export interface ToolCategoryInfo {
  description: string;
  id: ToolCategory;
  label: string;
  /** Priority for loading order (lower = higher priority) */
  loadPriority: number;
}

/**
 * Category metadata for UI display.
 */
export const TOOL_CATEGORIES: Record<ToolCategory, ToolCategoryInfo> = {
  retrieval: {
    id: 'retrieval',
    label: 'Retrieval',
    description: 'Search and query tools for finding information',
    loadPriority: 1,
  },
  analysis: {
    id: 'analysis',
    label: 'Analysis',
    description: 'Tools that analyze or summarize data',
    loadPriority: 2,
  },
  action: {
    id: 'action',
    label: 'Actions',
    description: 'Tools that modify state or trigger operations',
    loadPriority: 3,
  },
  configuration: {
    id: 'configuration',
    label: 'Configuration',
    description: 'System configuration and settings tools',
    loadPriority: 4,
  },
  validation: {
    id: 'validation',
    label: 'Validation',
    description: 'Tools that check or validate state',
    loadPriority: 5,
  },
};

/**
 * Display metadata for loading tiers.
 */
export interface ToolLoadingTierInfo {
  description: string;
  id: ToolLoadingTier;
  label: string;
}

export const TOOL_LOADING_TIERS: Record<ToolLoadingTier, ToolLoadingTierInfo> = {
  critical: {
    id: 'critical',
    label: 'Critical',
    description: 'Always loaded with every agent session',
  },
  conditional: {
    id: 'conditional',
    label: 'Conditional',
    description: 'Loaded based on available token budget',
  },
  deferred: {
    id: 'deferred',
    label: 'Deferred',
    description: 'Only loaded when explicitly requested',
  },
};

/**
 * Tool metadata mapping for known native tools.
 * Used to provide default category/tier when registering tools.
 */
export interface NativeToolDefaultMetadata {
  category: ToolCategory;
  /** Estimated token count for tool schema in context */
  estimatedTokens: number;
  loadingTier: ToolLoadingTier;
  /** Whether this tool performs mutations requiring user approval */
  requiresApproval: boolean;
  /**
   * Explicit permission-engine risk bucket. Optional and backward compatible:
   * when omitted, the risk category is derived by `resolveToolRiskCategory`
   * (see tool-risk.ts). Declare it explicitly for any tool that is not
   * unambiguously read-only. This is SEPARATE from `category` above, which is a
   * load-ordering/UI taxonomy.
   */
  riskCategory?: ToolRiskCategory;
}

/**
 * Default metadata for known native tools.
 * Tool IDs follow the namespace.toolName pattern.
 */
export const NATIVE_TOOL_DEFAULTS: Record<string, NativeToolDefaultMetadata> = {
  // Core workspace reading tools
  'brainstrike.readWorkspaceFile': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 140,
  },
  // First mutation tool: writes/creates a workspace file. riskCategory 'edit' so
  // the Phase 1 permission engine gates it when enforcement is on.
  'brainstrike.writeWorkspaceFile': {
    category: 'action',
    loadingTier: 'critical',
    requiresApproval: true,
    estimatedTokens: 140,
    riskCategory: 'edit',
  },
  // Surgical-edit complement to writeWorkspaceFile: fuzzy-matches an old_str
  // block and replaces it. Same edit-risk gating.
  'brainstrike.stringReplaceWorkspaceFile': {
    category: 'action',
    loadingTier: 'critical',
    requiresApproval: true,
    estimatedTokens: 160,
    riskCategory: 'edit',
  },
  'brainstrike.findWorkspaceSymbol': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 150,
  },
  'brainstrike.readWorkspaceDirectory': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 120,
  },
  'brainstrike.listWorkspaceContext': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 120,
  },
  'brainstrike.readWorkspaceContext': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 180,
  },
  'brainstrike.updateWorkspaceContextSelection': {
    category: 'action',
    loadingTier: 'critical',
    requiresApproval: true,
    estimatedTokens: 150,
    riskCategory: 'edit',
  },
  'brainstrike.updateWorkspaceTapestrySelections': {
    category: 'action',
    loadingTier: 'critical',
    requiresApproval: true,
    estimatedTokens: 190,
    riskCategory: 'edit',
  },
  'brainstrike.listEmbeddingSpaces': {
    category: 'analysis',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 110,
  },
  'brainstrike.queryEmbeddingSpace': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 190,
  },
  'brainstrike.grepSearch': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 160,
  },
  // Read-only file enumeration by glob pattern. Explicitly pinned to the 'read'
  // risk bucket (it is also derivable from retrieval + no-approval) so the
  // permission engine allows it by default, like the other workspace readers.
  'brainstrike.globWorkspace': {
    category: 'retrieval',
    loadingTier: 'critical',
    requiresApproval: false,
    estimatedTokens: 130,
    riskCategory: 'read',
  },
  // Arbitrary shell execution — THE highest-risk native tool. There is NO
  // sandbox, so it is pinned to the 'execute' risk bucket and requires approval.
  // When the permission engine enforces a policy, 'execute' that is not 'allow'
  // omits this tool from the map the model sees.
  'brainstrike.executeCommand': {
    category: 'action',
    loadingTier: 'critical',
    requiresApproval: true,
    estimatedTokens: 180,
    riskCategory: 'execute',
  },
};

/**
 * Build the native-tool risk classification map for the permission gate.
 *
 * Maps every {@link NATIVE_TOOL_DEFAULTS} tool id → its {@link ToolRiskCategory}
 * via {@link resolveToolRiskCategory}. This is the caller-provided `riskByTool`
 * the runtime permission gate consumes (the gate never introspects Mastra tool
 * objects for brainstrike risk metadata — that classification is registry-side).
 *
 * STRICT: if a native tool's risk cannot be derived and is not explicitly
 * declared, {@link resolveToolRiskCategory} throws {@link UndeterminableToolRiskError}.
 * That surfaces a misconfigured catalog entry rather than silently bucketing a
 * potentially dangerous tool into a permissive category (no-silent-fallbacks).
 */
export function buildNativeToolRiskMap(): Record<string, ToolRiskCategory> {
  const riskByTool: Record<string, ToolRiskCategory> = {};
  for (const [toolId, metadata] of Object.entries(NATIVE_TOOL_DEFAULTS)) {
    riskByTool[toolId] = resolveToolRiskCategory(metadata);
  }
  return riskByTool;
}

/**
 * Get default metadata for a native tool by ID.
 * Returns undefined if the tool is not a known native tool.
 */
export function getNativeToolDefaults(toolId: string): NativeToolDefaultMetadata | undefined {
  return NATIVE_TOOL_DEFAULTS[toolId];
}

/**
 * Check if a tool ID represents a native tool.
 */
export function isNativeTool(toolId: string): boolean {
  return toolId in NATIVE_TOOL_DEFAULTS;
}

/**
 * Get category info for display.
 */
export function getCategoryInfo(category: ToolCategory): ToolCategoryInfo {
  return TOOL_CATEGORIES[category];
}

/**
 * Get tier info for display.
 */
export function getTierInfo(tier: ToolLoadingTier): ToolLoadingTierInfo {
  return TOOL_LOADING_TIERS[tier];
}

/**
 * Compare tools by their category load priority.
 * Lower priority values load first.
 */
export function compareByLoadPriority(
  a: { category: ToolCategory },
  b: { category: ToolCategory }
): number {
  return TOOL_CATEGORIES[a.category].loadPriority - TOOL_CATEGORIES[b.category].loadPriority;
}
