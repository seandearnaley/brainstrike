import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

// Capture registered handlers
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
  },
}));

import { registerIpcHandlers } from '../../ipc-handlers';
import { getRootsCatalog, resetRootsCatalog } from '../ipc-domains/file-system-ipc-test-harness';

describe('ipc-handlers error branches', () => {
  let fsAdapter: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let store: Record<string, unknown>;

  beforeEach(() => {
    handlers.clear();
    resetRootsCatalog();
    vi.resetModules();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'development';

    fsAdapter = {
      exists: vi.fn(async () => true),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(async () => ({
        kind: 'directory',
        name: 'workspace',
        path: '/test/workspace',
        platform: 'electron',
      })),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;

    storage = {
      clear: vi.fn(),
      getAllKeys: vi.fn(),
      getItem: vi.fn(async () => null),
      removeItem: vi.fn(),
      setItem: vi.fn(async () => undefined),
    } as unknown as ElectronStorageAdapter;

    store = {};

    registerIpcHandlers(fsAdapter, storage, () => store as never, {
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
    });
  });

  it('fs:restoreLastFolder propagates storage errors', async () => {
    const handler = handlers.get('fs:restoreLastFolder');
    (storage.getItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    await expect(handler?.(createTrustedInvokeEvent())).rejects.toThrow('boom');
  });

  it('fs:saveLastFolder propagates storage.setItem errors', async () => {
    await handlers.get('fs:addRoot')?.(createTrustedInvokeEvent());
    const handler = handlers.get('fs:saveLastFolder');
    (storage.setItem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    await expect(handler?.(createTrustedInvokeEvent(), '/test/workspace')).rejects.toThrow('boom');
    expect(storage.setItem).toHaveBeenCalled();
  });
});
