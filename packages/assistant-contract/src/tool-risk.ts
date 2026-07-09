/**
 * Tool Risk Taxonomy
 *
 * A SEPARATE taxonomy from the load-ordering `ToolCategory`
 * (retrieval | action | analysis | configuration | validation in
 * tool-categories.ts). That taxonomy governs WHEN a tool is loaded into
 * context and how the UI groups it. This taxonomy governs HOW DANGEROUS a tool
 * is, which is the input to the (forthcoming) permission engine (allow / ask /
 * deny per risk category). Do not conflate or merge the two.
 *
 * Modeled on mastra-code-ui's four risk buckets:
 * - `read`: observes state without mutating it (file reads, searches, queries).
 * - `edit`: mutates workspace/persistent state (writes, edits, selection changes).
 * - `execute`: runs commands or arbitrary code (shell, scripts).
 * - `mcp`: delegates to an external MCP server whose effects are opaque to us.
 *
 * This module is PURE contract + a resolver. It does NOT wire enforcement into
 * any runtime; that is a later step in the permission-engine work.
 */

import type { ToolCategory } from './tool-categories.js';

/**
 * Risk category for a tool, used by the permission engine to decide whether a
 * tool call is allowed, requires a prompt, or is denied.
 */
export type ToolRiskCategory = 'read' | 'edit' | 'execute' | 'mcp';

/**
 * The minimal metadata the resolver needs to classify a tool's risk.
 *
 * This is a structural subset of the contract-level
 * `NativeToolDefaultMetadata`, so the resolver works against catalog metadata
 * without importing the agent package.
 */
export interface ToolRiskMetadata {
  /** Load-ordering / UI category (NOT the risk category). */
  category: ToolCategory;
  /** Whether the tool mutates state and so requires user approval. */
  requiresApproval: boolean;
  /**
   * Explicit risk category. When present this wins unconditionally — a tool
   * author can always pin the risk bucket regardless of derived heuristics.
   */
  riskCategory?: ToolRiskCategory;
}

/**
 * Thrown when a tool's risk category cannot be safely derived and was not
 * explicitly declared.
 *
 * Per the project no-silent-fallbacks rule, an ambiguous (potentially
 * mutating) tool must NEVER be silently bucketed into a permissive category.
 * The author must declare `riskCategory` explicitly.
 */
export class UndeterminableToolRiskError extends Error {
  readonly category: ToolCategory;
  readonly requiresApproval: boolean;

  constructor(metadata: Pick<ToolRiskMetadata, 'category' | 'requiresApproval'>) {
    super(
      `Cannot derive a tool risk category for a tool with category='${metadata.category}' ` +
        `and requiresApproval=${metadata.requiresApproval}. ` +
        'Such a tool must explicitly declare a `riskCategory` (read | edit | execute | mcp); ' +
        'a potentially dangerous tool must never be silently bucketed into a permissive category.'
    );
    this.name = 'UndeterminableToolRiskError';
    this.category = metadata.category;
    this.requiresApproval = metadata.requiresApproval;
  }
}

/**
 * Load-ordering categories that, when combined with `requiresApproval: false`,
 * are unambiguously read-only. A tool that only retrieves, analyzes, or
 * validates state and needs no approval cannot mutate anything, so it is safe
 * to derive as `read`.
 *
 * `action` and `configuration` are intentionally excluded: they imply mutation
 * and must be declared explicitly.
 */
const READ_ONLY_DERIVABLE_CATEGORIES: ReadonlySet<ToolCategory> = new Set<ToolCategory>([
  'retrieval',
  'analysis',
  'validation',
]);

/**
 * Resolve the risk category for a tool.
 *
 * Rules (no silent fallbacks):
 * 1. If `metadata.riskCategory` is declared, return it.
 * 2. Else if the tool is unambiguously read-only — its load-ordering category
 *    is one of retrieval/analysis/validation AND `requiresApproval` is falsy —
 *    derive `'read'`.
 * 3. Else throw {@link UndeterminableToolRiskError}: the tool must declare a
 *    `riskCategory` explicitly. Unknown/mutating tools are NEVER defaulted to a
 *    permissive category.
 */
export function resolveToolRiskCategory(metadata: ToolRiskMetadata): ToolRiskCategory {
  if (metadata.riskCategory !== undefined) {
    return metadata.riskCategory;
  }

  if (!metadata.requiresApproval && READ_ONLY_DERIVABLE_CATEGORIES.has(metadata.category)) {
    return 'read';
  }

  throw new UndeterminableToolRiskError(metadata);
}
