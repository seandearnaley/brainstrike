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
