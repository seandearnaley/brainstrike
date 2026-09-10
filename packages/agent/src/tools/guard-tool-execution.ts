import { type GuardedToolError, ToolInputError } from '@brainstrike/assistant-contract';
import { readToolCallId, readToolExecutionThreadId } from './read-tool-call-id';
import type { ToolExecutionDurations } from './tool-execution-durations';
import { registerToolGuardDeadlineSignal } from './tool-guard-deadline';
import type { ToolLogger } from './types';

export type { GuardedToolError } from '@brainstrike/assistant-contract';
export { isGuardedToolError } from '@brainstrike/assistant-contract';

const GUARDED_TOOL_ERROR_MESSAGE = 'The tool did not complete successfully. Try another approach.';
const GUARDED_TOOL_TIMEOUT_MESSAGE =
  'The tool timed out before returning a result. Try a smaller request or another approach.';
const MAX_TOOL_INPUT_ERROR_MESSAGE_CHARS = 1000;
const TOOL_INPUT_ERROR_TRUNCATION_SUFFIX = '… [input error truncated]';

function boundToolInputErrorMessage(message: string): string {
  if (message.length <= MAX_TOOL_INPUT_ERROR_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(
    0,
    MAX_TOOL_INPUT_ERROR_MESSAGE_CHARS - TOOL_INPUT_ERROR_TRUNCATION_SUFFIX.length
  )}${TOOL_INPUT_ERROR_TRUNCATION_SUFFIX}`;
}

interface ExecutableLike {
  execute: (...args: unknown[]) => unknown;
}

function hasExecute(tool: unknown): tool is ExecutableLike {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

export interface GuardOptions {
  /**
   * Records how long `execute` actually ran, keyed by tool-call id.
   *
   * This wrapper is the ONLY place that observes real execution time. For an
   * approval-gated call the wall-clock between the stream's `tool.started` and
   * its terminal event spans the human approval wait, because the gate suspends
   * BEFORE `execute` is invoked — see `tool-execution-durations.ts`.
   *
   * Absent means no recording, which restores the pre-existing behaviour rather
   * than fabricating a duration.
   */
  durations?: ToolExecutionDurations;
  logger?: ToolLogger;
  timeoutMs: number;
  toolName: string;
}

/**
 * Wrap a Mastra-compatible tool so its `execute` can never freeze or crash the
 * run: on timeout or throw it resolves to a structured {@link GuardedToolError}.
 * Non-executable tools are returned unchanged.
 */
export function guardToolExecution<T>(tool: T, options: GuardOptions): T {
  if (!hasExecute(tool)) {
    return tool;
  }
  const original = tool.execute;
  const { toolName, timeoutMs, logger, durations } = options;

  const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableLike;
  Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));

  cloned.execute = async (...args: unknown[]): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Giving up on the race must also CANCEL the work, not merely stop waiting
    // for it: a cancellable tool (the MCP client's in-flight `tools/call`)
    // folds this signal into its own so the peer is told instead of being left
    // holding a request the run has already abandoned (BST-1594).
    const deadline = new AbortController();
    const releaseDeadline = registerToolGuardDeadlineSignal(args, deadline.signal, logger);
    const timeout = new Promise<GuardedToolError>((resolve) => {
      timer = setTimeout(() => {
        // Abort BEFORE resolving so cancellation is ordered ahead of the
        // model-facing answer rather than racing it.
        deadline.abort(new Error(`Tool "${toolName}" exceeded its ${timeoutMs}ms execution guard`));
        logger?.error('Tool execution timed out', { timeoutMs, toolName });
        resolve({
          error: {
            code: 'tool_timeout',
            message: GUARDED_TOOL_TIMEOUT_MESSAGE,
            toolName,
          },
          ok: false,
        });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    // Measured around the REAL execution, so a suspended-then-approved call is
    // billed for the work rather than the wait. Started here, after the timeout
    // timer is armed but before the call, so the two describe the same window.
    //
    // MONOTONIC, not wall-clock: a clock adjustment mid-execution would
    // otherwise produce a negative duration, or — worse, because nothing
    // downstream can detect it — a plausible inflated positive one.
    //
    // The window is the guard's, and the guard is the INNERMOST wrapper
    // (combinedTools → guards → hooks → permission gate → settlement). So this
    // excludes hook and settlement time, which is the intended definition of
    // "how long did the tool run" but does mean it disagrees slightly with the
    // tool.started → terminal delta even without an approval.
    const startedAt = performance.now();
    const run = (async () => Reflect.apply(original, cloned, args))();
    // If the timeout already won the race, the original may still reject later.
    // Log it instead of letting it become an unhandled rejection (no silent swallow).
    run.catch((error) => {
      logger?.error('Tool execution rejected (possibly after guard timeout)', { error, toolName });
    });
    try {
      return await Promise.race([run, timeout]);
    } catch (error) {
      logger?.error('Tool execution failed', { error, toolName });
      if (error instanceof ToolInputError) {
        return {
          error: {
            code: error.code,
            message: boundToolInputErrorMessage(error.message),
            toolName,
          },
          ok: false,
        };
      }
      return {
        error: { code: 'tool_failed', message: GUARDED_TOOL_ERROR_MESSAGE, toolName },
        ok: false,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      releaseDeadline();
      // Recorded for a timeout and a throw as well as a success: the terminal
      // run event those produce still needs an honest number, and "how long did
      // it run before failing" is exactly what a reader wants there.
      const toolCallId = readToolCallId(args);
      if (durations && toolCallId) {
        durations.record(
          toolCallId,
          performance.now() - startedAt,
          readToolExecutionThreadId(args)
        );
      }
    }
  };

  return cloned as T;
}

export interface ApplyToolGuardsOptions {
  durations?: ToolExecutionDurations;
  logger?: ToolLogger;
  timeoutMs: number;
}

/** Guard every executable tool in a Mastra tools map (native + MCP). */
export function applyToolGuards<TMap extends Record<string, unknown>>(
  tools: TMap,
  options: ApplyToolGuardsOptions
): TMap {
  const guarded: Record<string, unknown> = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    guarded[toolId] = guardToolExecution(tool, {
      timeoutMs: options.timeoutMs,
      toolName: toolId,
      ...(options.durations ? { durations: options.durations } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return guarded as TMap;
}
