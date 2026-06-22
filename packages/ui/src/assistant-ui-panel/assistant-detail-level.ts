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
  compact: { description: 'Tool calls only', label: 'Compact' },
  standard: { description: 'Tool calls + result summaries', label: 'Standard' },
  developer: {
    description: 'Memory/context activity + raw tool I/O',
    label: 'Developer',
  },
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

/**
 * Map the Detail level to concrete tool-card rendering decisions. Pure verbosity
 * axis — it never depends on the tool's origin (every tool call is something the
 * user may care about; "internal" noise is the memory/context background
 * activity, handled by `shouldShowBackgroundActivity`, not the tool cards).
 */
export function resolveToolDisplayPolicy(level: AssistantDetailLevel): ToolDisplayPolicy {
  if (level === 'developer') {
    return {
      defaultExpanded: true,
      showDetailsExpander: true,
      showResultSummary: true,
      showRawIo: true,
    };
  }

  if (level === 'compact') {
    // Just the call + status; payloads stay out of the way.
    return {
      defaultExpanded: false,
      showDetailsExpander: false,
      showResultSummary: false,
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

/**
 * Whether the thread shows the memory/context "background activity" run-event
 * rows (observational memory, semantic recall, context prep, run steps). Hidden
 * everywhere except Developer — by default the thread is just the grouped tool
 * calls + the answer, not a flood of internal bookkeeping.
 */
export function shouldShowBackgroundActivity(level: AssistantDetailLevel): boolean {
  return level === 'developer';
}
