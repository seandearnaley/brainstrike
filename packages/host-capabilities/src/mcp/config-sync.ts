import type { McpHostServerSnapshot } from '@brainstrike/assistant-contract';
import { errorMessage, type McpConfigWriteResult } from './config-file.js';

/**
 * A step after a config write that threw: which one, and why. Only the runtime
 * reload is one; a config watcher that cannot restart is `watchError` instead.
 */
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

/**
 * A destructive lifecycle control (disconnect, reauthorize), then the config
 * reload that follows it whatever the control's outcome. When both fail, both
 * failures surface.
 */
export async function controlThenReloadConfig(
  control: () => Promise<McpHostServerSnapshot>,
  reloadConfig: () => Promise<void>
): Promise<McpHostServerSnapshot> {
  let controlFailure: unknown;
  let result: McpHostServerSnapshot | undefined;
  try {
    result = await control();
  } catch (cause) {
    controlFailure = cause;
  }
  try {
    await reloadConfig();
  } catch (reloadFailure) {
    if (controlFailure !== undefined) {
      throw new AggregateError(
        [controlFailure, reloadFailure],
        'MCP lifecycle control and config reload both failed'
      );
    }
    throw reloadFailure;
  }
  if (controlFailure !== undefined) {
    throw controlFailure;
  }
  if (result === undefined) {
    throw new Error('MCP lifecycle control completed without a result');
  }
  return result;
}
