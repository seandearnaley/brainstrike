import { EventEmitter } from 'node:events';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_IPC_INVOKE_CHANNEL,
  DESKTOP_IPC_PUSH_CHANNEL,
  type DesktopIpcPush,
} from '../../platform/desktop-ipc-channels';
import {
  createBridgeExposer,
  createDesktopIpcTransport,
  createIpcBridge,
  type IpcPushEvent,
} from '../../platform/ipc-bridge';
import {
  type Contract,
  channel,
  parseNoArgs,
  pushEvent,
  rawChannel,
} from '../../platform/ipc-contract';

const contract = {
  changed: pushEvent<{ readonly id: number }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], { readonly ok: boolean }>({
    channel: 'fixture:list',
    parseArgs: parseNoArgs,
  }),
  writeText: channel<[text: string], number>({
    channel: 'fixture:write-text',
    parseArgs: ([text]) => [String(text)],
  }),
} satisfies Contract;

/** Electron's `ipcRenderer` as the preload sees it: Main's pushes arrive through `push`. */
function createElectronIpcRenderer() {
  const emitter = new EventEmitter();
  return {
    emitter,
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: (channel: string, listener: (event: IpcPushEvent, push: DesktopIpcPush) => void) =>
      emitter.on(channel, listener),
    push: (push: DesktopIpcPush, ports: readonly MessagePort[] = []) =>
      emitter.emit(DESKTOP_IPC_PUSH_CHANNEL, { ports }, push),
  };
}

