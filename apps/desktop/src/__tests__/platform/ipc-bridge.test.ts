import { describe, expect, it, vi } from 'vitest';
import { createBridgeExposer, createIpcBridge, unwrapIpcResult } from '../../platform/ipc-bridge';
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

describe('createIpcBridge', () => {
  it('routes an ipc-result channel to its manifest channel and unwraps the reply', async () => {
    const ipcRenderer = createIpcRenderer();
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: 7 });
    const bridge = createIpcBridge(ipcRenderer, contract);

    await expect(bridge.writeText('hello')).resolves.toBe(7);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('fixture:write-text', 'hello');
  });

  it('turns an ok:false envelope into a clean Error carrying the taxonomy', async () => {
    const ipcRenderer = createIpcRenderer();
    ipcRenderer.invoke.mockResolvedValueOnce({
      error: { category: 'clipboard', code: 'write_failed', message: 'clipboard locked' },
      ok: false,
    });
    const bridge = createIpcBridge(ipcRenderer, contract);

    await expect(bridge.writeText('hello')).rejects.toMatchObject({
      category: 'clipboard',
      code: 'write_failed',
      message: 'clipboard locked (clipboard · write_failed)',
    });
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
      expect(() => unwrapIpcResult('fixture:x', reply)).toThrow(
        'Desktop IPC fixture:x returned a malformed result envelope.'
      );
    }
  );

  it('rejects an ok:false envelope whose error lacks the taxonomy', () => {
    expect(() => unwrapIpcResult('fixture:x', { error: 'boom', ok: false })).toThrow(
      'Desktop IPC fixture:x returned a malformed failure envelope.'
    );
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
