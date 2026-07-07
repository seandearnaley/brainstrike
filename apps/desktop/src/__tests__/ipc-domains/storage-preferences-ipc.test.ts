import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

interface FakeStore {
  clear: () => void;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

function createStorage(): ElectronStorageAdapter {
  return {
    clear: vi.fn(async () => undefined),
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
    expect(storage.clear).toHaveBeenCalled();
    expect(storage.getAllKeys).toHaveBeenCalled();
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
});
