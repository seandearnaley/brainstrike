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
  rootsDbQuery,
} from './file-system-ipc-test-harness';

describe('fs:restoreRoots canonical identity', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    rootsDbQuery.mockClear();
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

  it('serializes removeRoot behind restore finalization so a removed capability stays unmounted', async () => {
    const restoredPath = path.resolve('/users/test/restored');
    const restoredEntry = { addedAt: 1000, path: restoredPath, rootId: 'root-restored' };
    const fileSystem = createFileSystem();
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
    const databaseCallsBeforeRemove = getRootsDatabase.mock.calls.length;
    const removePromise = handlers.get('fs:removeRoot')?.(
      {} as IpcMainInvokeEvent,
      restoredEntry.rootId
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(getRootsDatabase).toHaveBeenCalledTimes(databaseCallsBeforeRemove);

    releaseRestore?.();
    await Promise.all([restorePromise, removePromise]);
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(restoredEntry.rootId);
    await expect(storage.getItem('rootsList')).resolves.toBe('[]');
  });

  it('rolls back only newly mounted capabilities when a batched restore aborts', async () => {
    const preexisting = {
      addedAt: 1,
      path: path.resolve('/users/test/preexisting'),
      rootId: 'root-preexisting',
    };
    const newlyMounted = {
      addedAt: 2,
      path: path.resolve('/users/test/new'),
      rootId: 'root-new',
    };
    const failing = {
      addedAt: 3,
      path: path.resolve('/users/test/failing'),
      rootId: 'root-failing',
    };
    const originalRoots = [preexisting, newlyMounted, failing];
    const fileSystem = createFileSystem();
    const storage = createStorage({ rootsList: JSON.stringify(originalRoots) });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    if (!capabilities.getMountedRoot) {
      throw new Error('Test capability must expose mounted-root inspection.');
    }
    vi.mocked(capabilities.getMountedRoot).mockImplementation((rootId) =>
      rootId === preexisting.rootId
        ? { path: preexisting.path, rootId: preexisting.rootId }
        : undefined
    );
    vi.mocked(capabilities.mountRoot).mockImplementation(async (identity) => {
      if (identity.rootId === failing.rootId) {
        throw new Error('descriptor unavailable');
      }
      return path.resolve(identity.path);
    });
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    await expect(handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
      'descriptor unavailable'
    );
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(newlyMounted.rootId);
    expect(capabilities.unmountRoot).not.toHaveBeenCalledWith(preexisting.rootId);
    expect(capabilities.retainRoots).not.toHaveBeenCalled();
    await expect(storage.getItem('rootsList')).resolves.toBe(JSON.stringify(originalRoots));
  });

  it('retains a session-only capability during a later durable-root restore', async () => {
    const fileSystem = createFileSystem('/users/test/session-only');
    const storage = createStorage();
    vi.mocked(storage.setItem).mockImplementation(async (key) => {
      if (key === 'rootsList') {
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

    const added = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as
      | { persisted: boolean; rootId: string }
      | undefined;
    expect(added).toMatchObject({ persisted: false });
    if (!added) {
      throw new Error('Expected addRoot to return a session-only descriptor.');
    }
    vi.mocked(capabilities.retainRoots).mockClear();

    await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);

    expect(capabilities.retainRoots).toHaveBeenLastCalledWith(new Set([added.rootId]));
  });

  it('keeps a failed-persistence disconnect revoked during later restores', async () => {
    const entry = {
      addedAt: 1,
      path: path.resolve('/users/test/revoked'),
      rootId: 'root-revoked',
    };
    const fileSystem = createFileSystem(entry.path);
    const storage = createStorage({ rootsList: JSON.stringify([entry]) });
    vi.mocked(storage.setItem).mockImplementation(async (key) => {
      if (key === 'rootsList') {
        throw new Error('storage unavailable');
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
      handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, entry.rootId)
    ).rejects.toThrow('storage unavailable');
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(entry.rootId);
    vi.mocked(capabilities.mountRoot).mockClear();

    await expect(handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
      'storage unavailable'
    );
    expect(capabilities.mountRoot).not.toHaveBeenCalledWith(entry);

    vi.mocked(storage.setItem).mockResolvedValue(undefined);
    await handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, entry.path);
    vi.mocked(capabilities.mountRoot).mockClear();
    await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);
    expect(capabilities.mountRoot).toHaveBeenCalledWith(
      expect.objectContaining({ path: entry.path, rootId: entry.rootId })
    );
  });

  it('revokes session authority when the durable DB transition fails', async () => {
    const entry = {
      addedAt: 1,
      path: path.resolve('/users/test/db-failure'),
      rootId: 'root-db-failure',
    };
    const fileSystem = createFileSystem();
    const storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const capabilities = createAdapterBackedCapabilities(fileSystem);
    rootsDbQuery.mockRejectedValueOnce(new Error('db unavailable'));
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage,
      workspaceFileCapabilities: capabilities,
    });

    await expect(
      handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, entry.rootId)
    ).rejects.toThrow('db unavailable');

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(capabilities.unmountRoot).toHaveBeenCalledWith(entry.rootId);
  });
});
