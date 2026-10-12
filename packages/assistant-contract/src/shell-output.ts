/**
 * Live, incremental shell-command output.
 *
 * `brainstrike.executeCommand` streams its subprocess stdout/stderr as it is
 * produced so the user (and the model, via the tool card) can watch a long
 * build/test run instead of waiting for the whole output at the end.
 *
 * TRANSIENCE (deliberate): these slices ride their OWN data part, NOT a
 * run-event. Run-events are persisted server-side into the durable
 * `assistant_run_events` table (and their metadata is redaction-sanitized,
 * which strips `output`/`text` keys). Shell output would both bloat that table
 * and lose its content. Streaming it as a non-run-event StreamChunk means the
 * server's run-event persistence tap ignores it, so live slices are never
 * persisted — on reload the FINAL captured result (the tool's return value,
 * persisted by Mastra as the tool-invocation result) is the source of truth.
 * The agent host keeps the same rule: it sends these slices as uncommitted
 * `run/telemetry`, never as run-log rows (ADR-0011 amendment).
 */
export const SHELL_OUTPUT_DATA_NAME = 'brainstrike.shell-output';

/** One live slice of a running command's output, keyed to its tool call. */
export interface AssistantShellOutputPart {
  /** The incremental text (ANSI stripped). */
  readonly chunk: string;
  /** Which pipe the slice came from. */
  readonly stream: 'stdout' | 'stderr';
  /** The originating tool call, so the renderer can attach it to the card. */
  readonly toolCallId: string;
  /**
   * True only on the single terminal notice emitted when the streaming cap is
   * hit; the run continues but no further live slices are streamed.
   */
  readonly truncated?: boolean;
}

/**
 * The `type` of the chunk a command writes through its tool writer's `custom`,
 * which forwards it verbatim: the legacy stream mapper and the host's
 * `run/telemetry` notification both carry this wire shape.
 */
export const SHELL_OUTPUT_STREAM_PART_TYPE = 'brainstrike.shell-output.chunk';

/**
 * The slice a {@link SHELL_OUTPUT_STREAM_PART_TYPE} chunk carries, or undefined
 * when it names no tool call, pipe or text: a slice that cannot be attributed
 * is never rendered against a card.
 */
export function readShellOutputStreamPart(value: unknown): AssistantShellOutputPart | undefined {
  if (!value || typeof value !== 'object') {
    return;
  }
  const { chunk, stream, toolCallId, truncated, type } = value as Record<string, unknown>;
  if (
    type !== SHELL_OUTPUT_STREAM_PART_TYPE ||
    typeof chunk !== 'string' ||
    !(stream === 'stdout' || stream === 'stderr') ||
    typeof toolCallId !== 'string' ||
    toolCallId === ''
  ) {
    return;
  }
  return { chunk, stream, toolCallId, ...(truncated === true ? { truncated: true } : {}) };
}
