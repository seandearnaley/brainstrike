import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
import { registerStoragePreferencesIpcHandlers } from '../../ipc-domains/storage-preferences-ipc';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import {
  invokeDesktopIpcFrom,
  trackTestAppWindow,
} from '../helpers/desktop-ipc-sender-test-helpers';

const { ipcMain } = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('electron', () => ({ ipcMain }));

const VISIBLE_UI_SENDER_ID = 9402;
const UNTRACKED_SENDER_ID = 9403;
const SPOOFED_VISIBLE_UI_SENDER_ID = 9404;

function senderEvent(senderId: number): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

function invokeFrom(senderId: number, method: string, ...args: unknown[]): Promise<unknown> {
  return invokeDesktopIpcFrom(ipcMain, senderEvent(senderId), method, ...args);
}

function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  return invokeFrom(VISIBLE_UI_SENDER_ID, method, ...args);
}

interface FakeStore {
  clear: () => void;
}

function createStorage(): ElectronStorageAdapter {
  return {
    clear: vi.fn(async () => undefined),
    clearExcept: vi.fn(async () => undefined),
    getAllKeys: vi.fn(async () => ['alpha']),
    getItem: vi.fn(async (key: string) => `value:${key}`),
    removeItem: vi.fn(async () => undefined),
    setItem: vi.fn(async () => undefined),
  } as unknown as ElectronStorageAdapter;
}

function createStore(): FakeStore {
  return { clear: vi.fn() };
}

describe('storage preferences IPC domain', () => {
  let storage: ElectronStorageAdapter;
  let store: FakeStore;
  let unregister: () => void;

  function register(): void {
    unregister = registerStoragePreferencesIpcHandlers({
      getStore: () => store as never,
      storage,
    });
  }

  beforeEach(() => {
    trackTestAppWindow(VISIBLE_UI_SENDER_ID);
    trackTestAppWindow(SPOOFED_VISIBLE_UI_SENDER_ID);
    storage = createStorage();
    store = createStore();
    register();
  });

  afterEach(() => {
    unregister();
    vi.unstubAllEnvs();
    untrackAppWindow(VISIBLE_UI_SENDER_ID);
    untrackAppWindow(SPOOFED_VISIBLE_UI_SENDER_ID);
  });

  it('serves storage through the desktop IPC connection', async () => {
    await expect(invoke('storage:getItem', 'alpha')).resolves.toBe('value:alpha');
    await invoke('storage:setItem', 'alpha', 'beta');
    await invoke('storage:removeItem', 'alpha');
    await invoke('storage:clear');
    await expect(invoke('storage:getAllKeys')).resolves.toEqual(['alpha']);

    expect(storage.getItem).toHaveBeenCalledWith('alpha');
    expect(storage.setItem).toHaveBeenCalledWith('alpha', 'beta');
    expect(storage.removeItem).toHaveBeenCalledWith('alpha');
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.getAllKeys).toHaveBeenCalled();
    expect(storage.clearExcept).toHaveBeenCalledWith([
      'lastFolderPath',
      'recentRootsList',
      'recentRootsList.corrupt',
      'rootsList',
      'rootsList.corrupt',
    ]);
  });

  it.each([
    'rootsList',
    'rootsList.corrupt',
    'recentRootsList',
    'recentRootsList.corrupt',
    'lastFolderPath',
  ])('refuses renderer writes and removals for main-owned key %s', async (key) => {
    await expect(invoke('storage:setItem', key, 'value')).rejects.toThrow(
      `Storage key "${key}" is main-owned`
    );
    await expect(invoke('storage:removeItem', key)).rejects.toThrow(
      `Storage key "${key}" is main-owned`
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('rejects non-string renderer values at the IPC boundary', async () => {
    await expect(
      invoke('storage:setItem', 'assistant-preferences.v1', { invalid: true })
    ).rejects.toThrow('storage setItem requires two string arguments.');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('clears renderer-owned keys without deleting main-owned ledgers', async () => {
    await invoke('storage:clear');

    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.clearExcept).toHaveBeenCalledWith([
      'lastFolderPath',
      'recentRootsList',
      'recentRootsList.corrupt',
      'rootsList',
      'rootsList.corrupt',
    ]);
  });

  it('does not serve storage test helpers outside Electron E2E mode', async () => {
    await expect(invoke('storage:seedMainOwnedForE2e', 'rootsList', '[]')).rejects.toThrow(
      'No desktop IPC handler for storage:seedMainOwnedForE2e.'
    );
    await expect(invoke('storage:clearAllForE2e')).rejects.toThrow(
      'No desktop IPC handler for storage:clearAllForE2e.'
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it('refuses untracked senders and foreign frames on every storage and settings method', async () => {
    const methods = [
      'storage:getItem',
      'storage:setItem',
      'storage:removeItem',
      'storage:clear',
      'storage:getAllKeys',
      'settings:clearAll',
    ];
    for (const method of methods) {
      await expect(invokeFrom(UNTRACKED_SENDER_ID, method, { malformed: true })).rejects.toThrow(
        `Desktop IPC ${method} requires an app window sender.`
      );
      await expect(
        invokeDesktopIpcFrom(
          ipcMain,
          {
            sender: { id: SPOOFED_VISIBLE_UI_SENDER_ID },
            senderFrame: { url: 'https://evil.example/' },
          },
          method,
          { malformed: true }
        )
      ).rejects.toThrow(`Desktop IPC ${method} rejected an unrecognized sender frame URL.`);
    }
    expect(storage.clearExcept).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it('serves bounded storage helpers only in Electron E2E mode', async () => {
    unregister();
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    register();

    await invoke('storage:seedMainOwnedForE2e', 'rootsList', '[{"path":"/test"}]');
    expect(storage.setItem).toHaveBeenCalledWith('rootsList', '[{"path":"/test"}]');

    await expect(
      invokeFrom(UNTRACKED_SENDER_ID, 'storage:seedMainOwnedForE2e', 'rootsList', '[]')
    ).rejects.toThrow('Desktop IPC storage:seedMainOwnedForE2e requires an app window sender.');

    await expect(
      invoke('storage:seedMainOwnedForE2e', 'assistant-preferences.v1', '{}')
    ).rejects.toThrow('E2E main-owned storage seed requires a main-owned key');

    await invoke('storage:clearAllForE2e');
    expect(storage.clear).toHaveBeenCalledTimes(1);
  });

  it('clears settings and stops serving its methods once unregistered', async () => {
    await expect(invoke('settings:clearAll')).resolves.toEqual({ success: true });
    expect(store.clear).toHaveBeenCalled();

    unregister();

    await expect(invoke('storage:getItem', 'alpha')).rejects.toThrow(
      'No desktop IPC handler for storage:getItem.'
    );
    await expect(invoke('settings:clearAll')).rejects.toThrow(
      'No desktop IPC handler for settings:clearAll.'
    );
  });
});
