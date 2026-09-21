import { type GuardedToolError, ToolInputError } from '@brainstrike/assistant-contract';
import { readToolCallId, readToolExecutionThreadId } from './read-tool-call-id';
import type { ToolExecutionDurations } from './tool-execution-durations';
import { registerToolGuardDeadlineSignal } from './tool-guard-deadline';
import type { ToolLogger } from './types';

export type { GuardedToolError } from '@brainstrike/assistant-contract';
export { isGuardedToolError } from '@brainstrike/assistant-contract';

const GUARDED_TOOL_ERROR_MESSAGE = 'The tool did not complete successfully. Try another approach.';
const MAX_TOOL_INPUT_ERROR_MESSAGE_CHARS = 1000;

/**
 * The model-facing timeout text (BST-1777). It states the budget that actually
 * applied and, only when the tool's contract allows a longer one, how to ask
 * for it — the previous wording named neither, so the model could not tell a
 * 60s ceiling from a wedged tool and usually just retried.
 */
export function formatToolTimeoutMessage(
  timeoutMs: number,
  declaredMaxMs: number | undefined
): string {
  const head = `The tool did not finish within its ${Math.round(
    timeoutMs / 1000
  )}s execution budget and was cancelled.`;
  if (declaredMaxMs === undefined) {
    return `${head} Try a smaller request or another approach.`;
  }
  return `${head} Pass a larger timeoutMs (max ${declaredMaxMs}) if the work legitimately needs longer, or split it into smaller steps.`;
}
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

/** A fixed budget, or one resolved from the call's args (input first). */
export type ToolGuardTimeout = number | ((args: readonly unknown[]) => number);

export interface GuardOptions {
  /** `maxMs` of the tool's declared execution budget; shapes the timeout remedy. */
  declaredMaxMs?: number;
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
  timeoutMs: ToolGuardTimeout;
  toolName: string;
}

function resolveCallTimeoutMs(timeout: ToolGuardTimeout, args: readonly unknown[]): number {
  const resolved = typeof timeout === 'function' ? timeout(args) : timeout;
  if (!(Number.isSafeInteger(resolved) && resolved > 0)) {
    throw new Error(`Tool guard resolved a non-positive budget: ${String(resolved)}`);
  }
  return resolved;
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
  const { toolName, logger, durations } = options;

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
    // Measured around the REAL execution, so a suspended-then-approved call is
    // billed for the work rather than the wait. Started here, before budget
    // resolution or the call, so the duration is honest even when resolving
    // the budget itself throws.
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
    try {
      const timeoutMs = resolveCallTimeoutMs(options.timeoutMs, args);
      const timeout = new Promise<GuardedToolError>((resolve) => {
        timer = setTimeout(() => {
          // Abort BEFORE resolving so cancellation is ordered ahead of the
          // model-facing answer rather than racing it.
          deadline.abort(
            new Error(`Tool "${toolName}" exceeded its ${timeoutMs}ms execution guard`)
          );
          logger?.error('Tool execution timed out', { timeoutMs, toolName });
          resolve({
            error: {
              code: 'tool_timeout',
              message: formatToolTimeoutMessage(timeoutMs, options.declaredMaxMs),
              toolName,
            },
            ok: false,
          });
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });

      const run = (async () => Reflect.apply(original, cloned, args))();
      // If the timeout already won the race, the original may still reject later.
      // Log it instead of letting it become an unhandled rejection (no silent swallow).
      run.catch((error) => {
        logger?.error('Tool execution rejected (possibly after guard timeout)', {
          error,
          toolName,
        });
      });
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
  /** `maxMs` of a tool's declared budget, by tool id; absent for undeclared tools. */
  declaredMaxMs?: (toolId: string) => number | undefined;
  durations?: ToolExecutionDurations;
  logger?: ToolLogger;
  timeoutMs: number | ((toolId: string) => ToolGuardTimeout);
}

/** Guard every executable tool in a Mastra tools map (native + MCP). */
export function applyToolGuards<TMap extends Record<string, unknown>>(
  tools: TMap,
  options: ApplyToolGuardsOptions
): TMap {
  const guarded: Record<string, unknown> = {};
  for (const [toolId, tool] of Object.entries(tools)) {
    const declaredMaxMs = options.declaredMaxMs?.(toolId);
    guarded[toolId] = guardToolExecution(tool, {
      timeoutMs:
        typeof options.timeoutMs === 'function' ? options.timeoutMs(toolId) : options.timeoutMs,
      toolName: toolId,
      ...(declaredMaxMs === undefined ? {} : { declaredMaxMs }),
      ...(options.durations ? { durations: options.durations } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return guarded as TMap;
}
