/**
 * oxc-IPC parser adapter.
 *
 * Routes parse calls from the chunking worker, through Electron IPC, to the
 * native `oxc-parser` running in the parser-host utility process. Used only
 * when selected by the Electron desktop chunking-host renderer. The shared
 * facade statically imports this adapter; browser execution selects Babel.
 *
 * Why this isn't combined with babel-adapter behind a uniform fetch:
 *  - Babel runs IN the worker (in-process, sync logic).
 *  - oxc runs in a SEPARATE OS process (cross-process IPC, async).
 * Same `ParserAdapter` contract, different mechanism. The facade hides
 * the difference from `portable-chunking.ts`.
 *
 * ── Why a postMessage bridge (not `import('electron')`) ──────────────────
 * Earlier iteration of this file used `import('electron')` from within the
 * Web Worker bundle to call `ipcRenderer.invoke` directly. That's wrong:
 * with the project's webPreferences (contextIsolation: true, sandbox: on,
 * nodeIntegrationInWorker: off — default), workers cannot load the
 * `electron` module — and even if they could, ipcRenderer wouldn't function
 * across the contextBridge boundary.
 *
 * Correct architecture (this file):
 *   1. Worker: `self.postMessage({ type: 'parser-host:invoke', requestId, payload })`
 *   2. Renderer (parent thread): receives the worker message, calls
 *      `window.parserHost.parse(payload)` — which is exposed via preload's
 *      contextBridge and goes through ipcRenderer.invoke.
 *   3. Renderer: posts the response back as
 *      `{ type: 'parser-host:reply', requestId, response }`.
 *   4. Worker: this adapter's listener correlates by requestId and resolves
 *      the original parse promise.
 *
 * The renderer-side bridge handler lives in
 * `packages/file-import/src/chunking-worker-context.tsx` (added in a
 * follow-up commit on this branch). The preload-exposed
 * `window.parserHost.parse` lives in `apps/desktop/src/preload.ts`.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { Data, Effect, Predicate, Schema } from 'effect';

import type { AstNode, ParseOptions, ParserAdapter } from './types';

const PARSER_HOST_INVOKE = 'parser-host:invoke';
const PARSER_HOST_REPLY = 'parser-host:reply';

const REQUEST_TIMEOUT_MS = 30_000;

/** Mirrors `ParserHostParseResponse` from apps/desktop without importing it. */
type IpcParseResponse =
  | { readonly ok: true; readonly requestId: string; readonly root: AstNode }
  | { readonly ok: false; readonly requestId: string; readonly error: string };

interface InvokeEnvelope {
  readonly payload: {
    readonly content: string;
    readonly options: ParseOptions;
    readonly requestId: string;
  };
  readonly requestId: string;
  readonly type: typeof PARSER_HOST_INVOKE;
}

interface ReplyEnvelope {
  readonly requestId: string;
  readonly response: IpcParseResponse;
  readonly type: typeof PARSER_HOST_REPLY;
}

interface WorkerSelfLike {
  readonly addEventListener: (
    type: 'message',
    listener: (event: { data?: unknown }) => void
  ) => void;
  readonly postMessage: (message: InvokeEnvelope) => void;
}

const opaqueRootSchema = Schema.declare<AstNode>((value): value is AstNode =>
  Predicate.isObjectOrArray(value)
);
const successSchema = Schema.Struct({
  ok: Schema.Literal(true),
  requestId: Schema.String,
  root: opaqueRootSchema,
});
const failureSchema = Schema.Struct({
  error: Schema.String,
  ok: Schema.Literal(false),
  requestId: Schema.String,
});
const replySchema = Schema.Struct({
  requestId: Schema.String,
  response: Schema.Union([successSchema, failureSchema]),
  type: Schema.Literal(PARSER_HOST_REPLY),
});
type IsExact<L, R> = [L] extends [R] ? ([R] extends [L] ? true : false) : false;
type MatchesFields<L, R> = IsExact<keyof L, keyof R> extends true ? IsExact<L, R> : false;
const _successMatches = true satisfies MatchesFields<
  typeof successSchema.Type,
  Extract<IpcParseResponse, { ok: true }>
>;
const _failureMatches = true satisfies MatchesFields<
  typeof failureSchema.Type,
  Extract<IpcParseResponse, { ok: false }>
>;
const _replyMatches = true satisfies MatchesFields<typeof replySchema.Type, ReplyEnvelope>;
void _successMatches;
void _failureMatches;
void _replyMatches;
const isReplyType = Schema.is(replySchema.fields.type);
const isRequestId = Schema.is(replySchema.fields.requestId);
const isSuccess = Schema.is(successSchema.fields.ok);
const isFailure = Schema.is(failureSchema.fields.ok);
const isRoot = Schema.is(successSchema.fields.root);
const isError = Schema.is(failureSchema.fields.error);

class OxcIpcRequestFailure extends Data.TaggedError('OxcIpcRequestFailure')<{
  readonly error: unknown;
}> {}

