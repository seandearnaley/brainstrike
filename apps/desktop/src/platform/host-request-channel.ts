/**
 * Request/response correlation for the background host managers.
 *
 * One pending map, one per-request deadline, one duplicate-id guard, one
 * send-failure wrapper, one reject-all, one late-response path, usable by any
 * host manager regardless of transport (hidden `BrowserWindow`
 * `webContents.send` or `utilityProcess.postMessage`). The transport itself,
 * response payload interpretation, and any host-specific bookkeeping stay in
 * the adapter and reach the channel through the hooks below.
 *
 * Every host manager uses it: chunking, parser, db, llm and embedding. The
 * hooks carry their host-specific needs: `onLateResponse` for the DB host's
 * abandoned-request ledger, `onAbort` for the llm host's pre-cancel ledger and
 * cancel-to-host, and `onTimeout`'s `terminate` policy for a transaction whose
 * connection cannot survive an abandoned statement.
 *
 * This module deliberately never imports Electron: managers are constructed at
 * module scope before `app.whenReady`, so the channel must be safe to build in
 * a constructor. `@brainstrike/worker-runtime` is main-process safe for the
 * same reason — its entry declares types and two `Set` literals at module
 * scope, touches `Worker`/`MessageEvent` only in type positions, and is
 * already loaded in main by `chunking-host-shared` and
 * `renderer-host-lifecycle`.
 */

import { createLogger } from '@brainstrike/logging';
import { createRequestTracker } from '@brainstrike/worker-runtime';

const logger = createLogger('HostRequestChannel');

export type HostRequestTimeoutPolicy = 'abandon' | 'terminate';

interface HostRequestTimeoutDecisionFor<TPolicy extends HostRequestTimeoutPolicy> {
  readonly error: Error;
  readonly policy: TPolicy;
}

export interface HostRequestTimeoutContext {
  /** In-flight request count at the moment of the timeout, INCLUDING the timed-out request. */
  readonly pendingCount: number;
  /** Progress reports that re-armed this request's deadline before it finally expired. */
  readonly progressCount: number;
  readonly requestId: string;
  readonly startedAt: number;
  readonly timedOutAt: number;
  readonly timeoutMs: number;
}

/**
 * What a timeout means for this host. `abandon` rejects only the timed-out
 * request; `terminate` rejects it first, then every other in-flight request
 * with the SAME error, then hands the error to `terminate` so the adapter can
 * kill its transport (intended for the DB host's transaction requests, whose
 * connection state cannot survive an abandoned statement — not yet migrated).
 */
export type HostRequestTimeoutDecision =
  | HostRequestTimeoutDecisionFor<'abandon'>
  | (HostRequestTimeoutDecisionFor<'terminate'> & {
      readonly terminate: (error: Error) => void;
    });

export interface HostRequestAbortContext {
  readonly reason: unknown;
  readonly requestId: string;
}

export interface HostRequestChannelOptions<TRequest, TResponse> {
  /** Progress responses re-arm the deadline and reach `onProgress`; they never settle the request. Default: nothing is progress. */
  readonly isProgress?: (response: TResponse) => boolean;
  /**
   * Decide the error a request rejects with when its `signal` fires, and run
   * any abort side effect (e.g. send a cancel to the host). Default: the
   * signal's reason when it is an Error, else `<role> request <id> was aborted.`
   *
   * Unlike `onTimeout`, this runs AFTER the entry is released: `has()` and
   * `inFlight()` report the post-release state, so an adapter moving the entry
   * into its own ledger will not find it in the channel. Deliberate — the
   * abort side effect is a send, and the request is already unrecoverable.
   *
   * Not consulted at all when the signal is already aborted at `request()`
   * time: nothing was sent, so there is nothing to cancel, and the rejection
   * uses the signal's reason (or the default abort error) directly.
   */
  readonly onAbort?: (request: TRequest, context: HostRequestAbortContext) => Error;
  /**
   * A response whose id is not pending (timed out, aborted, rejected, or never
   * known). Default logs at warn — a late response is never dropped silently.
   * Adapters with their own ledger (DB abandoned-request map) take over here.
   */
  readonly onLateResponse?: (requestId: string, response: TResponse) => void;
  /**
   * Decide the timeout error and policy. Called while the request is still
   * counted as pending, so `context.pendingCount` and `inFlight()` include it.
   * Default: `abandon` with `<role> request <id> timed out after <ms>ms.`
   */
  readonly onTimeout?: (
    request: TRequest,
    context: HostRequestTimeoutContext
  ) => HostRequestTimeoutDecision;
  readonly requestId: (request: TRequest) => string;
  readonly responseId: (response: TResponse) => string;
  /** Human-readable host label used in error messages and log context, e.g. `Chunking host`. */
  readonly role: string;
  /** The transport write. Throwing here rejects the request with a wrapped send failure. */
  readonly send: (request: TRequest) => void;
  readonly timeoutMs: (request: TRequest) => number;
}

