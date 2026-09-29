/**
 * Parser host manager.
 *
 * Owns the lifecycle of an Electron `utilityProcess` running the
 * parser-host-entry module. Request/response correlation (pending map,
 * per-request deadline, reject-all on exit/stop, late-response logging) is
 * the shared `createHostRequestChannel`; this file owns only the transport
 * and the parser's "never reject, always answer" response contract. Parsing
 * is stateless: no transactions, no live queries, no draining. Each parse is
 * a single round-trip request/response.
 *
 * Public API: `parse(request)` returns the response. `stop()` kills the
 * host and fails any in-flight requests.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import { runAtPromiseBoundary, runWithTimeout } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { Effect, Exit, Scope } from 'effect';
import { type UtilityProcess, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { isParserHostParseResponse } from './parser-host-schema';
import type { ParserHostParseRequest, ParserHostParseResponse } from './parser-host-shared';
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';

const logger = createLogger('ParserHostManager');
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 500;

export interface ParserHostManagerOptions {
  /** Path to the parser-host-entry.js bundled output. Defaults to a sibling lookup. */
  readonly entryPath?: string;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Maximum caller wait for Stop; owned cleanup continues until actual exit. */
  readonly stopTimeoutMs?: number;
}

export function resolveParserHostEntryPath(currentModuleFilename?: string): string {
  return resolveBundledSiblingPath(
    'Parser host entry',
    'parser-host-entry.js',
    currentModuleFilename
  );
}

/** Longest content-derived string this summary will repeat into a log. */
const MAX_SUMMARY_STRING_LENGTH = 64;
/** Most keys this summary will name; the full count is always reported. */
const MAX_SUMMARY_KEYS = 20;

