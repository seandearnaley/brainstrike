import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Effect } from 'effect';
import { ProviderAuthFlowCancelledError, type ProviderAuthFlowError } from './errors.js';

/**
 * One deadline covers response headers and body for every OAuth request.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface GuardedFetchOptions {
  /** Flow cancellation; aborting rejects as ProviderAuthFlowCancelledError. */
  readonly cancelSignal?: AbortSignal;
  readonly fetchFn: typeof fetch;
  readonly init: RequestInit;
  /** Typed error thrown when the per-request timeout fires. */
  readonly onTimeout: () => ProviderAuthFlowError;
  readonly timeoutMs?: number;
  readonly url: string;
}

export interface GuardedFetchTextResult {
  readonly response: Response;
  readonly text: string;
}

function isAbortShaped(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function resolveTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_FETCH_TIMEOUT_MS;
  // Match AbortSignal.timeout's accepted range, including zero.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 4_294_967_295) {
    throw new RangeError('OAuth request timeout must be an integer from 0 to 4294967295 ms.');
  }
  return timeoutMs;
}

export async function guardedFetchText(
  options: GuardedFetchOptions
): Promise<GuardedFetchTextResult> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const cancellation = new AbortController();
  const onCancel = (): void => {
    cancellation.abort(new ProviderAuthFlowCancelledError('Flow cancelled during a network call.'));
  };
  options.cancelSignal?.addEventListener('abort', onCancel, { once: true });
  if (options.cancelSignal?.aborted) {
    onCancel();
  }

  let requestSignal: AbortSignal | undefined;
  // Non-abort failures pass through to the Promise caller unchanged.
  // @effect-diagnostics-next-line unknownInEffectCatch:off
  const request = Effect.tryPromise({
    // An abort this effect's own interruption caused (the deadline or the
    // caller) is discarded with the fiber; only `orElse` builds the timeout
    // error. In Node, DOMException is an Error, so it would otherwise build two.
    catch: (error: unknown): unknown =>
      isAbortShaped(error) && !requestSignal?.aborted ? options.onTimeout() : error,
    try: async (signal): Promise<GuardedFetchTextResult> => {
      requestSignal = signal;
      // A bare call preserves native browser fetch's required receiver.
      const { fetchFn } = options;
      const response = await fetchFn(options.url, { ...options.init, signal });
      return { response, text: await response.text() };
    },
  });
  const bounded = Effect.timeoutOrElse(request, {
    duration: timeoutMs,
    orElse: () => Effect.fail(options.onTimeout()),
  });
  try {
    return await runAtPromiseBoundary(bounded, { signal: cancellation.signal });
  } finally {
    options.cancelSignal?.removeEventListener('abort', onCancel);
  }
}