export interface HostRequestOptions<TResponse> {
  readonly onProgress?: ((response: TResponse) => void) | undefined;
  /** Aborting rejects with `signal.reason` when it is an Error, else a per-role abort error. */
  readonly signal?: AbortSignal | undefined;
}

export interface HostRequestChannel<TRequest, TResponse> {
  /** Route a host response to its pending request (progress re-arms the deadline; anything else settles it). */
  accept(response: TResponse): void;
  has(requestId: string): boolean;
  ids(): readonly string[];
  inFlight(): readonly TRequest[];
  /** Reject every in-flight request (process gone, window closed, stop, dispose). A factory mints a fresh Error per request. */
  rejectAll(reason: Error | ((requestId: string, request: TRequest) => Error)): void;
  /** Send and await the terminal response. The adapter interprets result vs error payloads. */
  request(request: TRequest, options?: HostRequestOptions<TResponse>): Promise<TResponse>;
  size(): number;
}

interface PendingHostRequest<TRequest, TResponse> {
  readonly onProgress: ((response: TResponse) => void) | undefined;
  progressCount: number;
  readonly reject: (error: Error) => void;
  releaseAbortListener: (() => void) | null;
  readonly request: TRequest;
  readonly requestId: string;
  readonly resolve: (response: TResponse) => void;
  readonly startedAt: number;
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function toAbortError(role: string, requestId: string, reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`${role} request ${requestId} was aborted.`);
}

function toSendFailure(role: string, requestId: string, error: unknown): Error {
  const message = `${role} request ${requestId} could not be sent`;
  return error instanceof Error
    ? new Error(`${message}: ${error.message}`, { cause: error })
    : new Error(`${message}.`);
}

function toThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createHostRequestChannel<TRequest, TResponse>(
  options: HostRequestChannelOptions<TRequest, TResponse>
): HostRequestChannel<TRequest, TResponse> {
  const { role } = options;
  const pending = createRequestTracker<PendingHostRequest<TRequest, TResponse>>();

  const release = (entry: PendingHostRequest<TRequest, TResponse>): void => {
    clearTimeout(entry.timer);
    entry.releaseAbortListener?.();
    entry.releaseAbortListener = null;
    pending.delete(entry.requestId);
  };

  const rejectAll = (reason: Error | ((requestId: string, request: TRequest) => Error)): void => {
    for (const [requestId, entry] of pending.drain()) {
      clearTimeout(entry.timer);
      entry.releaseAbortListener?.();
      entry.releaseAbortListener = null;
      entry.reject(typeof reason === 'function' ? reason(requestId, entry.request) : reason);
    }
  };

  const decideTimeout = (
    entry: PendingHostRequest<TRequest, TResponse>
  ): HostRequestTimeoutDecision => {
    const context: HostRequestTimeoutContext = {
      pendingCount: pending.size(),
      progressCount: entry.progressCount,
      requestId: entry.requestId,
      startedAt: entry.startedAt,
      timedOutAt: Date.now(),
      timeoutMs: entry.timeoutMs,
    };
    if (!options.onTimeout) {
      return {
        error: new Error(
          `${role} request ${entry.requestId} timed out after ${entry.timeoutMs}ms.`
        ),
        policy: 'abandon',
      };
    }
    try {
      return options.onTimeout(entry.request, context);
    } catch (error) {
      // The adapter's timeout bookkeeping failed; the request must still settle.
      return { error: toThrownError(error), policy: 'abandon' };
    }
  };

  const expire = (entry: PendingHostRequest<TRequest, TResponse>): void => {
    if (pending.get(entry.requestId) !== entry) {
      return;
    }
    const decision = decideTimeout(entry);
    release(entry);
    entry.reject(decision.error);
    if (decision.policy === 'terminate') {
      rejectAll(decision.error);
      try {
        decision.terminate(decision.error);
      } catch (error) {
        // Runs inside a timer callback: an adapter killing an already-dead
        // transport must not become an uncaught main-process exception. The
        // request is already rejected, so there is nothing left to settle.
        //
        // Only the request is settled, though — the transport is not. The
        // channel neither retries nor escalates, so a `terminate` that throws
        // leaves the host alive-but-wedged until the next timeout decides to
        // kill it again. Adapters must therefore make `terminate` idempotent
        // and self-healing rather than assume one call is the last word.
        logger.error(`${role} terminate hook failed while handling a request timeout`, {
          error,
          requestId: entry.requestId,
          role,
        });
      }
    }
  };

  const arm = (entry: PendingHostRequest<TRequest, TResponse>): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      expire(entry);
    }, entry.timeoutMs);

  const request = async (
    request: TRequest,
    requestOptions: HostRequestOptions<TResponse> = {}
  ): Promise<TResponse> => {
    const requestId = options.requestId(request);
    if (requestOptions.signal?.aborted) {
      throw toAbortError(role, requestId, requestOptions.signal.reason);
    }
    if (pending.has(requestId)) {
      throw new Error(`${role} request ${requestId} is already in flight.`);
    }

    return await new Promise<TResponse>((resolve, reject) => {
      const entry: PendingHostRequest<TRequest, TResponse> = {
        onProgress: requestOptions.onProgress,
        progressCount: 0,
        reject,
        releaseAbortListener: null,
        request,
        requestId,
        resolve,
        startedAt: Date.now(),
        timeoutMs: options.timeoutMs(request),
        // Armed right below: the deadline closure needs the entry to exist first.
        timer: undefined,
      };
      entry.timer = arm(entry);
      const { signal } = requestOptions;
      if (signal) {
        const onAbort = (): void => {
          if (pending.get(requestId) !== entry) {
            return;
          }
          release(entry);
          let abortError: Error;
          try {
            abortError = options.onAbort
              ? options.onAbort(request, { reason: signal.reason, requestId })
              : toAbortError(role, requestId, signal.reason);
          } catch (error) {
            // The adapter's abort side effect failed (e.g. cancelling on a host
            // that is already gone); the request must still settle.
            abortError = toThrownError(error);
          }
          reject(abortError);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.releaseAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
      pending.register(requestId, entry);

      try {
        options.send(request);
      } catch (error) {
        release(entry);
        reject(toSendFailure(role, requestId, error));
      }
    });
  };

  const accept = (response: TResponse): void => {
    const requestId = options.responseId(response);
    const entry = pending.get(requestId);
    if (!entry) {
      if (options.isProgress?.(response)) {
        // Trailing progress after the request left the map is expected, not a
        // correlation fault: a streaming host has frames in flight when it is
        // cancelled or times out, and it keeps emitting until the cancel
        // reaches it. Warning per frame would turn one cancellation into a
        // burst, so this never reaches `onLateResponse` — that hook is for
        // terminal responses, which is what an adapter's abandoned-request
        // ledger reasons about.
        logger.debug(`${role} progress arrived for a request that is no longer pending`, {
          requestId,
          role,
        });
        return;
      }
      if (options.onLateResponse) {
        try {
          options.onLateResponse(requestId, response);
        } catch (error) {
          // `accept` runs inside the transport listener (an IPC event handler
          // or a `utilityProcess` message listener); a consumer throw must not
          // escape into it.
          logger.error(`${role} late-response hook failed`, { error, requestId, role });
        }
        return;
      }
      logger.warn(`${role} response arrived for a request that is no longer pending`, {
        requestId,
        role,
      });
      return;
    }
    if (options.isProgress?.(response)) {
      // Progress is liveness: the deadline is an inactivity window, not a
      // wall-clock ceiling. A wedged host goes silent and still expires one
      // window after its last report.
      clearTimeout(entry.timer);
      entry.timer = arm(entry);
      entry.progressCount += 1;
      try {
        entry.onProgress?.(response);
      } catch (error) {
        // Same isolation as the late-response hook. The deadline is already
        // re-armed above, so a throwing consumer cannot shorten it either.
        logger.error(`${role} progress hook failed`, { error, requestId, role });
      }
      return;
    }
    release(entry);
    entry.resolve(response);
  };

  return {
    accept,
    has: (requestId) => pending.has(requestId),
    ids: () => pending.entries().map(([requestId]) => requestId),
    inFlight: () => pending.entries().map(([, entry]) => entry.request),
    rejectAll,
    request,
    size: () => pending.size(),
  };
}
