import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { describe, expect, it, vi } from 'vitest';
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
import {
  createAllowlistedSenderFrame,
  invokeDesktopIpc,
  invokeDesktopIpcFrom,
} from '../helpers/desktop-ipc-sender-test-helpers';

const contract = {
  changed: pushEvent<{ readonly id: number }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], readonly string[]>({
    channel: 'fixture:list',
    parseArgs: parseNoArgs,
  }),
  writeText: channel<[text: string], void>({
    channel: 'fixture:write-text',
    parseArgs: ([text]) => {
      if (typeof text !== 'string') {
        throw new Error('fixture writeText requires a string payload');
      }
      return [text];
    },
  }),
} satisfies Contract;

function createMockIpcMain() {
  return { handle: vi.fn() };
}

function createRegistry(ipcMain: ReturnType<typeof createMockIpcMain>) {
  return createDesktopIpcRegistry({ ipcMain: ipcMain as never });
}

const UNTRACKED_SENDER_ID = 7_700_001;

describe('registerDomain', () => {
  it('serves every invoke method of the contract and never a push event', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createRegistry(ipcMain);

    registerDomain(registry, 'clipboard', contract, {
      list: () => ['a'],
      writeText: () => ipcOk(undefined),
    });

    expect(registry.getSnapshot()).toEqual([
      { channel: 'fixture:list', domain: 'clipboard' },
      { channel: 'fixture:write-text', domain: 'clipboard' },
    ]);
    await expect(invokeDesktopIpc(ipcMain, 'fixture:list')).resolves.toEqual(['a']);
    await expect(invokeDesktopIpc(ipcMain, 'fixture:changed', { id: 1 })).rejects.toThrow(
      'No desktop IPC handler for fixture:changed.'
    );
  });

  it('runs parseArgs after authorization and before the handler, and settles malformed input as a boundary fault', async () => {
    const ipcMain = createMockIpcMain();
    const writeText = vi.fn(() => ipcOk(undefined));
    registerDomain(createRegistry(ipcMain), 'clipboard', contract, { list: () => [], writeText });

    await expect(invokeDesktopIpc(ipcMain, 'fixture:write-text', 'hello')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(writeText).toHaveBeenCalledWith('hello');

    await expect(invokeDesktopIpc(ipcMain, 'fixture:write-text', 42)).resolves.toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('refuses an untracked sender before parsing anything', async () => {
    const ipcMain = createMockIpcMain();
    const parseArgs = vi.fn(() => [] as []);
    const list = vi.fn(() => 1);
    registerDomain(
      createRegistry(ipcMain),
      'clipboard',
      { list: rawChannel<[], number>({ channel: 'fixture:list', parseArgs }) },
      { list }
    );
    const event = {
      sender: { id: UNTRACKED_SENDER_ID },
      senderFrame: createAllowlistedSenderFrame(),
    };

    await expect(invokeDesktopIpcFrom(ipcMain, event, 'fixture:list')).rejects.toThrow(
      'Desktop IPC fixture:list requires an app window sender.'
    );
    expect(parseArgs).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('fails registration when a contract key has no handler or a handler has no contract key', () => {
    const ipcMain = createMockIpcMain();
    const missing = createRegistry(ipcMain);
    const extra = createRegistry(ipcMain);
    expect(() =>
      registerDomain(missing, 'clipboard', contract, {
        list: () => [],
      } as never)
    ).toThrow('Desktop IPC domain clipboard has no handler for contract key "writeText".');
    expect(() =>
      registerDomain(extra, 'clipboard', contract, {
        extra: () => 1,
        list: () => [],
        writeText: () => ipcOk(undefined),
      } as never)
    ).toThrow('Desktop IPC domain clipboard has a handler "extra" with no contract key.');
    expect(missing.getSnapshot()).toEqual([]);
    expect(extra.getSnapshot()).toEqual([]);
  });
});

describe('settleIpcResult', () => {
  it('wraps a resolved value in ok:true', async () => {
    await expect(
      settleIpcResult({ category: 'contextFiles', code: 'scan_failed' }, () =>
        Promise.resolve(['x'])
      )
    ).resolves.toEqual({ ok: true, value: ['x'] });
  });

  it('turns a throw into the failure taxonomy instead of rejecting across IPC', async () => {
    await expect(
      settleIpcResult({ category: 'contextFiles', code: 'scan_failed' }, () =>
        Promise.reject(new Error('database unavailable'))
      )
    ).resolves.toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
  });
});
