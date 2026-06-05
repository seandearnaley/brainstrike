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
        logger?.error('Tool execution timed out', { toolName, timeoutMs });
        resolve({
          ok: false,
          error: {
            code: 'tool_timeout',
            message: GUARDED_TOOL_TIMEOUT_MESSAGE,
            toolName,
          },
        });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      const run = (async () => Reflect.apply(original, cloned, args))();
      return await Promise.race([run, timeout]);
    } catch (error) {
      logger?.error('Tool execution failed', { toolName, error });
      return {
        ok: false,
        error: { code: 'tool_failed', message: GUARDED_TOOL_ERROR_MESSAGE, toolName },
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  return cloned as T;
}
