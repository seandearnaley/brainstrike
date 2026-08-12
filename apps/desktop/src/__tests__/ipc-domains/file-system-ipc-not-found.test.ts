import { AccessError, type FileHandle } from '@brainstrike/file-system';
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

describe('file-system IPC missing-file mapping', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
  });

  it('returns NOT_FOUND when a capability reports an ENOENT deletion race', async () => {
    const fileSystem = createFileSystem();
    const handle = {
      kind: 'file',
      name: 'deleted.txt',
      path: '/users/test/deleted.txt',
      platform: 'electron',
      rootId: 'root-1',
    } as FileHandle;
    vi.mocked(fileSystem.readFile).mockRejectedValue(
      new AccessError('ENOENT: File not found', handle.path, 'read')
    );
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage: createStorage(),
      workspaceFileCapabilities: createAdapterBackedCapabilities(fileSystem),
    });

    await expect(handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, handle)).resolves.toEqual({
      code: 'NOT_FOUND',
      message: 'ENOENT: File not found',
    });
  });
});