interface PendingRequest {
  readonly release: () => void;
  readonly resolve: (response: IpcParseResponse) => void;
}
const pending = new Map<string, PendingRequest>();
let listenerInstalled = false;
function ensureReplyListener(workerSelf: WorkerSelfLike): void {
  if (listenerInstalled) {
    return;
  }
  workerSelf.addEventListener('message', (event) => {
    if (!isReplyEnvelope(event.data)) {
      return;
    }
    pending.get(event.data.requestId)?.resolve(event.data.response);
  });
  listenerInstalled = true;
}

/** Field predicates preserve legacy array containers and opaque AST identity. */
function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (!Predicate.isObjectOrArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  if (
    !(
      isReplyType(envelope['type']) &&
      isRequestId(envelope['requestId']) &&
      Predicate.isObjectOrArray(envelope['response'])
    )
  ) {
    return false;
  }
  const response = envelope['response'] as Record<string, unknown>;
  if (!isRequestId(response['requestId']) || envelope['requestId'] !== response['requestId']) {
    return false;
  }
  if (isSuccess(response['ok'])) {
    return isRoot(response['root']);
  }
  return isFailure(response['ok']) && isError(response['error']);
}

function requestParse(
  workerSelf: WorkerSelfLike,
  requestId: string,
  content: string,
  options: ParseOptions
): Effect.Effect<AstNode, OxcIpcRequestFailure> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      let complete: ((outcome: Effect.Effect<AstNode, OxcIpcRequestFailure>) => void) | undefined;
      let outcome: Effect.Effect<AstNode, OxcIpcRequestFailure> | undefined;
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        clearTimeout(timer);
        if (pending.get(requestId) === entry) {
          pending.delete(requestId);
        }
      };
      const settle = (result: Effect.Effect<AstNode, OxcIpcRequestFailure>): void => {
        if (outcome) {
          return;
        }
        outcome = result;
        release();
        complete?.(result);
      };
      const timer = setTimeout(
        () =>
          settle(
            Effect.fail(
              new OxcIpcRequestFailure({
                error: new Error(`oxc-ipc-adapter: timeout after ${REQUEST_TIMEOUT_MS}ms`),
              })
            )
          ),
        REQUEST_TIMEOUT_MS
      );
      const entry: PendingRequest = {
        release,
        resolve: (response) =>
          settle(
            response.ok
              ? Effect.succeed(response.root)
              : Effect.fail(
                  new OxcIpcRequestFailure({
                    error: new Error(`oxc-ipc-adapter: parser host failure: ${response.error}`),
                  })
                )
          ),
      };
      pending.set(requestId, entry);
      return {
        awaitReply: Effect.callback<AstNode, OxcIpcRequestFailure>((resume) => {
          complete = resume;
          if (outcome) {
            resume(outcome);
            return;
          }
          try {
            workerSelf.postMessage({
              payload: { content, options, requestId },
              requestId,
              type: PARSER_HOST_INVOKE,
            });
          } catch (error) {
            settle(Effect.fail(new OxcIpcRequestFailure({ error })));
          }
        }),
        release,
      };
    }),
    (request) => Effect.sync(request.release)
  ).pipe(
    Effect.flatMap((request) => request.awaitReply),
    Effect.scoped
  );
}

function getWorkerSelf(): WorkerSelfLike | null {
  // In a Web Worker `self` is the DedicatedWorkerGlobalScope and provides
  // both `postMessage` (to the parent) and `addEventListener`. In other
  // realms (browser main thread, Node) `self` won't have the right shape,
  // and we deliberately return null — the adapter is meant only for the
  // worker context.
  const candidate = (globalThis as { self?: unknown }).self;
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as WorkerSelfLike).postMessage === 'function' &&
    typeof (candidate as WorkerSelfLike).addEventListener === 'function' &&
    // Heuristic: a Worker's `self !== window`. If `window` is on globalThis
    // and equals self, we're on the renderer main thread, not in a worker.
    (globalThis as { window?: unknown }).window !== candidate
  ) {
    return candidate as WorkerSelfLike;
  }
  return null;
}

function generateRequestId(): string {
  // crypto.randomUUID is available in Web Workers and Node 18+.
  // No silent Date.now fallback — missing crypto is a hard failure.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!(c && typeof c.randomUUID === 'function')) {
    throw new Error('oxc-ipc-adapter: crypto.randomUUID is required to generate request ids');
  }
  return `oxc-ipc-${c.randomUUID()}`;
}

export const oxcIpcAdapter: ParserAdapter = {
  id: 'oxc-native',
  parse(content: string, options: ParseOptions): Promise<AstNode> {
    const workerSelf = getWorkerSelf();
    if (!workerSelf) {
      return Promise.reject(
        new Error(
          'oxc-ipc-adapter: parent worker scope not detected. This adapter must run inside a Web Worker that has a contextBridge-aware renderer parent.'
        )
      );
    }
    ensureReplyListener(workerSelf);

    const requestId = generateRequestId();
    return runAtPromiseBoundary(requestParse(workerSelf, requestId, content, options)).catch(
      (error: unknown) => {
        if (error instanceof OxcIpcRequestFailure) {
          throw error.error;
        }
        throw error;
      }
    );
  },
};

/**
 * @internal — exported for test harnesses to reset module state between
 * mocked-context test runs. Not for production callers.
 */
export function __resetIpcAdapterForTesting(): void {
  for (const { release } of pending.values()) {
    release();
  }
  pending.clear();
  listenerInstalled = false;
}
