/**
 * PURE preload-side derivation of a contract (BST-1648): one generic bridge
 * builder replaces a hand-written `exposeInMainWorld` object per domain.
 * Electron surfaces are injected (`IpcRendererLike`, `ContextBridgeLike`) so
 * this module has no `electron` import and is unit-testable without it.
 * contextBridge proxies functions and freezes everything else, so an object
 * of generated functions is exactly what `exposeInMainWorld` is for.
 */
import {
  DESKTOP_IPC_INVOKE_CHANNEL,
  DESKTOP_IPC_PUSH_CHANNEL,
  type DesktopIpcPush,
} from './desktop-ipc-channels';
import type { Contract, TransportBridge } from './ipc-contract';

/** A push as the preload receives it: Electron's event, carrying any transferred ports. */
export interface IpcPushEvent {
  readonly ports: readonly MessagePort[];
}
type IpcListener = (event: IpcPushEvent, payload: unknown) => void;

/**
 * The preload's view of the desktop IPC connection, addressed by method name.
 * Result and payload types are what the preload declares Main sends, as with
 * Electron's own `ipcRenderer`.
 */
export interface IpcRendererLike {
  invoke: <Result = unknown>(method: string, ...args: unknown[]) => Promise<Result>;
  on: <Payload>(
    method: string,
    listener: (event: IpcPushEvent, payload: Payload) => void
  ) => unknown;
  removeListener: <Payload>(
    method: string,
    listener: (event: IpcPushEvent, payload: Payload) => void
  ) => unknown;
}

/** Electron's `ipcRenderer`, as the transport uses it: the two channels and nothing else. */
export interface ElectronIpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: IpcPushEvent, push: DesktopIpcPush) => void) => unknown;
}

/**
 * The preload's one connection to Main. A call is `invoke` on
 * DESKTOP_IPC_INVOKE_CHANNEL with the method name first; every push arrives on
 * DESKTOP_IPC_PUSH_CHANNEL as `{ method, payload }` and reaches the listeners of
 * that method, with the event (and any transferred ports) as Electron gave it.
 */
export function createDesktopIpcTransport(ipcRenderer: ElectronIpcRendererLike): IpcRendererLike {
  const listeners = new Map<string, Set<IpcListener>>();
  ipcRenderer.on(DESKTOP_IPC_PUSH_CHANNEL, (event, push) => {
    for (const listener of [...(listeners.get(push.method) ?? [])]) {
      listener(event, push.payload);
    }
  });
  return {
    invoke: <Result>(method: string, ...args: unknown[]) =>
      ipcRenderer.invoke(DESKTOP_IPC_INVOKE_CHANNEL, method, ...args) as Promise<Result>,
    on: (method, listener) => {
      const subscribed = listeners.get(method) ?? new Set<IpcListener>();
      subscribed.add(listener as IpcListener);
      listeners.set(method, subscribed);
    },
    removeListener: (method, listener) => {
      listeners.get(method)?.delete(listener as IpcListener);
    },
  };
}

export interface ContextBridgeLike {
  exposeInMainWorld: (name: string, api: unknown) => void;
}

/**
 * A push method's subscribe: ONE transport listener, held while anyone
 * subscribes, fans out to every subscription. Each subscription is its own
 * entry (the same callback twice is two), and a dispatch walks a snapshot,
 * so unsubscribing mid-dispatch is safe.
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
