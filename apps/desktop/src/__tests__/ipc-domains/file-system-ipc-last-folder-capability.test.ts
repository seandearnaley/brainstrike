import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  createAdapterBackedCapabilities,
  createFileSystem,
  createStorage,
  getRootsDatabase,
  handlers,
  removeHandler,
} from './file-system-ipc-test-harness';

describe('fs:saveLastFolder capability rollback', () => {
  beforeEach(() => {
    handlers.clear();
    getRootsDatabase.mockClear();
    removeHandler.mockClear();
  });

  it('revokes an in-flight legacy restore when a concurrent disconnect finishes first', async () => {
    const entry = {
      addedAt: 1,
      path: path.resolve('/users/test/my-project'),
      rootId: 'root-existing',
    };
    const fileSystem = createFileSystem();
    const storage = createStorage({
      lastFolderPath: entry.path,
      rootsList: JSON.stringify([entry]),
    });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    let releaseMount: (() => void) | undefined;
    let markMountStarted: (() => void) | undefined;
    const mountPaused = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const mountStarted = new Promise<void>((resolve) => {
      markMountStarted = resolve;
    });
    vi.mocked(capabilities.mountRoot).mockImplementationOnce(async () => {
      markMountStarted?.();
      await mountPaused;
      return entry.path;
    });
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    const restorePromise = handlers.get('fs:restoreLastFolder')?.({} as IpcMainInvokeEvent);
    await mountStarted;
    const removePromise = handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, entry.rootId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(getRootsDatabase).toHaveBeenCalledOnce();
    expect(capabilities.unmountRoot).toHaveBeenCalledTimes(1);

    releaseMount?.();
    const [restored] = await Promise.all([restorePromise, removePromise]);
    expect(restored).toBeNull();
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(entry.rootId);
    expect(capabilities.unmountRoot).toHaveBeenCalledTimes(2);
    await expect(storage.getItem('rootsList')).resolves.toBe('[]');
  });

  it.each([
    'lastFolderPath',
    'rootsList',
  ])('unmounts a newly created capability when %s persistence fails', async (failingKey) => {
    const folderPath = path.resolve('/users/test/my-project');
    const fileSystem = createFileSystem();
    const storage = createStorage();
    vi.mocked(storage.setItem).mockImplementation(async (key) => {
      if (key === failingKey) {
        throw new Error('disk full');
      }
    });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    await expect(
      handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, folderPath)
    ).rejects.toThrow('disk full');

    const mountedIdentity = vi.mocked(capabilities.mountRoot).mock.calls[0]?.[0];
    expect(mountedIdentity).toBeDefined();
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(mountedIdentity?.rootId);
  });

  it('preserves a pre-existing capability when legacy persistence fails', async () => {
    const entry = {
      addedAt: 1,
      path: path.resolve('/users/test/my-project'),
      rootId: 'root-existing',
    };
    const fileSystem = createFileSystem();
    const storage = createStorage({ rootsList: JSON.stringify([entry]) });
    vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk full'));
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    if (!capabilities.getMountedRoot) {
      throw new Error('Test capability must expose mounted-root inspection.');
    }
    vi.mocked(capabilities.getMountedRoot).mockReturnValue(entry);
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    await expect(
      handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, entry.path)
    ).rejects.toThrow('disk full');

    expect(capabilities.mountRoot).not.toHaveBeenCalled();
    expect(capabilities.unmountRoot).not.toHaveBeenCalled();
  });
});
