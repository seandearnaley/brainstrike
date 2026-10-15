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

/** One tool definition's measured share of the prompt (name + schema + description). */
export interface AssistantToolDefinitionTokens {
  readonly name: string;
  readonly tokens: number;
}

/**
 * One tool's share of the prompt's tool calls and results: the calls' inputs
 * plus their results as the provider receives them (a rewritten result counts
 * as its marker).
 */
export interface AssistantToolCallUsage {
  readonly calls: number;
  readonly tokens: number;
  readonly toolName: string;
}

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
  /**
   * Counting method for the instruction/message figures — always the shared
   * chars/4 heuristic (see prompt-breakdown.ts). Deliberately NOT upgraded when
   * the tool-definition figures are tokenizer-measured: a whole-breakdown
   * 'measured' would assert more precision than the payload has (provenance
   * must never lie). Tool-definition precision rides its own field below.
   */
  readonly provenance: 'heuristic';
  /**
   * Heuristic tokens of the composed system instructions EXCLUDING the task
   * list note (which has its own row). Tool guidance is interleaved in the
   * instructions and not separable, so it is counted here.
   */
  readonly systemInstructionsTokens: number;
  /** Heuristic tokens of the per-thread task list note. ABSENT when no task list block was injected. */
  readonly taskListTokens?: number;
  /**
   * Per-tool totals behind `toolCallsTokens`, sorted descending by tokens.
   * Present iff `toolCallsTokens` is.
   */
  readonly toolCallsByTool?: readonly AssistantToolCallUsage[];
  /**
   * Heuristic tokens of every tool call input and tool result in the prompt,
   * as sent. ABSENT when the producer did not measure them (never zero-faked);
   * those tokens then remain in Unattributed.
   */
  readonly toolCallsTokens?: number;
  /**
   * Per-tool definition token counts, sorted descending by tokens. ABSENT when
   * the run's tool-definition measurement failed (never zero-faked).
   */
  readonly toolDefinitionsByTool?: readonly AssistantToolDefinitionTokens[];
  /**
   * Counting method for the tool-definition figures ONLY: 'measured' when the
   * run's tokenizer-backed measurement (RunTokenDiagnostics) counted them,
   * 'heuristic' on the chars/4 backstop. Present iff the tool-definition
   * fields are present.
   */
  readonly toolDefinitionsProvenance?: 'heuristic' | 'measured';
  /**
   * Total serialized tool-definition tokens on this run's provider request
   * (names + descriptions + JSON schemas). ABSENT when measurement failed.
   */
  readonly toolDefinitionsTokens?: number;
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

function isToolCallUsageEntry(value: unknown): value is AssistantToolCallUsage {
  return (
    isRecord(value) &&
    typeof value['toolName'] === 'string' &&
    value['toolName'].length > 0 &&
    isCount(value['tokens']) &&
    isCount(value['calls'])
  );
}

function isToolDefinitionTokensEntry(value: unknown): value is AssistantToolDefinitionTokens {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0 &&
    isCount(value['tokens'])
  );
}

