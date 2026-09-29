/**
 * Tool Categories and Loading Tiers
 *
 * Defines the categorization system for agent tools, enabling:
 * - Logical grouping in the settings UI
 * - Priority-based loading with token budget management
 * - Consistent tool organization across native and MCP tools
 */

import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from './native-tool-catalog.js';
import { NATIVE_TOOL_REGISTRIES } from './native-tools/index.js';
import type {
  NativeToolDefaultMetadata,
  ToolCategory,
  ToolLoadingTier,
} from './native-tools/taxonomy.js';
import { resolveToolRiskCategory, type ToolRiskCategory } from './tool-risk.js';

export type { NativeToolDefaultMetadata, ToolCategory, ToolLoadingTier };

/**
 * Canonical id for the web-search native tool. Single source of truth shared by
 * the desktop tool registry (which builds the Tavily-backed entry) and the agent
 * runtime (which may swap in a provider-native search tool under the same id). A
 * `read`-risk retrieval tool — see NATIVE_TOOL_DEFAULTS below.
 */
export const WEB_SEARCH_TOOL_ID = NATIVE_TOOL_ID.webSearch;
export const WEB_EXTRACT_TOOL_ID = NATIVE_TOOL_ID.webExtract;
export const LSP_INSPECT_TOOL_ID = NATIVE_TOOL_ID.lspInspect;

/**
 * Source of a tool - either built into the application or from an MCP server.
 */
export type ToolSource = 'native' | 'mcp';

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
  action: {
    description: 'Tools that modify state or trigger operations',
    id: 'action',
    label: 'Actions',
    loadPriority: 3,
  },
  analysis: {
    description: 'Tools that analyze or summarize data',
    id: 'analysis',
    label: 'Analysis',
    loadPriority: 2,
  },
  configuration: {
    description: 'System configuration and settings tools',
    id: 'configuration',
    label: 'Configuration',
    loadPriority: 4,
  },
  retrieval: {
    description: 'Search and query tools for finding information',
    id: 'retrieval',
    label: 'Retrieval',
    loadPriority: 1,
  },
  validation: {
    description: 'Tools that check or validate state',
    id: 'validation',
    label: 'Validation',
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
  conditional: {
    description: 'Eligible when the active context budget permits',
    id: 'conditional',
    label: 'Conditional',
  },
  critical: {
    description: 'Always visible once dynamic discovery is enabled',
    id: 'critical',
    label: 'Critical',
  },
  deferred: {
    description: 'Loaded only through an explicit discovery adapter',
    id: 'deferred',
    label: 'Deferred',
  },
};

/**
 * Default metadata for known native tools, DERIVED from each tool's
 * `defineNativeTool` declaration (`native-tools/definitions/*.ts`, where the
 * per-tool rationale comments now live). Tool IDs follow the
 * namespace.toolName pattern.
 */
export const NATIVE_TOOL_DEFAULTS: Record<NativeToolId, NativeToolDefaultMetadata> =
  NATIVE_TOOL_REGISTRIES.defaults;

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
 * Sanitized (Mastra-registered) tool id → dotted native id.
 *
 * When native tools are registered with Mastra their ids are sanitized
 * (`name.replace(/[^a-zA-Z0-9_-]/g, '_')`), so `brainstrike.grepSearch` is stored
 * as `brainstrike_grepSearch`. The LIVE stream un-sanitizes names for display via
 * the runtime's name map, but PERSISTED `mastra_messages` tool-invocation parts
 * keep the sanitized id, so a reloaded thread renders `brainstrike_grepSearch`
 * while the live turn showed `brainstrike.grepSearch` (the D3 divergence). This
 * map is the reverse for the KNOWN native ids — the only ones whose original form
 * is unambiguous (an underscore in an unknown/MCP tool could be original).
 */
const SANITIZED_TO_DOTTED_NATIVE_TOOL: Record<string, string> = Object.fromEntries(
  Object.keys(NATIVE_TOOL_DEFAULTS).map((toolId) => [
    toolId.replace(/[^a-zA-Z0-9_-]/g, '_'),
    toolId,
  ])
);

/**
 * Normalize a persisted (sanitized) native tool name back to its dotted display
 * form so a hydrated tool card matches the live label (D3). Non-native /
 * already-dotted / unknown names pass through unchanged.
 */
export function denormalizeNativeToolName(toolName: string): string {
  return SANITIZED_TO_DOTTED_NATIVE_TOOL[toolName] ?? toolName;
}

/**
 * Get default metadata for a native tool by ID.
 * Returns undefined if the tool is not a known native tool.
 */
export function getNativeToolDefaults(toolId: string): NativeToolDefaultMetadata | undefined {
  return isNativeToolId(toolId) ? NATIVE_TOOL_DEFAULTS[toolId] : undefined;
}

/**
 * Check if a tool ID represents a native tool.
 */
export function isNativeTool(toolId: string): boolean {
  return isNativeToolId(toolId);
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