describe('createDesktopIpcTransport', () => {
  it('sends every call on the one invoke channel with the method name first', async () => {
    const electron = createElectronIpcRenderer();
    electron.invoke.mockResolvedValueOnce('reply');
    const transport = createDesktopIpcTransport(electron);

    await expect(transport.invoke('fixture:write-text', 'hello', 2)).resolves.toBe('reply');
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      'fixture:write-text',
      'hello',
      2
    );
  });

  it('listens on the one push channel and delivers each push only to its method, with its ports', () => {
    const electron = createElectronIpcRenderer();
    const transport = createDesktopIpcTransport(electron);
    const changed = vi.fn();
    const other = vi.fn();
    transport.on('fixture:changed', changed);
    transport.on('fixture:other', other);
    const port = {} as MessagePort;

    electron.push({ method: 'fixture:changed', payload: { id: 1 } }, [port]);

    expect(electron.emitter.eventNames()).toEqual([DESKTOP_IPC_PUSH_CHANNEL]);
    expect(electron.emitter.listenerCount(DESKTOP_IPC_PUSH_CHANNEL)).toBe(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ports: [port] }, { id: 1 });
    expect(other).not.toHaveBeenCalled();

    transport.removeListener('fixture:changed', changed);
    electron.push({ method: 'fixture:changed', payload: { id: 2 } });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

// Live smoke 2026-10-16: the renderer warned "MaxListenersExceededWarning: 11
// forge:prUpdated listeners". Every push subscription added its own
// listener, so a dozen mounted PR-cache consumers crossed Node's limit of 10.
// One Electron listener serves every push; each subscription is its own entry.
describe('createIpcBridge push fan-out', () => {
  it('holds one Electron listener however many subscribe, and fans each push out', () => {
    const electron = createElectronIpcRenderer();
    const bridge = createIpcBridge(createDesktopIpcTransport(electron), contract);
    const callbacks = Array.from({ length: 12 }, () => vi.fn());
    const unsubscribes = callbacks.map((callback) => bridge.changed(callback));
    // The same callback twice is two subscriptions.
    const repeated = callbacks[0];
    if (!repeated) {
      throw new Error('No callback');
    }
    const second = bridge.changed(repeated);

    expect(electron.emitter.listenerCount(DESKTOP_IPC_PUSH_CHANNEL)).toBe(1);
    electron.push({ method: 'fixture:changed', payload: { id: 1 } });
    expect(callbacks.map((callback) => callback.mock.calls.length)).toEqual([
      2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);

    second();
    for (const unsubscribe of unsubscribes.slice(1)) {
      unsubscribe();
    }
    electron.push({ method: 'fixture:changed', payload: { id: 2 } });
    expect(repeated).toHaveBeenLastCalledWith({ id: 2 });
    expect(callbacks.slice(1).map((callback) => callback.mock.calls.length)).toEqual(
      Array.from({ length: 11 }, () => 1)
    );

    unsubscribes[0]?.();
    electron.push({ method: 'fixture:changed', payload: { id: 3 } });
    expect(repeated).toHaveBeenCalledTimes(3);
    expect(electron.emitter.listenerCount(DESKTOP_IPC_PUSH_CHANNEL)).toBe(1);
  });
});

describe('createIpcBridge', () => {
  function createBridge() {
    const electron = createElectronIpcRenderer();
    return { bridge: createIpcBridge(createDesktopIpcTransport(electron), contract), electron };
  }

  it('routes an ipc-result method and transports the plain envelope unchanged', async () => {
    const { bridge, electron } = createBridge();
    electron.invoke.mockResolvedValueOnce({ ok: true, value: 7 });

    await expect(bridge.writeText('hello')).resolves.toEqual({ ok: true, value: 7 });
    expect(electron.invoke).toHaveBeenCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      'fixture:write-text',
      'hello'
    );
  });

  it('transports refusal data without throwing inside the contextBridge', async () => {
    const { bridge, electron } = createBridge();
    const failure = {
      category: 'availability',
      code: 'clipboard.unavailable',
      kind: 'refusal',
      message: 'Clipboard is unavailable.',
      remedy: 'Try again.',
    };
    electron.invoke.mockResolvedValueOnce({ error: failure, ok: false });
    await expect(bridge.writeText('hello')).resolves.toEqual({ error: failure, ok: false });
  });

  it('passes a raw method reply through untouched', async () => {
    const { bridge, electron } = createBridge();
    electron.invoke.mockResolvedValueOnce({ error: 'domain envelope', ok: false });

    await expect(bridge.list()).resolves.toEqual({ error: 'domain envelope', ok: false });
    expect(electron.invoke).toHaveBeenCalledWith(DESKTOP_IPC_INVOKE_CHANNEL, 'fixture:list');
  });

  it('derives subscribe-returns-unsubscribe for a push event', () => {
    const { bridge, electron } = createBridge();
    const callback = vi.fn();

    const unsubscribe = bridge.changed(callback);
    electron.push({ method: 'fixture:changed', payload: { id: 3 } });
    expect(callback).toHaveBeenCalledExactlyOnceWith({ id: 3 });

    unsubscribe();
    electron.push({ method: 'fixture:changed', payload: { id: 4 } });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('exposes exactly the contract keys and nothing else', () => {
    expect(Object.keys(createBridge().bridge).sort()).toEqual(Object.keys(contract).sort());
  });
});

describe('unwrapIpcResult', () => {
  it.each([undefined, null, 'ok', { value: 1 }, { ok: 'yes' }])(
    'rejects a malformed result envelope %p by name',
    (reply) => {
      expect(() => readBoundaryResult(reply)).toThrow(INTERNAL_FAULT.message);
    }
  );

  it('rejects an ok:false envelope whose error lacks the taxonomy', () => {
    expect(() => readBoundaryResult({ error: 'boom', ok: false })).toThrow(INTERNAL_FAULT.message);
  });
});

describe('createBridgeExposer', () => {
  it('exposes the derived bridge under the given name', () => {
    const contextBridge = { exposeInMainWorld: vi.fn() };
    const exposeBridge = createBridgeExposer({
      contextBridge,
      ipcRenderer: createDesktopIpcTransport(createElectronIpcRenderer()),
    });

    exposeBridge('fixture', contract);

    const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, object];
    expect(name).toBe('fixture');
    expect(Object.keys(api).sort()).toEqual(['changed', 'list', 'writeText']);
  });
});
