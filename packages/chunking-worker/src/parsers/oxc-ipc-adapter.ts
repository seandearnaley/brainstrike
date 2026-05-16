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
 * Note on channel-name duplication: PARSER_HOST_PARSE_CHANNEL is also
 * defined in `apps/desktop/src/parser-host-shared.ts`. Duplicated here
 * because chunking-worker is bundled as platform: 'browser' and can't
 * cross-import from apps/desktop without breaking apps/web. The two
 * sides agree on the string by convention; if they ever diverge the IPC
 * fails visibly with a "no handler registered" error.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import type { AstNode, ParseOptions, ParserAdapter } from './types';

const PARSER_HOST_PARSE_CHANNEL = 'parser-host:parse';

/**
 * Minimal shape of the request envelope sent over IPC. Mirrors
 * `ParserHostParseRequest` in apps/desktop without importing it.
 */
interface IpcParseRequest {
  readonly content: string;
  readonly options: ParseOptions;
  readonly requestId: string;
}

/** Mirrors `ParserHostParseResponse` from apps/desktop. */
type IpcParseResponse =
  | { readonly ok: true; readonly requestId: string; readonly root: AstNode }
  | { readonly ok: false; readonly requestId: string; readonly error: string };

/**
 * Subset of `electron.IpcRenderer` we depend on. Avoids requiring the full
 * Electron type definitions in the chunking-worker package.
 */
interface IpcRendererLike {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

let rendererPromise: Promise<IpcRendererLike | null> | null = null;

async function loadIpcRenderer(): Promise<IpcRendererLike | null> {
  if (!rendererPromise) {
    // Dynamic import via a string variable so TypeScript doesn't resolve the
    // 'electron' module spec at compile time. chunking-worker is bundled as
    // platform: 'browser' and intentionally has no electron type/runtime
    // dependency — at runtime, this import resolves only when the worker
    // happens to be loaded inside an Electron renderer (where 'electron' is
    // available). In apps/web this throws and we return null, which is fine
    // because the select-adapter facade never selects this adapter there.
    const electronModuleSpec = 'electron';
    rendererPromise = import(/* @vite-ignore */ electronModuleSpec)
      .then((mod: unknown) => {
        if (mod === null || typeof mod !== 'object' || !('ipcRenderer' in mod)) {
          return null;
        }
        const renderer = (mod as { ipcRenderer?: unknown }).ipcRenderer;
        return renderer && typeof (renderer as IpcRendererLike).invoke === 'function'
          ? (renderer as IpcRendererLike)
          : null;
      })
      .catch(() => null);
  }
  return rendererPromise;
}

let counter = 0;
function generateRequestId(): string {
  counter += 1;
  return `oxc-ipc-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function isIpcParseResponse(value: unknown): value is IpcParseResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'requestId' in value &&
    typeof (value as { requestId?: unknown }).requestId === 'string' &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

export const oxcIpcAdapter: ParserAdapter = {
  id: 'oxc-native',
  async parse(content: string, options: ParseOptions): Promise<AstNode> {
    const renderer = await loadIpcRenderer();
    if (!renderer) {
      throw new Error(
        'oxc-ipc-adapter: ipcRenderer unavailable. Adapter must only be loaded in an Electron renderer.'
      );
    }
    const request: IpcParseRequest = {
      content,
      options,
      requestId: generateRequestId(),
    };
    const raw = await renderer.invoke(PARSER_HOST_PARSE_CHANNEL, request);
    if (!isIpcParseResponse(raw)) {
      throw new Error('oxc-ipc-adapter: parser host returned malformed response');
    }
    if (!raw.ok) {
      throw new Error(`oxc-ipc-adapter: parser host failure: ${raw.error}`);
    }
    return raw.root;
  },
};

/**
 * @internal — exported for test harnesses to reset the lazy-loaded renderer
 * cache between mocked-import test runs. Not for production callers.
 */
export function __resetIpcRendererCacheForTesting(): void {
  rendererPromise = null;
}
