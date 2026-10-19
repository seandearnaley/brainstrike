import { errorMessage, type McpConfigWriteResult } from './config-file.js';

/** A step after a config write that threw: which one, and why. */
export interface McpConfigSyncFailure {
  readonly error: unknown;
  readonly step: string;
}

/** A config write's result, and the sync step after it that failed, if any. */
export interface McpConfigWriteSync {
  readonly result: McpConfigWriteResult;
  readonly syncFailure?: McpConfigSyncFailure;
}

/**
 * What a failed sync step surfaces: its own error after a successful write;
 * after a failed write, that failure first, then the step's, which is the cause.
 */
export function syncFailureError(
  result: McpConfigWriteResult,
  failure: McpConfigSyncFailure,
  suffix?: string
): unknown {
  if (result.success) {
    return failure.error;
  }
  const tail = suffix === undefined ? '' : `; ${suffix}`;
  return new Error(`${result.error}; ${failure.step}: ${errorMessage(failure.error)}${tail}`, {
    cause: failure.error,
  });
}
