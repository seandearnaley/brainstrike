import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  clearE2eFileSystemFixture,
  createAdapterBackedCapabilities,
  createFileSystem,
  createStorage,
  getRootsDatabase,
  handlers,
  removeHandler,
} from './file-system-ipc-test-harness';

describe('fs:restoreRoots canonical identity', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    clearE2eFileSystemFixture();
  });

  it('deduplicates stored aliases that canonicalize to the same root', async () => {
    const aliasPath = path.resolve('/users/test/project-link');
    const canonicalPath = path.resolve('/users/test/project');
    const aliasEntry = { addedAt: 1, path: aliasPath, rootId: 'root-alias' };
    const canonicalEntry = { addedAt: 2, path: canonicalPath, rootId: 'root-canonical' };
    const fileSystem = createFileSystem();
    const storage = createStorage({ rootsList: JSON.stringify([aliasEntry, canonicalEntry]) });
    const workspaceFileCapabilities = createAdapterBackedCapabilities(fileSystem);
    vi.mocked(workspaceFileCapabilities.mountRoot).mockResolvedValue(canonicalPath);
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities,
    });

    await expect(handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)).resolves.toEqual([
      expect.objectContaining({ rootId: 'root-alias' }),
    ]);
    expect(workspaceFileCapabilities.unmountRoot).toHaveBeenCalledWith('root-canonical');
    await expect(storage.getItem('rootsList')).resolves.toBe(
      JSON.stringify([{ ...aliasEntry, path: canonicalPath }])
    );
  });

  it('surfaces capability mount failures without pruning the saved root', async () => {
    const rootPath = path.resolve('/users/test/temporarily-unmountable');
    const entry = { addedAt: 1000, path: rootPath, rootId: 'root-id-1' };
    const fileSystem = createFileSystem();
    const storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    vi.mocked(capabilities.mountRoot).mockRejectedValueOnce(new Error('descriptor unavailable'));
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    await expect(handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
      'descriptor unavailable'
    );
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.anything());
    expect(capabilities.retainRoots).not.toHaveBeenCalled();
  });

  it('serializes addRoot behind restore finalization so neither mutation is lost', async () => {
    const restoredPath = path.resolve('/users/test/restored');
    const restoredEntry = { addedAt: 1000, path: restoredPath, rootId: 'root-restored' };
    const fileSystem = createFileSystem('/users/test/added');
    const storage = createStorage({ rootsList: JSON.stringify([restoredEntry]) });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restorePause = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    vi.mocked(capabilities.mountRoot).mockImplementationOnce(async ({ path: rootPath }) => {
      markRestoreStarted?.();
      await restorePause;
      return path.resolve(rootPath);
    });
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    const restorePromise = handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);
    await restoreStarted;
    let addSettled = false;
    const addPromise = Promise.resolve(
      handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)
    ).finally(() => {
      addSettled = true;
    });
    await Promise.resolve();
    expect(addSettled).toBe(false);

    releaseRestore?.();
    await Promise.all([restorePromise, addPromise]);
    const storedRoots = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as Array<{
      path: string;
      rootId: string;
    }>;
    expect(storedRoots).toEqual([
      restoredEntry,
      expect.objectContaining({ path: '/mock/test/directory' }),
    ]);
  });
});
