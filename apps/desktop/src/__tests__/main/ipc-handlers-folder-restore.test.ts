import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers } from '../../ipc-handlers';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  getRootsCatalog,
  resetRootsCatalog,
} from '../ipc-domains/file-system-ipc-test-harness';

vi.mock('electron', async () => ({
  ...(await import('../ipc-domains/file-system-ipc-test-harness')).electronMock,
  app: { getPath: vi.fn() },
}));

describe('IPC handlers - last-folder preference', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let storedValues: Map<string, string>;
  let close: () => Promise<void>;

  beforeEach(() => {
    resetRootsCatalog();
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
    close = registerIpcHandlers(fileSystem, storage, () => null, {
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
    });
  });

  afterEach(async () => {
    await close();
  });

  it('does not let lastFolderPath create a second root authority', async () => {
    storedValues.set('lastFolderPath', '/test/workspace');

    await expect(
      capabilityHandler('fs:restoreLastFolder')(createTrustedInvokeEvent())
    ).resolves.toBeNull();
    await expect(
      capabilityHandler('fs:saveLastFolder')(createTrustedInvokeEvent(), '/test/workspace')
    ).rejects.toMatchObject({
      code: 'boundary.internal',
      failure: { category: 'internal', kind: 'fault' },
    });
    expect(storedValues.has('rootsList')).toBe(false);
  });

  it('saves and restores only a root already mounted by the registry', async () => {
    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };

    await capabilityHandler('fs:saveLastFolder')(
      createTrustedInvokeEvent(),
      descriptor.handle.path
    );

    await expect(
      capabilityHandler('fs:restoreLastFolder')(createTrustedInvokeEvent())
    ).resolves.toMatchObject({
      path: descriptor.handle.path,
      rootId: descriptor.handle.rootId,
    });
  });
});
