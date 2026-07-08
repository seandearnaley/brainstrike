import type { ToolLogger } from './types';

export interface GuardedToolError {
  error: {
    code: 'tool_timeout' | 'tool_failed';
    message: string;
    toolName: string;
  };
  ok: false;
}

const GUARDED_TOOL_ERROR_MESSAGE = 'The tool did not complete successfully. Try another approach.';
const GUARDED_TOOL_TIMEOUT_MESSAGE =
  'The tool timed out before returning a result. Try a smaller request or another approach.';

export function isGuardedToolError(value: unknown): value is GuardedToolError {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { ok?: unknown; error?: { code?: unknown } };
  return (
    candidate.ok === false &&
    typeof candidate.error === 'object' &&
    candidate.error !== null &&
    (candidate.error.code === 'tool_timeout' || candidate.error.code === 'tool_failed')
  );
}

interface ExecutableLike {
  execute: (...args: unknown[]) => unknown;
}

function hasExecute(tool: unknown): tool is ExecutableLike {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

export interface GuardOptions {
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
  const { toolName, timeoutMs, logger } = options;

  const cloned = Object.create(Object.getPrototypeOf(tool)) as ExecutableLike;
  Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));

  cloned.execute = async (...args: unknown[]): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GuardedToolError>((resolve) => {
      timer = setTimeout(() => {
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
      return {
        error: { code: 'tool_failed', message: GUARDED_TOOL_ERROR_MESSAGE, toolName },
        ok: false,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  return cloned as T;
}

export interface ApplyToolGuardsOptions {
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
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }
  return guarded as TMap;
}
