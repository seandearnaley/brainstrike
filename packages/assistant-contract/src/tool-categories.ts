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
 * Canonical id for the web-search native tool. Single source of truth shared by
 * the desktop tool registry (which builds the Tavily-backed entry) and the agent
 * runtime (which may swap in a provider-native search tool under the same id). A
 * `read`-risk retrieval tool — see NATIVE_TOOL_DEFAULTS below.
 */
export const WEB_SEARCH_TOOL_ID = 'brainstrike.webSearch' as const;
export const WEB_EXTRACT_TOOL_ID = 'brainstrike.webExtract' as const;

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
    description: 'Loaded based on available token budget',
    id: 'conditional',
    label: 'Conditional',
  },
  critical: {
    description: 'Always loaded with every agent session',
    id: 'critical',
    label: 'Critical',
  },
  deferred: {
    description: 'Only loaded when explicitly requested',
    id: 'deferred',
    label: 'Deferred',
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
  // Suspending tool: asks the user a question and PAUSES the run for their
  // answer. `category:'action'` is the UI/load taxonomy, but the risk bucket is
  // EXPLICITLY 'read' — its OWN suspension is the user gate, so the permission
  // engine must NOT stack an approval prompt on top (that would double-gate it).
  // It mutates no workspace/fs/persistent-user state. An `action` tool MUST
  // declare riskCategory explicitly (tool-risk.ts throws otherwise).
  'brainstrike.askUser': {
    category: 'action',
    estimatedTokens: 120,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  // Deletes a single workspace FILE. riskCategory 'edit' so the permission engine
  // gates it (→ 'ask' by default) like the other file-mutation tools; directory
  // deletes are refused by the tool itself.
  'brainstrike.deleteWorkspaceFile': {
    category: 'action',
    estimatedTokens: 130,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  // Arbitrary shell execution — THE highest-risk native tool. There is NO
  // sandbox, so it is pinned to the 'execute' risk bucket and requires approval.
  // When the permission engine enforces a policy and `execute` is `'ask'` (the
  // default), this tool SUSPENDS for per-call approval before it runs (Mastra's
  // per-tool requireApproval); it is omitted from the map only as a fail-safe
  // when there is no workflow storage to resume the suspend, or when `execute`
  // is `'deny'`. `'allow'`/YOLO runs it unprompted.
  'brainstrike.executeCommand': {
    category: 'action',
    estimatedTokens: 180,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  'brainstrike.findWorkspaceSymbol': {
    category: 'retrieval',
    estimatedTokens: 150,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  // Read-only file enumeration by glob pattern. Explicitly pinned to the 'read'
  // risk bucket (it is also derivable from retrieval + no-approval) so the
  // permission engine allows it by default, like the other workspace readers.
  'brainstrike.globWorkspace': {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  'brainstrike.grepSearch': {
    category: 'retrieval',
    estimatedTokens: 160,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  'brainstrike.listEmbeddingSpaces': {
    category: 'analysis',
    estimatedTokens: 110,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  'brainstrike.listWorkspaceContext': {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  // Whole-list replace of the assistant's own per-thread plan. `category:'action'`
  // is the UI/load taxonomy, but the risk bucket is EXPLICITLY 'read': it mutates
  // ONLY the assistant's ephemeral todo list — no workspace/fs/persistent-user
  // state — so, like brainstrike.webSearch (also 'read' despite doing work), the
  // permission engine allows it by default and the loop never suspends for a plan
  // update. An `action` tool MUST declare riskCategory explicitly (tool-risk.ts
  // throws otherwise — no silent bucketing).
  'brainstrike.manageTaskList': {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  'brainstrike.queryEmbeddingSpace': {
    category: 'retrieval',
    estimatedTokens: 190,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  'brainstrike.readWorkspaceContext': {
    category: 'retrieval',
    estimatedTokens: 180,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  'brainstrike.readWorkspaceDirectory': {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  // Core workspace reading tools
  'brainstrike.readWorkspaceFile': {
    category: 'retrieval',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  // Renames/moves a single workspace FILE within one root. riskCategory 'edit' so
  // the permission engine gates it (→ 'ask' by default) like the other
  // file-mutation tools; cross-root moves and overwrites are refused by the tool.
  'brainstrike.renameWorkspaceFile': {
    category: 'action',
    estimatedTokens: 150,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  // Surgical-edit complement to writeWorkspaceFile: fuzzy-matches an oldStr
  // block and replaces it. Same edit-risk gating.
  'brainstrike.stringReplaceWorkspaceFile': {
    category: 'action',
    estimatedTokens: 160,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  // Suspending tool: submits a structured plan and PAUSES for the user's
  // approve/reject decision. Risk bucket EXPLICITLY 'read' for the same reason as
  // askUser — its own suspension is the gate; do NOT let the permission engine
  // double-gate it with an approval prompt.
  'brainstrike.submitPlan': {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  'brainstrike.updateWorkspaceContextSelection': {
    category: 'action',
    estimatedTokens: 150,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  'brainstrike.updateWorkspaceTapestrySelections': {
    category: 'action',
    estimatedTokens: 190,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  // The natural pair to webSearch (report R5): read the page BEHIND a result
  // or a user-pasted URL as markdown, via Tavily's /extract endpoint. Same
  // 'read' + no-approval posture and the same external-service privacy caveat
  // — the URLs are sent to Tavily. Model-supplied URLs are validated
  // server-side first (http/https only, no credentials, no private/loopback/
  // link-local hosts) so an internal URL never leaves the machine.
  'brainstrike.webExtract': {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  // Read-only web retrieval via Tavily. riskCategory 'read' + requiresApproval
  // false: it does NOT mutate workspace state, so the permission engine allows
  // it by default like the other readers. NOTE the privacy caveat documented on
  // the tool description: it sends the query to an EXTERNAL service (Tavily).
  'brainstrike.webSearch': {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  // First mutation tool: writes/creates a workspace file. riskCategory 'edit' so
  // the Phase 1 permission engine gates it when enforcement is on.
  'brainstrike.writeWorkspaceFile': {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  // Agent Skills tools (https://agentskills.io). These are Mastra's OWN
  // canonical tool ids (`skill`/`skill_read`/`skill_search`, deliberately NOT
  // `brainstrike.*`-namespaced) created via `createSkillTools` and folded into
  // the runtime tool map BEFORE guards/hooks/plan-mode/permission — so they
  // need registry risk entries like every native tool. All three are
  // READ-ONLY: they load, search, and read skill content the user installed on
  // disk; skill *scripts* still run through `brainstrike.executeCommand` and
  // its 'execute' approval gate. Explicit 'read' keeps them free under the
  // default policy and available in plan mode (investigation tools).
  skill: {
    category: 'retrieval',
    estimatedTokens: 90,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_read: {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
  skill_search: {
    category: 'retrieval',
    estimatedTokens: 110,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
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
