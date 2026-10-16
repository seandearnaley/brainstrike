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

/**
 * A push channel's subscribe: ONE ipcRenderer listener, held while anyone
 * subscribes, fans out to every subscription. A listener per subscription
 * crossed Node's 10-listener warning once a dozen views subscribed. Each
 * subscription is its own entry (the same callback twice is two), and a
 * dispatch walks a snapshot, so unsubscribing mid-dispatch is safe.
 */
function pushSubscribe(
  ipcRenderer: IpcRendererLike,
  channel: string
): (callback: (payload: unknown) => void) => () => void {
  const subscriptions = new Set<{ readonly callback: (payload: unknown) => void }>();
  const listener: IpcListener = (_event, payload) => {
    for (const subscription of [...subscriptions]) {
      subscription.callback(payload);
    }
  };
  return (callback) => {
    const subscription = { callback };
    if (subscriptions.size === 0) {
      ipcRenderer.on(channel, listener);
    }
    subscriptions.add(subscription);
    return () => {
      if (subscriptions.delete(subscription) && subscriptions.size === 0) {
        ipcRenderer.removeListener(channel, listener);
      }
    };
  };
}

export function createIpcBridge<C extends Contract>(
  ipcRenderer: IpcRendererLike,
  contract: C
): TransportBridge<C> {
  const bridge: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(contract)) {
    if (spec.kind === 'push') {
      bridge[key] = pushSubscribe(ipcRenderer, spec.channel);
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
