import { ProviderAuthFlowCancelledError, type ProviderAuthFlowError } from './errors';

/**
 * Abort + timeout guards for every network call the OAuth engine makes
 * (security-review finding 4): no token exchange, device poll, or refresh
 * fetch may hang forever, and a flow cancel must reject a stalled call
 * promptly instead of waiting on a dead socket.
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

function isAbortShaped(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export async function guardedFetch(options: GuardedFetchOptions): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const signal = options.cancelSignal
    ? AbortSignal.any([options.cancelSignal, timeoutSignal])
    : timeoutSignal;
  try {
    return await options.fetchFn(options.url, { ...options.init, signal });
  } catch (error) {
    if (options.cancelSignal?.aborted) {
      throw new ProviderAuthFlowCancelledError('Flow cancelled during a network call.');
    }
    if (isAbortShaped(error)) {
      throw options.onTimeout();
    }
    throw error;
  }
}