/** True when the value is a well-formed {@link AssistantContextBreakdown}. */
export function isAssistantContextBreakdown(value: unknown): value is AssistantContextBreakdown {
  if (!isRecord(value)) {
    return false;
  }
  if (value['provenance'] !== 'heuristic') {
    return false;
  }
  if (
    value['toolDefinitionsProvenance'] !== undefined &&
    value['toolDefinitionsProvenance'] !== 'heuristic' &&
    value['toolDefinitionsProvenance'] !== 'measured'
  ) {
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
  if (value['toolDefinitionsTokens'] !== undefined && !isCount(value['toolDefinitionsTokens'])) {
    return false;
  }
  if (
    value['toolDefinitionsByTool'] !== undefined &&
    !(
      Array.isArray(value['toolDefinitionsByTool']) &&
      value['toolDefinitionsByTool'].every(isToolDefinitionTokensEntry)
    )
  ) {
    return false;
  }
  return hasWellFormedToolCalls(value);
}

/** The tool-call total and its per-tool rows arrive together or not at all. */
function hasWellFormedToolCalls(value: Record<string, unknown>): boolean {
  const total = value['toolCallsTokens'];
  const byTool = value['toolCallsByTool'];
  if (total === undefined && byTool === undefined) {
    return true;
  }
  return isCount(total) && Array.isArray(byTool) && byTool.every(isToolCallUsageEntry);
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
      ...(value.toolCallsTokens === undefined || value.toolCallsByTool === undefined
        ? {}
        : {
            toolCallsByTool: value.toolCallsByTool.map(({ calls, tokens, toolName }) => ({
              calls,
              tokens,
              toolName,
            })),
            toolCallsTokens: value.toolCallsTokens,
          }),
      ...(value.toolDefinitionsByTool === undefined
        ? {}
        : {
            toolDefinitionsByTool: value.toolDefinitionsByTool.map(({ name, tokens }) => ({
              name,
              tokens,
            })),
          }),
      ...(value.toolDefinitionsProvenance === undefined
        ? {}
        : { toolDefinitionsProvenance: value.toolDefinitionsProvenance }),
      ...(value.toolDefinitionsTokens === undefined
        ? {}
        : { toolDefinitionsTokens: value.toolDefinitionsTokens }),
    },
    invalid: false,
  };
}

/**
 * One tool call as a provider request carried it: its input and its result,
 * measured on the exact prompt with the chars/4 heuristic. `output` is
 * `marker` when the result went out as a committed projection rewrite, and
 * `absent` when the request carried the call without its result.
 */
export interface PromptToolCall {
  readonly inputTokens: number;
  readonly output: 'absent' | 'full' | 'marker';
  readonly outputTokens: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * The tool calls one provider request carried, as a change from the previous
 * request of the same run. A run's first request is `run-start` and lists every
 * call; later requests list only the calls that entered or changed, and the
 * ids that left. A consumer folds a run's requests in commit order.
 */
export interface PromptToolCallWindow {
  readonly base: 'previous' | 'run-start';
  readonly removed: readonly string[];
  readonly upserted: readonly PromptToolCall[];
}

function samePromptToolCall(a: PromptToolCall, b: PromptToolCall): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.output === b.output &&
    a.outputTokens === b.outputTokens &&
    a.toolName === b.toolName
  );
}

/**
 * The window that turns `previous` (the run's previous request, or none) into
 * `next`. Producer side of {@link applyPromptToolCallWindow}.
 */
export function diffPromptToolCallWindow(
  previous: ReadonlyMap<string, PromptToolCall> | undefined,
  next: readonly PromptToolCall[]
): PromptToolCallWindow {
  if (!previous) {
    return { base: 'run-start', removed: [], upserted: [...next] };
  }
  const present = new Set<string>();
  const upserted: PromptToolCall[] = [];
  for (const call of next) {
    present.add(call.toolCallId);
    const before = previous.get(call.toolCallId);
    if (!(before && samePromptToolCall(before, call))) {
      upserted.push(call);
    }
  }
  const removed = [...previous.keys()].filter((id) => !present.has(id));
  return { base: 'previous', removed, upserted };
}

/**
 * The request's complete tool-call set from the run's previous set and this
 * request's window. A `previous` window with no earlier request of its run is
 * a producer fault and throws; it is never read as a fresh start.
 */
export function applyPromptToolCallWindow(
  previous: ReadonlyMap<string, PromptToolCall> | undefined,
  window: PromptToolCallWindow
): Map<string, PromptToolCall> {
  if (window.base === 'previous' && !previous) {
    throw new Error('A tool-call window continues a request its run never committed.');
  }
  const next = new Map(window.base === 'run-start' ? [] : previous);
  for (const id of window.removed) {
    next.delete(id);
  }
  for (const call of window.upserted) {
    next.set(call.toolCallId, call);
  }
  return next;
}
