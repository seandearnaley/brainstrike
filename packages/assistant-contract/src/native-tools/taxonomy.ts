/**
 * The load-ordering and risk taxonomies a native-tool definition declares.
 *
 * Kept in a leaf module (no imports) so `define.ts`, `tool-categories.ts`, and
 * `tool-risk.ts` can all name these types without an import cycle through the
 * derived catalog. `tool-categories.ts` and `tool-risk.ts` re-export them under
 * their historical names.
 */

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
 * Loading tier declares when a tool belongs in the model-facing discovery
 * surface.
 *
 * - `critical`: Always loaded at agent initialization (essential for core functionality)
 * - `conditional`: Loaded based on token budget and context (search-discovered)
 * - `deferred`: Only loaded when explicitly requested or triggered
 */
export type ToolLoadingTier = 'critical' | 'conditional' | 'deferred';

/**
 * Risk category for a tool, used by the permission engine to decide whether a
 * tool call is allowed, requires a prompt, or is denied.
 *
 * A SEPARATE taxonomy from the load-ordering {@link ToolCategory}: that one
 * governs WHEN a tool is loaded and how the UI groups it; this one governs HOW
 * DANGEROUS a tool is. Do not conflate or merge the two.
 *
 * - `read`: observes state without mutating it (file reads, searches, queries).
 * - `edit`: mutates workspace/persistent state (writes, edits, selection changes).
 * - `execute`: runs commands or arbitrary code (shell, scripts).
 * - `mcp`: delegates to an external MCP server whose effects are opaque to us.
 */
export type ToolRiskCategory = 'read' | 'edit' | 'execute' | 'mcp';

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
