/**
 * oxc-IPC parser adapter.
 *
 * Routes parse calls from the chunking worker, through Electron IPC, to the
 * native `oxc-parser` running in the parser-host utility process. Used only
 * in the Electron desktop chunking-host renderer; never loaded in apps/web
 * (the select-adapter facade gates it on environment — see Phase 5).
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

interface PendingRequest {
  readonly resolve: (response: IpcParseResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

let listenerInstalled = false;
function ensureReplyListener(workerSelf: WorkerSelfLike): void {
  if (listenerInstalled) {
    return;
  }
  workerSelf.addEventListener('message', (event) => {
    const data = event.data;
    if (!isReplyEnvelope(data)) {
      return; // not for us — leave other handlers alone
    }
    const entry = pending.get(data.requestId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(data.requestId);
    entry.resolve(data.response);
  });
  listenerInstalled = true;
}

function isReplyEnvelope(value: unknown): value is ReplyEnvelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (
    v['type'] !== PARSER_HOST_REPLY ||
    typeof v['requestId'] !== 'string' ||
    v['response'] === null ||
    typeof v['response'] !== 'object'
  ) {
    return false;
  }
  // P2 #990: validate the inner response payload too. Without this, a
  // success-shaped envelope like `{ ok: true, requestId, root: null }` or
  // a failure envelope without an error string would slip through and
  // either crash the consumer (`root.type`) or surface as an empty error.
  const response = v['response'] as Record<string, unknown>;
  if (typeof response['requestId'] !== 'string' || typeof response['ok'] !== 'boolean') {
    return false;
  }
  if (response['ok']) {
    return response['root'] !== null && typeof response['root'] === 'object';
  }
  return typeof response['error'] === 'string';
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

let counter = 0;
function generateRequestId(): string {
  counter += 1;
  // crypto.randomUUID is available in Web Workers and Node 18+ — guards
  // against worker-respawn collisions that the bare Date.now()+counter
  // form could hit (counter resets on module reload; Date.now is
  // millisecond-resolution so two workers spawned in the same tick can
  // collide on the first few requestIds).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const uuid = c && typeof c.randomUUID === 'function' ? c.randomUUID() : '';
  return uuid ? `oxc-ipc-${uuid}` : `oxc-ipc-${Date.now().toString(36)}-${counter.toString(36)}`;
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
    return new Promise<AstNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`oxc-ipc-adapter: timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      pending.set(requestId, {
        resolve: (response) => {
          if (response.ok) {
            resolve(response.root);
          } else {
            reject(new Error(`oxc-ipc-adapter: parser host failure: ${response.error}`));
          }
        },
        timer,
      });

      const envelope: InvokeEnvelope = {
        payload: { content, options, requestId },
        requestId,
        type: PARSER_HOST_INVOKE,
      };
      workerSelf.postMessage(envelope);
    });
  },
};

/**
 * @internal — exported for test harnesses to reset module state between
 * mocked-context test runs. Not for production callers.
 */
export function __resetIpcAdapterForTesting(): void {
  for (const { timer } of pending.values()) {
    clearTimeout(timer);
  }
  pending.clear();
  listenerInstalled = false;
  counter = 0;
}
