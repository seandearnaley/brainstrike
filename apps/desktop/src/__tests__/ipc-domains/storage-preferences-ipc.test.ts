import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { handlers, removeHandler } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, IpcHandler>();
  return {
    handlers: registeredHandlers,
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import { registerStoragePreferencesIpcHandlers } from '../../ipc-domains/storage-preferences-ipc';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';

const EMBEDDING_HOST_SENDER_ID = 9401;
const VISIBLE_UI_SENDER_ID = 9402;

function trackSender(senderId: number, role: 'embedding-host' | 'visible-ui'): void {
  assignWindowRole(
    { isDestroyed: () => false, once: vi.fn(), webContents: { id: senderId } } as never,
    role
  );
}

function senderEvent(senderId: number): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: createAllowlistedSenderFrame(),
  } as unknown as IpcMainInvokeEvent;
}

interface FakeStore {
  clear: () => void;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
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
  const values = new Map<string, unknown>();
  return {
    clear: vi.fn(() => values.clear()),
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
}

describe('storage preferences IPC domain', () => {
  let storage: ElectronStorageAdapter;
  let store: FakeStore;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    storage = createStorage();
    store = createStore();
    registerStoragePreferencesIpcHandlers({
      getStore: () => store as never,
      storage,
    });
  });

  it('registers storage handlers through the desktop IPC registry', async () => {
    const getItem = handlers.get('storage:getItem');
    const setItem = handlers.get('storage:setItem');
    const removeItem = handlers.get('storage:removeItem');
    const clear = handlers.get('storage:clear');
    const getAllKeys = handlers.get('storage:getAllKeys');

    await expect(getItem?.({} as IpcMainInvokeEvent, 'alpha')).resolves.toBe('value:alpha');
    await setItem?.({} as IpcMainInvokeEvent, 'alpha', 'beta');
    await removeItem?.({} as IpcMainInvokeEvent, 'alpha');
    await clear?.({} as IpcMainInvokeEvent);
    await expect(getAllKeys?.({} as IpcMainInvokeEvent)).resolves.toEqual(['alpha']);

    expect(storage.getItem).toHaveBeenCalledWith('alpha');
    expect(storage.setItem).toHaveBeenCalledWith('alpha', 'beta');
    expect(storage.removeItem).toHaveBeenCalledWith('alpha');
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.getAllKeys).toHaveBeenCalled();
    expect(storage.clearExcept).toHaveBeenCalledWith([
      'lastFolderPath',
      'notesVaultRoots',
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
    'notesVaultRoots',
    'lastFolderPath',
  ])('refuses renderer writes and removals for main-owned key %s', async (key) => {
    const setItem = handlers.get('storage:setItem');
    const removeItem = handlers.get('storage:removeItem');

    await expect(setItem?.({} as IpcMainInvokeEvent, key, 'value')).rejects.toThrow(
      `Storage key "${key}" is main-owned`
    );
    await expect(removeItem?.({} as IpcMainInvokeEvent, key)).rejects.toThrow(
      `Storage key "${key}" is main-owned`
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('rejects non-string renderer values at the IPC boundary', async () => {
    const setItem = handlers.get('storage:setItem');

    await expect(
      setItem?.({} as IpcMainInvokeEvent, 'assistant-preferences.v1', { invalid: true })
    ).rejects.toThrow('Storage value must be a string');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('clears renderer-owned keys without deleting main-owned ledgers', async () => {
    const clear = handlers.get('storage:clear');

    await clear?.({} as IpcMainInvokeEvent);

    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.clearExcept).toHaveBeenCalledWith([
      'lastFolderPath',
      'notesVaultRoots',
      'recentRootsList',
      'recentRootsList.corrupt',
      'rootsList',
      'rootsList.corrupt',
    ]);
  });

  it('does not register storage test helpers outside Electron E2E mode', () => {
    expect(handlers.has('storage:seedMainOwnedForE2e')).toBe(false);
    expect(handlers.has('storage:clearAllForE2e')).toBe(false);
  });

  it('registers bounded storage helpers only in Electron E2E mode', async () => {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    try {
      registerStoragePreferencesIpcHandlers({
        getStore: () => store as never,
        storage,
      });
      const seedMainOwned = handlers.get('storage:seedMainOwnedForE2e');
      const clearAll = handlers.get('storage:clearAllForE2e');

      await seedMainOwned?.({} as IpcMainInvokeEvent, 'rootsList', '[{"path":"/test"}]');
      expect(storage.setItem).toHaveBeenCalledWith('rootsList', '[{"path":"/test"}]');

      await expect(
        seedMainOwned?.({} as IpcMainInvokeEvent, 'assistant-preferences.v1', '{}')
      ).rejects.toThrow('E2E main-owned storage seed requires a main-owned key');

      await clearAll?.({} as IpcMainInvokeEvent);
      expect(storage.clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('persists only valid panel layout payloads', async () => {
    const save = handlers.get('layout:save');

    await expect(
      save?.({} as IpcMainInvokeEvent, {
        showConsole: true,
        showLeftPanel: false,
        showRightPanel: true,
        sizes: [25, 50, 25],
      })
    ).resolves.toEqual({ success: true });
    expect(store.set).toHaveBeenCalledWith('panelLayout', {
      v1: {
        showConsole: true,
        showLeftPanel: false,
        showRightPanel: true,
        sizes: [25, 50, 25],
      },
    });

    await expect(
      save?.({} as IpcMainInvokeEvent, {
        showConsole: true,
        showLeftPanel: false,
        showRightPanel: true,
        sizes: [Number.POSITIVE_INFINITY],
      })
    ).resolves.toEqual({ message: 'Invalid panel layout payload', success: false });
  });

  it('loads persisted panel layout and rejects corrupt stored values', async () => {
    const load = handlers.get('layout:load');
    store.set('panelLayout', {
      v1: {
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: true,
        sizes: [30, 70],
      },
    });

    await expect(load?.({} as IpcMainInvokeEvent)).resolves.toEqual({
      data: {
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: true,
        sizes: [30, 70],
      },
      success: true,
    });

    store.set('panelLayout', { v1: { sizes: [50] } });
    await expect(load?.({} as IpcMainInvokeEvent)).resolves.toEqual({
      message: 'Invalid panel layout data',
      success: false,
    });
  });

  it('clears settings and unregisters owned channels', async () => {
    const clearAll = handlers.get('settings:clearAll');
    await expect(clearAll?.({} as IpcMainInvokeEvent)).resolves.toEqual({ success: true });
    expect(store.clear).toHaveBeenCalled();

    const unregister = registerStoragePreferencesIpcHandlers({
      getStore: () => store as never,
      storage,
    });
    unregister();

    expect(removeHandler).toHaveBeenCalledWith('storage:getItem');
    expect(removeHandler).toHaveBeenCalledWith('layout:save');
    expect(removeHandler).toHaveBeenCalledWith('settings:clearAll');
  });

  describe('scoped vector preferences capability (BST-1380)', () => {
    beforeEach(() => {
      trackSender(EMBEDDING_HOST_SENDER_ID, 'embedding-host');
      trackSender(VISIBLE_UI_SENDER_ID, 'visible-ui');
    });

    afterEach(() => {
      clearWindowRoleByWebContentsId(EMBEDDING_HOST_SENDER_ID);
      clearWindowRoleByWebContentsId(VISIBLE_UI_SENDER_ID);
    });

    it('serves the embedding host the canonical record without accepting a key', async () => {
      const read = handlers.get('vector-preferences:read');
      const write = handlers.get('vector-preferences:write');
      const clear = handlers.get('vector-preferences:clear');

      // A renderer-supplied key is ignored: main pins the record.
      await expect(read?.(senderEvent(EMBEDDING_HOST_SENDER_ID), 'other-store.v1')).resolves.toBe(
        'value:vector-preferences.v1'
      );
      expect(storage.getItem).toHaveBeenCalledWith('vector-preferences.v1');

      await write?.(senderEvent(EMBEDDING_HOST_SENDER_ID), '{"state":{},"version":3}');
      expect(storage.setItem).toHaveBeenCalledWith(
        'vector-preferences.v1',
        '{"state":{},"version":3}'
      );

      await clear?.(senderEvent(EMBEDDING_HOST_SENDER_ID));
      expect(storage.removeItem).toHaveBeenCalledWith('vector-preferences.v1');
      expect(storage.clear).not.toHaveBeenCalled();
      expect(storage.getAllKeys).not.toHaveBeenCalled();
    });

    it('rejects a non-string payload before it reaches the adapter', async () => {
      const write = handlers.get('vector-preferences:write');

      await expect(write?.(senderEvent(EMBEDDING_HOST_SENDER_ID), 42)).rejects.toThrow(
        'Vector preferences payload must be a string.'
      );
      expect(storage.setItem).not.toHaveBeenCalled();
    });

    it.each([
      ['the visible UI, which uses the full storage bridge', VISIBLE_UI_SENDER_ID],
      ['an untracked sender', 9403],
    ] as const)('rejects %s', async (_label, senderId) => {
      const read = handlers.get('vector-preferences:read');

      await expect(read?.(senderEvent(senderId))).rejects.toThrow(
        'Desktop IPC vector-preferences:read requires sender role embedding-host.'
      );
      expect(storage.getItem).not.toHaveBeenCalled();
    });
  });
});
