import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from '../../platform/desktop-ipc-registry';
import { type ContractArgs, NoArgs } from '../../platform/ipc-args';
import { type Contract, channel, ipcOk, pushEvent, rawChannel } from '../../platform/ipc-contract';
import {
  createAllowlistedSenderFrame,
  invokeDesktopIpc,
  invokeDesktopIpcFrom,
} from '../helpers/desktop-ipc-sender-test-helpers';

const contract = {
  changed: pushEvent<{ readonly id: number }>({ channel: 'fixture:changed' }),
  list: rawChannel<[], readonly string[]>({ channel: 'fixture:list' }),
  writeText: channel<[text: string], void>({ channel: 'fixture:write-text' }),
} satisfies Contract;

const args = {
  list: NoArgs,
  writeText: Schema.Tuple([Schema.String]),
} satisfies ContractArgs<typeof contract>;

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

    registerDomain(registry, 'clipboard', contract, args, {
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

  it('decodes arguments before the handler and rejects malformed input without running it', async () => {
    const ipcMain = createMockIpcMain();
    const writeText = vi.fn(() => ipcOk(undefined));
    registerDomain(createRegistry(ipcMain), 'clipboard', contract, args, {
      list: () => [],
      writeText,
    });

    await expect(invokeDesktopIpc(ipcMain, 'fixture:write-text', 'hello')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(writeText).toHaveBeenCalledWith('hello');

    await expect(invokeDesktopIpc(ipcMain, 'fixture:write-text', 42)).rejects.toThrow(
      'Desktop IPC fixture:write-text received invalid arguments'
    );
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('refuses an untracked sender before running the handler', async () => {
    const ipcMain = createMockIpcMain();
    const list = vi.fn(() => 1);
    registerDomain(
      createRegistry(ipcMain),
      'clipboard',
      { list: rawChannel<[], number>({ channel: 'fixture:list' }) },
      { list: NoArgs },
      { list }
    );
    const event = {
      sender: { id: UNTRACKED_SENDER_ID },
      senderFrame: createAllowlistedSenderFrame(),
    };

    await expect(invokeDesktopIpcFrom(ipcMain, event, 'fixture:list')).rejects.toThrow(
      'Desktop IPC fixture:list requires an app window sender.'
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('fails registration when a contract key has no handler or a handler has no contract key', () => {
    const ipcMain = createMockIpcMain();
    const missing = createRegistry(ipcMain);
    const extra = createRegistry(ipcMain);
    expect(() =>
      registerDomain(missing, 'clipboard', contract, args, {
        list: () => [],
      } as never)
    ).toThrow('Desktop IPC domain clipboard has no handler for contract key "writeText".');
    expect(() =>
      registerDomain(extra, 'clipboard', contract, args, {
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
      settleIpcResult({ category: 'clipboard', code: 'write_failed' }, () => Promise.resolve(['x']))
    ).resolves.toEqual({ ok: true, value: ['x'] });
  });

  it('turns a throw into the failure taxonomy instead of rejecting across IPC', async () => {
    await expect(
      settleIpcResult({ category: 'clipboard', code: 'write_failed' }, () =>
        Promise.reject(new Error('database unavailable'))
      )
    ).resolves.toEqual({
      error: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
      ok: false,
    });
  });
});
