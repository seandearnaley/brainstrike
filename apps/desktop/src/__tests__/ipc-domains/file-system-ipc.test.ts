import { AccessError, type DirectoryHandle, type FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
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

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';

const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;

function createFileSystem(): ElectronFileSystemAdapter {
  return {
    exists: vi.fn(async () => true),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    readFileByPath: vi.fn(async () => 'path content'),
    requestDirectoryAccess: vi.fn(
      async () =>
        ({
          id: 'real-dir',
          kind: 'directory',
          name: 'real-dir',
          path: '/real-dir',
          platform: 'electron',
          type: 'directory',
        }) as DirectoryHandle
    ),
    watchDirectory: vi.fn(),
  } as unknown as ElectronFileSystemAdapter;
}

function createStorage(): ElectronStorageAdapter {
  return {
    clear: vi.fn(async () => undefined),
    getAllKeys: vi.fn(async () => []),
    getItem: vi.fn(async () => null),
    removeItem: vi.fn(async () => undefined),
    setItem: vi.fn(async () => undefined),
  } as unknown as ElectronStorageAdapter;
}

describe('file system IPC domain', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
    fileSystem = createFileSystem();
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, storage });
  });

  it('registers fixture-aware directory access and directory reads', async () => {
    const rootHandle = {
      id: 'fixture-root',
      kind: 'directory',
      name: 'fixture',
      path: '/fixture',
      type: 'directory',
    } as DirectoryHandle & { id: string; type: 'directory' };
    (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY] = {
      directoriesByPath: { '/fixture': [] },
      fileContentsByPath: {},
      readDirectoryCalls: [],
      readFileByPathCalls: [],
      readFileCalls: [],
      requestDirectoryAccessCount: 0,
      rootHandle,
    };

    await expect(
      handlers.get('fs:requestDirectoryAccess')?.({} as IpcMainInvokeEvent)
    ).resolves.toBe(rootHandle);
    await expect(
      handlers.get('fs:readDirectory')?.({} as IpcMainInvokeEvent, rootHandle)
    ).resolves.toEqual([]);
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fileSystem.readDirectory).not.toHaveBeenCalled();
  });

  it('validates direct path reads before calling the adapter', async () => {
    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, '/tmp/\0bad')
    ).rejects.toThrow('Invalid path:');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();

    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, '/users/test/file.txt')
    ).resolves.toBe('path content');
    expect(fileSystem.readFileByPath).toHaveBeenCalledWith('/users/test/file.txt');
  });

  it('returns structured file-read payloads for expected read failures', async () => {
    const readFile = handlers.get('fs:readFile');
    const handle = { id: 'real-file', path: '/users/test/large.txt' } as FileHandle;
    vi.mocked(fileSystem.readFile).mockRejectedValueOnce(
      new AccessError('File too large: 1.1MB (max: 750KB)', handle.path, 'read')
    );

    await expect(readFile?.({} as IpcMainInvokeEvent, handle)).resolves.toEqual({
      code: 'TOO_LARGE',
      message: 'File too large: 1.1MB (max: 750KB)',
    });
  });

  it('restores last folder handles and unregisters file channels', async () => {
    vi.mocked(storage.getItem).mockResolvedValue('/users/test/project');

    await expect(handlers.get('fs:restoreLastFolder')?.({} as IpcMainInvokeEvent)).resolves.toEqual(
      {
        kind: 'directory',
        name: 'project',
        path: '/users/test/project',
        platform: 'electron',
      }
    );
    expect(fileSystem.exists).toHaveBeenCalledWith('/users/test/project');

    const unregister = registerFileSystemIpcHandlers({ fileSystem, storage });
    unregister();
    expect(removeHandler).toHaveBeenCalledWith('fs:requestDirectoryAccess');
    expect(removeHandler).toHaveBeenCalledWith('fs:readFileByPath');
    expect(removeHandler).toHaveBeenCalledWith('fs:restoreLastFolder');
  });
});
