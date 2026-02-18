/**
 * Shared tool types and error handling for all Mastra-compatible tools.
 *
 * Centralizes the ToolContext interface and error handling pattern
 * that was previously duplicated across 6 tool files.
 */

/**
 * Context type for Mastra tool execution.
 * The Mastra framework wraps tool input in this shape.
 */
export interface ToolContext<TInput> {
  context: TInput;
}

/**
 * Logger interface shared by all tool dependencies.
 */
export interface ToolLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Handles errors from tool operations with a consistent pattern:
 * 1. If the error message is in the safe errors set, re-throw as-is
 * 2. Otherwise, log the raw error and throw the default message
 *
 * @param error - The caught error
 * @param safeErrors - Set of error messages safe to expose to users
 * @param defaultMessage - Fallback message when error is not safe
 * @param logger - Optional logger for recording unsafe errors
 */
export function handleToolError(
  error: unknown,
  safeErrors: ReadonlySet<string>,
  defaultMessage: string,
  logger?: ToolLogger
): never {
  const message = error instanceof Error ? error.message : defaultMessage;

  if (safeErrors.has(message)) {
    throw new Error(message);
  }

  logger?.error('Tool operation failed', { error });
  throw new Error(defaultMessage, { cause: error });
}
