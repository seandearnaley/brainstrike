/**
 * Prompt-composition breakdown for the context usage popover.
 *
 * Computed server-side at prompt assembly (packages/agent
 * mastra/prompt-breakdown.ts) with the shared chars/4 heuristic and shipped as
 * a TRANSIENT `brainstrike.context-breakdown` aui-data part at run start.
 *
 * TRANSIENCE (deliberate, mirrors SHELL_OUTPUT_DATA_NAME): the breakdown rides
 * its OWN data part, NOT a run-event. Run-events are persisted server-side into
 * the durable `assistant_run_events` table; the breakdown is a per-run display
 * derivation that must never be persisted — the run-event persistence tap
 * ignores non-run-event StreamChunks, so on reload the popover simply has no
 * breakdown until the next turn emits one.
 *
 * NO SILENT FALLBACKS: every category that cannot be measured at assembly is an
 * ABSENT field — never a fabricated 0. A malformed wire part parses to
 * `{ invalid: true }` and is surfaced by the popover, never coerced.
 */
export const CONTEXT_BREAKDOWN_DATA_NAME = 'brainstrike.context-breakdown';

export interface AssistantContextBreakdown {
  /**
   * Number of inline file (image) parts carried by the outgoing wire messages.
   * A measured 0 is honest (the wire was inspected and had none).
   */
  readonly attachmentsCount: number;
  /**
   * Heuristic tokens over the text parts of the outgoing wire messages.
   * ABSENT for memory-backed runs: Mastra recalls durable history server-side
   * AFTER this seam, so the wire carries only the current turn and measuring it
   * would understate the conversation. The renderer falls back to its own
   * client-side heuristic walk for the Conversation row.
   */
  readonly historyMessagesTokens?: number;
  /** Counting method — the shared chars/4 heuristic (see prompt-breakdown.ts). */
  readonly provenance: 'heuristic';
  /**
   * Heuristic tokens of the composed system instructions EXCLUDING the task
   * list note (which has its own row). Tool guidance is interleaved in the
   * instructions and not separable, so it is counted here — there is
   * deliberately no toolGuidanceTokens field until it can be measured honestly.
   */
  readonly systemInstructionsTokens: number;
  /** Heuristic tokens of the per-thread task list note. ABSENT when no task list block was injected. */
  readonly taskListTokens?: number;
}

/**
 * Renderer-side record for one thread's breakdown: either the parsed breakdown
 * or an explicit invalid marker for a malformed wire part (surfaced in the
 * popover, never silently dropped).
 */
export type AssistantContextBreakdownState =
  | { readonly invalid: true }
  | { readonly breakdown: AssistantContextBreakdown; readonly invalid: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** True when the value is a well-formed {@link AssistantContextBreakdown}. */
export function isAssistantContextBreakdown(value: unknown): value is AssistantContextBreakdown {
  if (!isRecord(value)) {
    return false;
  }
  if (value['provenance'] !== 'heuristic') {
    return false;
  }
  if (!(isCount(value['systemInstructionsTokens']) && isCount(value['attachmentsCount']))) {
    return false;
  }
  // Optional fields must be well-formed counts WHEN present (absent is the
  // honest not-measurable signal; a present-but-bogus value is malformed).
  if (value['taskListTokens'] !== undefined && !isCount(value['taskListTokens'])) {
    return false;
  }
  if (value['historyMessagesTokens'] !== undefined && !isCount(value['historyMessagesTokens'])) {
    return false;
  }
  return true;
}

/**
 * Parse a `brainstrike.context-breakdown` data-part payload into the renderer
 * store record. Malformed payloads become `{ invalid: true }` — surfaced by the
 * popover, never coerced into fake numbers. Unknown extra fields are tolerated
 * (additive wire evolution) but never forwarded.
 */
export function parseAssistantContextBreakdown(value: unknown): AssistantContextBreakdownState {
  if (!isAssistantContextBreakdown(value)) {
    return { invalid: true };
  }
  return {
    breakdown: {
      attachmentsCount: value.attachmentsCount,
      ...(value.historyMessagesTokens === undefined
        ? {}
        : { historyMessagesTokens: value.historyMessagesTokens }),
      provenance: value.provenance,
      systemInstructionsTokens: value.systemInstructionsTokens,
      ...(value.taskListTokens === undefined ? {} : { taskListTokens: value.taskListTokens }),
    },
    invalid: false,
  };
}
