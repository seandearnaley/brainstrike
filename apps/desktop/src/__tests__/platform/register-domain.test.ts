import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../../platform/desktop-ipc-registry';
import {
  type Contract,
  channel,
  ipcOk,
  parseNoArgs,
  pushEvent,
  rawChannel,
} from '../../platform/ipc-contract';
import { clearWindowRoleByWebContentsId } from '../../window-role';
import {
  createTrustedInvokeEvent,
  trackTestWindowRole,
} from '../helpers/desktop-ipc-sender-test-helpers';

const contract = {
  changed: pushEvent<{ readonly id: number }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], readonly string[]>({
    channel: 'fixture:list',
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  writeText: channel<[text: string], void>({
    channel: 'fixture:write-text',
    parseArgs: ([text]) => {
      if (typeof text !== 'string') {
        throw new Error('fixture writeText requires a string payload');
      }
      return [text];
    },
    roles: ['embedding-host', 'visible-ui'],
  }),
} satisfies Contract;

function createMockIpcMain() {
  return {
    handle:
      vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  };
}

function createRegistry(ipcMain: ReturnType<typeof createMockIpcMain>) {
  return createDesktopIpcRegistry({
    ipcMain: ipcMain as unknown as Parameters<typeof createDesktopIpcRegistry>[0]['ipcMain'],
  });
}

function registeredHandler(ipcMain: ReturnType<typeof createMockIpcMain>, channelName: string) {
  const call = ipcMain.handle.mock.calls.find(([registered]) => registered === channelName);
  if (!call) {
    throw new Error(`Channel not registered: ${channelName}`);
  }
  return call[1];
}

const HIDDEN_SENDER_ID = 7_700_001;

describe('registerDomain', () => {
  afterEach(() => {
    clearWindowRoleByWebContentsId(HIDDEN_SENDER_ID);
  });

  it('registers every invoke channel through the authorized verb with the contract roles', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const authorized = vi.spyOn(registry, 'registerAuthorizedInvoke');

    registerDomain(registry, 'clipboard', contract, {
      list: () => ['a'],
      writeText: () => ipcOk(undefined),
    });

    expect(authorized.mock.calls.map(([domain, name, policy]) => [domain, name, policy])).toEqual([
      ['clipboard', 'fixture:list', { roles: ['visible-ui'] }],
      ['clipboard', 'fixture:write-text', { roles: ['embedding-host', 'visible-ui'] }],
    ]);
    expect(registry.getSnapshot()).toEqual([
      { channel: 'fixture:list', domain: 'clipboard', kind: 'invoke' },
      { channel: 'fixture:write-text', domain: 'clipboard', kind: 'invoke' },
    ]);
  });

  it('never registers a push event (main→renderer pushes are webContents.send, not handlers)', () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    registerDomain(registry, 'clipboard', contract, {
      list: () => [],
      writeText: () => ipcOk(undefined),
    });

    expect(ipcMain.handle.mock.calls.map(([name]) => name)).not.toContain('fixture:changed');
    expect(ipcMain.on).not.toHaveBeenCalled();
  });

  it('runs parseArgs after authorization and before the handler, and settles malformed input as a boundary fault', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const writeText = vi.fn(() => ipcOk(undefined));
    registerDomain(registry, 'clipboard', contract, { list: () => [], writeText });
    const handler = registeredHandler(ipcMain, 'fixture:write-text');
    const event = createTrustedInvokeEvent('visible-ui');

    await expect(handler(event, 'hello')).resolves.toEqual({ ok: true, value: undefined });
    expect(writeText).toHaveBeenCalledWith('hello');

    await expect(handler(event, 42)).resolves.toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('rejects a sender outside the contract roles before parsing anything', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);
    const parseArgs = vi.fn(() => [] as []);
    const onlyVisible = {
      list: rawChannel<[], number>({ channel: 'fixture:list', parseArgs, roles: ['visible-ui'] }),
    } satisfies Contract;
    const list = vi.fn(() => 1);
    registerDomain(registry, 'clipboard', onlyVisible, { list });
    trackTestWindowRole(HIDDEN_SENDER_ID, 'embedding-host');
    const event = {
      sender: { id: HIDDEN_SENDER_ID },
      senderFrame: createTrustedInvokeEvent('visible-ui').senderFrame,
    } as unknown as IpcMainInvokeEvent;

    await expect(registeredHandler(ipcMain, 'fixture:list')(event)).rejects.toThrow(
      'Desktop IPC fixture:list requires sender role visible-ui.'
    );
    expect(parseArgs).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('fails registration when a contract key has no handler or a handler has no contract key', () => {
    const ipcMain = createMockIpcMain();
    expect(() =>
      registerDomain(createRegistry(ipcMain), 'clipboard', contract, {
        list: () => [],
      } as never)
    ).toThrow('Desktop IPC domain clipboard has no handler for contract key "writeText".');
    expect(() =>
      registerDomain(createRegistry(ipcMain), 'clipboard', contract, {
        extra: () => 1,
        list: () => [],
        writeText: () => ipcOk(undefined),
      } as never)
    ).toThrow('Desktop IPC domain clipboard has a handler "extra" with no contract key.');
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });
});

describe('settleIpcResult', () => {
  it('wraps a resolved value in ok:true', async () => {
    await expect(
      settleIpcResult({ category: 'skills', code: 'scan_failed' }, () => Promise.resolve(['x']))
    ).resolves.toEqual({ ok: true, value: ['x'] });
  });

  it('turns a throw into the failure taxonomy instead of rejecting across IPC', async () => {
    await expect(
      settleIpcResult({ category: 'skills', code: 'scan_failed' }, () =>
        Promise.reject(new Error('database unavailable'))
      )
    ).resolves.toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
  });
});