function truncateForLog(value: string): string {
  return value.length <= MAX_SUMMARY_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_SUMMARY_STRING_LENGTH)}…`;
}

/**
 * Describe an unusable host message without logging it. Parser traffic carries
 * user source text and ASTs, so the raw payload must never reach the log:
 * only its shape does. `parser-host-entry` posts nothing but
 * `ParserHostParseResponse` frames (no handshake/ready/log frames), so every
 * message that fails this check is a real fault, not normal traffic.
 *
 * Every field here is bounded, because a malformed frame's *shape* is
 * content-controlled too: a mis-serialized response can put source text in a
 * key or in `type`, and a record keyed by identifier or path has as many keys
 * as the payload has content. Counts are exact; the strings behind them are
 * truncated.
 */
function summarizeMalformedMessage(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return { messageType: value === null ? 'null' : typeof value };
  }
  if (Array.isArray(value)) {
    // Keys of a large array would be as unbounded as the payload itself.
    return { length: value.length, messageType: 'array' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    keyCount: keys.length,
    keys: keys.slice(0, MAX_SUMMARY_KEYS).map(truncateForLog),
    messageType: 'object',
    ...(typeof record['type'] === 'string' ? { type: truncateForLog(record['type']) } : {}),
  };
}

interface ParserGeneration {
  closePromise: Promise<void> | null;
  readonly exited: Promise<void>;
  exitObserved: boolean;
  readonly host: UtilityProcess;
  readonly scope: Scope.Closeable;
  setup: Promise<void>;
  state: 'live' | 'stop-failed' | 'closing' | 'closed';
}

export class ParserHostManager {
  readonly #entryPath: string;
  readonly #requestTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  #current: ParserGeneration | null = null;
  readonly #owned = new Set<ParserGeneration>();
  readonly #requests: HostRequestChannel<ParserHostParseRequest, ParserHostParseResponse>;

  constructor(options: ParserHostManagerOptions = {}) {
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    if (!(Number.isFinite(this.#stopTimeoutMs) && this.#stopTimeoutMs > 0)) {
      throw new RangeError('parser host stopTimeoutMs must be positive and finite');
    }
    this.#entryPath = options.entryPath ?? resolveParserHostEntryPath();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#requests = createHostRequestChannel<ParserHostParseRequest, ParserHostParseResponse>({
      onTimeout: (_request, context) => ({
        error: new Error(`parser host timeout after ${context.timeoutMs}ms`),
        policy: 'abandon',
      }),
      requestId: (request) => request.requestId,
      responseId: (response) => response.requestId,
      role: 'Parser host',
      send: (request) => {
        try {
          this.#ensureHost().postMessage(request);
        } catch (error) {
          // A failed fork or postMessage is an infrastructure fault, not a
          // parse failure. `parse()` converts it to `ok: false` per the
          // always-answer contract, so without this it would be visible only
          // to whoever inspects the response object.
          logger.error('Parser host request could not be sent', {
            error,
            requestId: request.requestId,
          });
          throw error;
        }
      },
      timeoutMs: () => this.#requestTimeoutMs,
    });
  }

  async parse(request: ParserHostParseRequest): Promise<ParserHostParseResponse> {
    try {
      return await this.#requests.request(request);
    } catch (error) {
      // The parser contract answers every request; failures travel as `ok: false`.
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: request.requestId,
      };
    }
  }

  async stop(): Promise<void> {
    // Each call includes detached generations still closing, plus any replacement.
    const generations = [...this.#owned];
    this.#requests.rejectAll(new Error('parser host stopped'));
    if (generations.length === 0) {
      return;
    }
    // Initiate kill synchronously; only the caller wait is bounded, never Scope.close.
    const observedFailures = new Map<number, unknown>();
    const closing = Promise.allSettled(
      generations.map((generation, index) =>
        this.#stopGeneration(generation).catch((error: unknown) => {
          observedFailures.set(index, error);
          throw error;
        })
      )
    );
    const outcomes = await runWithTimeout(() => closing, {
      onTimeout: () => {
        const timeout = new Error(`parser host stop timeout after ${this.#stopTimeoutMs}ms`);
        const failures = [...observedFailures.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, error]) => error);
        return failures.length === 0
          ? timeout
          : new AggregateError([...failures, timeout], 'Failed to stop parser host generations');
      },
      timeoutMs: this.#stopTimeoutMs,
    });
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : []
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to stop parser host generations');
    }
  }

  #stopGeneration(generation: ParserGeneration): Promise<void> {
    if (generation.closePromise) {
      return generation.closePromise;
    }
    if (generation.exitObserved) {
      return this.#closeGeneration(generation);
    }
    generation.state = 'stop-failed';
    try {
      if (!generation.host.kill()) {
        return Promise.reject(new Error('parser host could not be stopped'));
      }
    } catch (error) {
      return Promise.reject(error);
    }
    generation.state = 'closing';
    if (this.#current === generation) {
      this.#current = null;
    }
    return this.#closeGeneration(generation);
  }

  #closeGeneration(generation: ParserGeneration): Promise<void> {
    if (generation.closePromise) {
      return generation.closePromise;
    }
    generation.state = 'closing';
    if (this.#current === generation) {
      this.#current = null;
    }
    const closing = (async () => {
      // Registration is synchronous, but its Promise must still be observed/joined.
      let setupFailure: unknown;
      let setupFailed = false;
      try {
        await generation.setup;
      } catch (error) {
        setupFailed = true;
        setupFailure = error;
      }
      try {
        await runAtPromiseBoundary(Scope.close(generation.scope, Exit.void));
      } catch (cleanupError) {
        if (setupFailed) {
          throw new AggregateError(
            [setupFailure, cleanupError],
            'Parser host setup and cleanup failed'
          );
        }
        throw cleanupError;
      } finally {
        generation.state = 'closed';
        this.#owned.delete(generation);
      }
      if (setupFailed) {
        throw setupFailure;
      }
    })();
    generation.closePromise = closing;
    return closing;
  }

  #ensureHost(): UtilityProcess {
    if (this.#current) {
      if (this.#current.state !== 'live') {
        throw new Error('parser host stop failed; retry stop before parsing');
      }
      return this.#current.host;
    }
    const host = utilityProcess.fork(this.#entryPath);
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    const generation: ParserGeneration = {
      closePromise: null,
      exited,
      exitObserved: false,
      host,
      scope: Scope.makeUnsafe(),
      setup: Promise.resolve(),
      state: 'live',
    };
    this.#owned.add(generation);
    this.#current = generation;
    const onExit = (): void => {
      generation.exitObserved = true;
      markExited();
      if (this.#current === generation) {
        this.#current = null;
        this.#requests.rejectAll(new Error('parser host exited unexpectedly'));
      }
      // Finish synchronous acquisition/kill before closing its registered Scope.
      queueMicrotask(() => {
        void this.#closeGeneration(generation).catch((error: unknown) => {
          logger.error('Parser host generation cleanup failed', { error });
        });
      });
    };
    const onMessage = (message: unknown): void => {
      if (this.#current === generation && generation.state === 'live') {
        this.#handleResponse(message);
      }
    };
    // Observe exit before any later listener acquisition can fail; PID is not proof.
    host.on('exit', onExit);
    generation.setup = runAtPromiseBoundary(
      Effect.gen(function* () {
        yield* Scope.addFinalizer(
          generation.scope,
          Effect.sync(() => {
            host.removeListener('exit', onExit);
          })
        );
        yield* Scope.addFinalizer(
          generation.scope,
          Effect.sync(() => {
            host.removeListener('message', onMessage);
          })
        );
        yield* Scope.addFinalizer(
          generation.scope,
          Effect.promise(() => exited)
        );
      })
    );
    void generation.setup.catch((error: unknown) => {
      if (generation.state === 'live') {
        generation.state = 'stop-failed';
      }
      if (this.#current === generation) {
        this.#requests.rejectAll(error instanceof Error ? error : new Error(String(error)));
      }
      logger.error('Parser host resource registration failed', { error });
    });
    try {
      host.on('message', onMessage);
    } catch (error) {
      generation.state = 'stop-failed';
      void this.#stopGeneration(generation).catch((cleanupError: unknown) => {
        logger.error('Parser host acquisition cleanup failed', { error: cleanupError });
      });
      throw error;
    }
    if (generation.exitObserved) {
      throw new Error('parser host exited unexpectedly');
    }
    return host;
  }

  #handleResponse(message: unknown): void {
    if (!isParserHostParseResponse(message)) {
      logger.warn('Ignored malformed parser host message', summarizeMalformedMessage(message));
      return;
    }
    this.#requests.accept(message);
  }
}
