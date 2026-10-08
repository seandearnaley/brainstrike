import type { ProviderAuthErrorCode } from '@brainstrike/assistant-contract';
import { type PromiseBoundaryOptions, runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, type Effect } from 'effect';

/**
 * Typed failure for provider-auth flows (BST-1355). `code` is the ONLY part
 * that ever crosses IPC (inside `{ state: 'error', code }` status payloads);
 * `message` stays in main-process logs and may carry bounded diagnostic
 * detail, but NEVER token material.
 */
export class ProviderAuthFlowError extends Error {
  readonly code: ProviderAuthErrorCode;

  constructor(code: ProviderAuthErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProviderAuthFlowError';
    this.code = code;
  }
}

/**
 * A flow ended because the user cancelled it (programmatic cancel or the
 * loopback /cancel path). Deliberately NOT a {@link ProviderAuthFlowError}:
 * cancellation is not a failure — the engine maps it back to the idle status
 * instead of an `error` status.
 */
export class ProviderAuthFlowCancelledError extends Error {
  readonly _tag = 'ProviderAuthFlowCancelledError';

  constructor(message = 'Provider auth flow cancelled') {
    super(message);
    this.name = 'ProviderAuthFlowCancelledError';
  }
}

export function isProviderAuthFlowCancelled(
  error: unknown
): error is ProviderAuthFlowCancelledError {
  return error instanceof ProviderAuthFlowCancelledError;
}

/**
 * Inside an effect: a request, body read or injected wait that failed for its
 * own reason. `cause` is the original rejection, which callers receive
 * unchanged at {@link runProviderAuthEffect}.
 */
export class ProviderAuthRequestFailure extends Data.TaggedError('ProviderAuthRequestFailure')<{
  readonly cause: unknown;
}> {}

export type ProviderAuthEffectError =
  | ProviderAuthFlowCancelledError
  | ProviderAuthFlowError
  | ProviderAuthRequestFailure;

/** A rejection's typed form in an effect's error channel. */
export function toProviderAuthEffectError(error: unknown): ProviderAuthEffectError {
  return error instanceof ProviderAuthFlowError ||
    error instanceof ProviderAuthFlowCancelledError ||
    error instanceof ProviderAuthRequestFailure
    ? error
    : new ProviderAuthRequestFailure({ cause: error });
}

/** The flows' Promise boundary: a wrapped rejection leaves exactly as it arrived. */
export async function runProviderAuthEffect<A>(
  effect: Effect.Effect<A, ProviderAuthEffectError>,
  options: PromiseBoundaryOptions = {}
): Promise<A> {
  try {
    return await runAtPromiseBoundary(effect, options);
  } catch (error) {
    throw error instanceof ProviderAuthRequestFailure ? error.cause : error;
  }
}
