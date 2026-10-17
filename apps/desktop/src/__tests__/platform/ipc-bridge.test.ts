import { EventEmitter } from 'node:events';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { readBoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { describe, expect, it, vi } from 'vitest';
import { createBridgeExposer, createIpcBridge } from '../../platform/ipc-bridge';
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
    roles: ['visible-ui'],
  }),
  writeText: channel<[text: string], number>({
    channel: 'fixture:write-text',
    parseArgs: ([text]) => [String(text)],
    roles: ['visible-ui'],
  }),
} satisfies Contract;

function createIpcRenderer() {
  return {
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

// Live smoke 2026-10-16: the renderer warned "MaxListenersExceededWarning: 11
// forge:prUpdated listeners". Every push subscription added its own
// ipcRenderer listener, so a dozen mounted PR-cache consumers crossed Node's
// limit of 10. One listener per channel fans out to every subscription.
describe('createIpcBridge push fan-out', () => {
  it('holds one ipcRenderer listener per channel however many subscribe', () => {
    const emitter = new EventEmitter();
    const ipcRenderer = {
      invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
        emitter.on(channel, listener),
      removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
        emitter.removeListener(channel, listener),
    };
    const bridge = createIpcBridge(ipcRenderer, contract);
    const callbacks = Array.from({ length: 12 }, () => vi.fn());
    const unsubscribes = callbacks.map((callback) => bridge.changed(callback));
    // The same callback twice is two subscriptions.
    const repeated = callbacks[0];
    if (!repeated) {
      throw new Error('No callback');
    }
    const second = bridge.changed(repeated);

    expect(emitter.listenerCount('fixture:changed')).toBe(1);
    emitter.emit('fixture:changed', {}, { id: 1 });
    expect(callbacks.map((callback) => callback.mock.calls.length)).toEqual([
      2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);

    second();
    for (const unsubscribe of unsubscribes.slice(1)) {
      unsubscribe();
    }
    emitter.emit('fixture:changed', {}, { id: 2 });
    expect(repeated).toHaveBeenLastCalledWith({ id: 2 });
    expect(emitter.listenerCount('fixture:changed')).toBe(1);

    unsubscribes[0]?.();
    expect(emitter.listenerCount('fixture:changed')).toBe(0);
  });
});

describe('createIpcBridge', () => {
  it('routes an ipc-result channel and transports the plain envelope unchanged', async () => {
    const ipcRenderer = createIpcRenderer();
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: 7 });
    const bridge = createIpcBridge(ipcRenderer, contract);

    await expect(bridge.writeText('hello')).resolves.toEqual({ ok: true, value: 7 });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('fixture:write-text', 'hello');
  });

  it('transports refusal data without throwing inside the contextBridge', async () => {
    const ipcRenderer = createIpcRenderer();
    const failure = {
      category: 'availability',
      code: 'clipboard.unavailable',
      kind: 'refusal',
      message: 'Clipboard is unavailable.',
      remedy: 'Try again.',
    };
    ipcRenderer.invoke.mockResolvedValueOnce({ error: failure, ok: false });
    const bridge = createIpcBridge(ipcRenderer, contract);
    await expect(bridge.writeText('hello')).resolves.toEqual({ error: failure, ok: false });
  });

  it('passes a raw channel reply through untouched', async () => {
    const ipcRenderer = createIpcRenderer();
    ipcRenderer.invoke.mockResolvedValueOnce({ error: 'domain envelope', ok: false });
    const bridge = createIpcBridge(ipcRenderer, contract);

    await expect(bridge.list()).resolves.toEqual({ error: 'domain envelope', ok: false });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('fixture:list');
  });

  it('derives subscribe-returns-unsubscribe for a push event', () => {
    const ipcRenderer = createIpcRenderer();
    const bridge = createIpcBridge(ipcRenderer, contract);
    const callback = vi.fn();

    const unsubscribe = bridge.changed(callback);
    const [registeredChannel, listener] = ipcRenderer.on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    expect(registeredChannel).toBe('fixture:changed');
    listener({}, { id: 3 });
    expect(callback).toHaveBeenCalledWith({ id: 3 });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('fixture:changed', listener);
  });

  it('exposes exactly the contract keys and nothing else', () => {
    const bridge = createIpcBridge(createIpcRenderer(), contract);
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(contract).sort());
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
    const exposeBridge = createBridgeExposer({ contextBridge, ipcRenderer: createIpcRenderer() });

    exposeBridge('fixture', contract);

    const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, object];
    expect(name).toBe('fixture');
    expect(Object.keys(api).sort()).toEqual(['changed', 'list', 'writeText']);
  });
});
