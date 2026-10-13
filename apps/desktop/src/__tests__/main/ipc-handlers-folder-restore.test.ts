import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

// Main records each folder it mounts (BST-1990); a double stands in for its database.
vi.mock('../../db-main', async () => {
  const { createRootsDatabaseDouble } = await import('./roots-database-double');
  const database = createRootsDatabaseDouble();
  return { getDatabase: async () => database };
});

import { registerIpcHandlers } from '../../ipc-handlers';

describe('IPC handlers - last-folder preference', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let storedValues: Map<string, string>;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'development';
    storedValues = new Map();
    fileSystem = {
      exists: vi.fn(async () => true),
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => ''),
      requestDirectoryAccess: vi.fn(async () => ({
        kind: 'directory',
        name: 'workspace',
        path: '/test/workspace',
        platform: 'electron',
      })),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;
    storage = {
      clear: vi.fn(async () => storedValues.clear()),
      getAllKeys: vi.fn(async () => [...storedValues.keys()]),
      getItem: vi.fn(async (key: string) => storedValues.get(key) ?? null),
      removeItem: vi.fn(async (key: string) => storedValues.delete(key)),
      setItem: vi.fn(async (key: string, value: string) => {
        storedValues.set(key, value);
      }),
    } as unknown as ElectronStorageAdapter;
    registerIpcHandlers(fileSystem, storage, () => null, {
      isSyntheticFileSystemPath: () => true,
    });
  });

  it('registers the last-folder channels', () => {
    expect(handlers.has('fs:restoreLastFolder')).toBe(true);
    expect(handlers.has('fs:saveLastFolder')).toBe(true);
  });

  it('does not let lastFolderPath create a second root authority', async () => {
    storedValues.set('lastFolderPath', '/test/workspace');

    await expect(
      handlers.get('fs:restoreLastFolder')?.(createTrustedInvokeEvent())
    ).resolves.toBeNull();
    await expect(
      handlers.get('fs:saveLastFolder')?.(createTrustedInvokeEvent(), '/test/workspace')
    ).rejects.toThrow('must reference a persisted mounted root');
    expect(storedValues.has('rootsList')).toBe(false);
  });

  it('saves and restores only a root already mounted by the registry', async () => {
    const descriptor = (await handlers.get('fs:addRoot')?.(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };

    await handlers.get('fs:saveLastFolder')?.(createTrustedInvokeEvent(), descriptor.handle.path);

    await expect(
      handlers.get('fs:restoreLastFolder')?.(createTrustedInvokeEvent())
    ).resolves.toMatchObject({
      path: descriptor.handle.path,
      rootId: descriptor.handle.rootId,
    });
  });
});
