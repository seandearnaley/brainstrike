/**
 * PURE preload-side derivation of a contract (BST-1648): one generic bridge
 * builder replaces a hand-written `exposeInMainWorld` object per domain.
 * Electron surfaces are injected (`IpcRendererLike`, `ContextBridgeLike`) so
 * this module has no `electron` import and is unit-testable without it.
 * contextBridge proxies functions and freezes everything else, so an object
 * of generated functions is exactly what `exposeInMainWorld` is for.
 */
import type { Contract, TransportBridge } from './ipc-contract';

type IpcListener = (event: unknown, payload: unknown) => void;

export interface IpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: IpcListener) => unknown;
  removeListener: (channel: string, listener: IpcListener) => unknown;
}

export interface ContextBridgeLike {
  exposeInMainWorld: (name: string, api: unknown) => void;
}

export function createIpcBridge<C extends Contract>(
  ipcRenderer: IpcRendererLike,
  contract: C
): TransportBridge<C> {
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
    bridge[key] = (...args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke(spec.channel, ...args);
  }
  return bridge as TransportBridge<C>;
}

export function createBridgeExposer(deps: {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
}): <C extends Contract>(name: string, contract: C) => void {
  return (name, contract) => {
    deps.contextBridge.exposeInMainWorld(name, createIpcBridge(deps.ipcRenderer, contract));
  };
}
