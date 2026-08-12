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

describe('fs:restoreRoots canonical identity', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
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
});
