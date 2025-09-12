import type { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture registered handlers
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
  },
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
}));

import { registerIpcHandlers } from '../../ipc-handlers';

describe('ipc-handlers error branches', () => {
  let fsAdapter: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let store: Record<string, unknown>;

  beforeEach(() => {
    handlers.clear();
    vi.resetModules();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'development';

    fsAdapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(async () => true),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;

    storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    } as unknown as ElectronStorageAdapter;

    store = {};

    registerIpcHandlers(fsAdapter, storage, store as never);
  });

  it('fs:restoreLastFolder swallows storage error and returns null', async () => {
    const handler = handlers.get('fs:restoreLastFolder');
    (storage.getItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    const res = await handler?.({} as unknown as IpcMainInvokeEvent);
    expect(res).toBeNull();
  });

  it('fs:saveLastFolder swallows storage.setItem error', async () => {
    const handler = handlers.get('fs:saveLastFolder');
    (storage.setItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    // Should not throw
    await handler?.({} as unknown as IpcMainInvokeEvent, '/tmp/folder');
    expect(storage.setItem).toHaveBeenCalled();
  });
});
