/**
 * PURE preload-side derivation of a contract (BST-1648): one generic bridge
 * builder replaces a hand-written `exposeInMainWorld` object per domain.
 * Electron surfaces are injected (`IpcRendererLike`, `ContextBridgeLike`) so
 * this module has no `electron` import and is unit-testable without it.
 * contextBridge proxies functions and freezes everything else, so an object
 * of generated functions is exactly what `exposeInMainWorld` is for.
 */
import type { Bridge, Contract, IpcFailure } from './ipc-contract';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: IpcListener) => unknown;
  removeListener: (channel: string, listener: IpcListener) => unknown;
}

export interface ContextBridgeLike {
  exposeInMainWorld: (name: string, api: unknown) => void;
}

function isIpcFailure(value: unknown): value is IpcFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IpcFailure).category === 'string' &&
    typeof (value as IpcFailure).code === 'string' &&
    typeof (value as IpcFailure).message === 'string'
  );
}

/**
 * The ONE preload unwrap for `IpcResult` replies: `ok: true` yields the
 * value; `ok: false` becomes a clean Error whose message is
 * `message (category · code)` with `category`/`code` properties (the
 * `mcp:content:*` ruling, promoted); any other shape is rejected by name.
 */
export function unwrapIpcResult<T>(channel: string, reply: unknown): T {
  if (
    typeof reply !== 'object' ||
    reply === null ||
    typeof (reply as { ok?: unknown }).ok !== 'boolean'
  ) {
    throw new Error(`Desktop IPC ${channel} returned a malformed result envelope.`);
  }
  const envelope = reply as { ok: boolean; value?: unknown; error?: unknown };
  if (envelope.ok) {
    return envelope.value as T;
  }
  if (!isIpcFailure(envelope.error)) {
    throw new Error(`Desktop IPC ${channel} returned a malformed failure envelope.`);
  }
  const { category, code, message } = envelope.error;
  throw Object.assign(new Error(`${message} (${category} · ${code})`), { category, code });
}

export function createIpcBridge<C extends Contract>(
  ipcRenderer: IpcRendererLike,
  contract: C
): Bridge<C> {
  const bridge: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(contract)) {
    if (spec.kind === 'push') {
      bridge[key] = (callback: (payload: unknown) => void): (() => void) => {
        const listener: IpcListener = (_event, payload) => callback(payload);
        ipcRenderer.on(spec.channel, listener);
        return () => {
          ipcRenderer.removeListener(spec.channel, listener);
        };
      };
      continue;
    }
    bridge[key] =
      spec.envelope === 'ipc-result'
        ? async (...args: unknown[]): Promise<unknown> =>
            unwrapIpcResult(spec.channel, await ipcRenderer.invoke(spec.channel, ...args))
        : (...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(spec.channel, ...args);
  }
  return bridge as Bridge<C>;
}

export function createBridgeExposer(deps: {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
}): <C extends Contract>(name: string, contract: C) => void {
  return (name, contract) => {
    deps.contextBridge.exposeInMainWorld(name, createIpcBridge(deps.ipcRenderer, contract));
  };
}
