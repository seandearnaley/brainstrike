/**
 * How much tool detail the assistant thread renders. A single user-facing
 * "Detail" control drives every tool card:
 * - `compact`   — calls only; internal `brainstrike.*` payloads are hidden
 *                 (users mostly care about the call, not the internal output).
 * - `standard`  — calls + result summaries, with an expander for full I/O.
 * - `developer` — everything expanded with raw args/results, timings, token
 *                 counts: the data developers want flowing in and out.
 */
export type AssistantDetailLevel = 'compact' | 'standard' | 'developer';

export const ASSISTANT_DETAIL_LEVELS: readonly AssistantDetailLevel[] = [
  'compact',
  'standard',
  'developer',
] as const;

export const DEFAULT_ASSISTANT_DETAIL_LEVEL: AssistantDetailLevel = 'standard';

export function isAssistantDetailLevel(value: unknown): value is AssistantDetailLevel {
  return value === 'compact' || value === 'standard' || value === 'developer';
}

/** Per-level human label + helper text for the controls menu. */
export const ASSISTANT_DETAIL_LEVEL_META: Record<
  AssistantDetailLevel,
  { description: string; label: string }
> = {
  compact: { description: 'Calls only — hides internal tool output', label: 'Compact' },
  standard: { description: 'Calls + result summaries', label: 'Standard' },
  developer: { description: 'Full raw I/O, timings, tokens', label: 'Developer' },
};

export interface ToolDisplayPolicy {
  /** Auto-open the args/result panes (developer wants everything visible). */
  defaultExpanded: boolean;
  /** Offer the expand/collapse control for args/result. */
  showDetailsExpander: boolean;
  /** Surface raw I/O extras: full args/result, timing, token/metadata. */
  showRawIo: boolean;
  /** Show the compact "N results" summary in the card header. */
  showResultSummary: boolean;
}

interface ToolDisplayContext {
  /** Internal brainstrike.* tool (vs an external MCP tool). */
  isInternal: boolean;
}

/**
 * Map the Detail level + tool origin to concrete rendering decisions. Pure so
 * the card components stay declarative and the policy is unit-testable.
 */
export function resolveToolDisplayPolicy(
  level: AssistantDetailLevel,
  { isInternal }: ToolDisplayContext
): ToolDisplayPolicy {
  if (level === 'developer') {
    return {
      defaultExpanded: true,
      showDetailsExpander: true,
      showResultSummary: true,
      showRawIo: true,
    };
  }

  if (level === 'compact') {
    // Hide internal payloads entirely; keep external tool output reachable.
    return {
      defaultExpanded: false,
      showDetailsExpander: !isInternal,
      showResultSummary: !isInternal,
      showRawIo: false,
    };
  }

  // standard
  return {
    defaultExpanded: false,
    showDetailsExpander: true,
    showResultSummary: true,
    showRawIo: false,
  };
}
