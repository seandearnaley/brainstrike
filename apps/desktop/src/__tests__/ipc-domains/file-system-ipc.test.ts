import path from 'node:path';
import { AccessError, type DirectoryHandle, type FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  createFileSystem,
  createStorage,
  E2E_FILE_SYSTEM_FIXTURE_KEY,
  getRootsDatabase,
  handlers,
  removeHandler,
  rootsDbQuery,
} from './file-system-ipc-test-harness';

describe('file system IPC domain', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    rootsDbQuery.mockClear();
    getRootsDatabase.mockClear();
    vi.stubEnv('NODE_ENV', 'production');
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
    fileSystem = createFileSystem('/users/test/workspace');
    storage = createStorage();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
  });

  function register(): () => void {
    return registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: () => true,
      storage,
    });
  }

  it('selects, mounts, persists, and stamps a root through the legacy picker channel', async () => {
    register();

    const handle = (await handlers.get('fs:requestDirectoryAccess')?.(
      {} as IpcMainInvokeEvent
    )) as DirectoryHandle;

    expect(handle).toMatchObject({
      kind: 'directory',
      path: path.resolve('/users/test/workspace'),
      platform: 'electron',
    });
    expect(handle.rootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.setItem).toHaveBeenCalledWith(
      'rootsList',
      expect.stringContaining(handle.rootId ?? '')
    );
    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', handle.path);
  });

  it('honors only the explicit synthetic-filesystem registration seam', async () => {
    vi.stubEnv('VITEST', 'true');
    fileSystem = createFileSystem('/mock/denied-by-explicit-seam');
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: () => false,
      storage,
    });

    await expect(handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.any(String));
  });

  it('freezes synthetic-filesystem classification for the mounted root', async () => {
    vi.stubEnv('VITEST', 'true');
    let classificationCalls = 0;
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: () => {
        classificationCalls += 1;
        return classificationCalls === 1;
      },
      storage,
    });

    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    await expect(
      handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, {
        kind: 'file',
        name: 'readme.md',
        path: '/users/test/workspace/readme.md',
        platform: 'electron',
        rootId: descriptor.handle.rootId,
      } satisfies FileHandle)
    ).resolves.toBe('file content');
    expect(classificationCalls).toBe(1);
  });

  it('binds native canonical paths to the presentation-path classification', async () => {
    const nativeReadFile = vi.fn(async () => ({
      content: Buffer.from('native content'),
      status: 'ok' as const,
    }));
    const resolveNativeReadPath = vi.fn(async (_requestedPath: string, canonicalRoot: string) =>
      path.join(canonicalRoot, 'readme.md')
    );
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: (rootPath) => rootPath.startsWith('/mock/'),
      storage,
      workspaceRootRegistryFileSystemSeams: {
        createSecureRoot: async () => ({
          canonicalPath: '/mock/canonical-native-root',
          close: () => undefined,
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: nativeReadFile,
        }),
        resolveReadPath: resolveNativeReadPath,
      },
    });

    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    await expect(
      handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, {
        kind: 'file',
        name: 'readme.md',
        path: '/users/test/workspace/readme.md',
        platform: 'electron',
        rootId: descriptor.handle.rootId,
      } satisfies FileHandle)
    ).resolves.toBe('native content');
    expect(resolveNativeReadPath).toHaveBeenCalledWith(
      '/users/test/workspace/readme.md',
      '/mock/canonical-native-root'
    );
    expect(nativeReadFile).toHaveBeenCalledWith('readme.md', expect.any(Number));
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('keeps explicit native classification authoritative for mock-prefixed reads', async () => {
    fileSystem = createFileSystem('/mock/native-root');
    const nativeListDir = vi.fn(async () => ({
      entries: [
        {
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          name: 'native.txt',
        },
      ],
      inspected: 1,
      truncated: false,
    }));
    const nativeReadFile = vi.fn(async () => ({
      content: Buffer.from('native content'),
      status: 'ok' as const,
    }));
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: () => false,
      storage,
      workspaceRootRegistryFileSystemSeams: {
        createSecureRoot: async () => ({
          canonicalPath: '/mock/native-root',
          close: () => undefined,
          listDir: nativeListDir,
          readFile: nativeReadFile,
        }),
        resolveReadPath: async (requestedPath) => requestedPath,
      },
    });

    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    const fileHandle = {
      kind: 'file',
      name: 'native.txt',
      path: '/mock/native-root/native.txt',
      platform: 'electron',
      rootId: descriptor.handle.rootId,
    } satisfies FileHandle;

    await expect(
      handlers.get('fs:readDirectory')?.({} as IpcMainInvokeEvent, descriptor.handle)
    ).resolves.toMatchObject([{ name: 'native.txt' }]);
    await expect(handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, fileHandle)).resolves.toBe(
      'native content'
    );
    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, fileHandle.path)
    ).resolves.toBe('native content');
    expect(nativeListDir).toHaveBeenCalledOnce();
    expect(nativeReadFile).toHaveBeenCalledTimes(2);
  });

  it('closes a native capability when canonical classification conflicts', async () => {
    fileSystem = createFileSystem('/mock/test/directory');
    const closeNativeRoot = vi.fn();
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      isSyntheticFileSystemPath: (rootPath) => rootPath === '/mock/test/directory',
      storage,
      workspaceRootRegistryFileSystemSeams: {
        createSecureRoot: async () => ({
          canonicalPath: '/mock/test/directory',
          close: closeNativeRoot,
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: async () => ({ content: Buffer.alloc(0), status: 'ok' }),
        }),
        resolveReadPath: async (requestedPath) => requestedPath,
      },
    });

    const syntheticDescriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    await handlers.get('fs:removeRoot')?.(
      {} as IpcMainInvokeEvent,
      syntheticDescriptor.handle.rootId
    );
    vi.mocked(fileSystem.requestDirectoryAccess).mockResolvedValueOnce({
      kind: 'directory',
      name: 'workspace',
      path: '/users/test/workspace',
      platform: 'electron',
    });

    await expect(handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
      'Conflicting filesystem classification'
    );
    expect(closeNativeRoot).toHaveBeenCalledOnce();
  });

  it('keeps fixture I/O isolated from the real adapter while still stamping authority', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const fixtureRoot = {
      id: 'fixture-root',
      kind: 'directory',
      name: 'fixture',
      path: '/fixture',
      type: 'directory',
    } as DirectoryHandle & { id: string; type: 'directory' };
    const fixture = {
      directoriesByPath: { '/fixture': [] },
      fileContentsByPath: { '/fixture/readme.md': 'fixture content' },
      readDirectoryCalls: [] as string[],
      readFileByPathCalls: [] as string[],
      readFileCalls: [] as string[],
      requestDirectoryAccessCount: 0,
      rootHandle: fixtureRoot,
    };
    (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY] =
      fixture;
    register();

    const selected = (await handlers.get('fs:requestDirectoryAccess')?.(
      {} as IpcMainInvokeEvent
    )) as DirectoryHandle;
    expect(selected).toMatchObject({ path: '/fixture', rootId: expect.any(String) });
    await expect(
      handlers.get('fs:readDirectory')?.({} as IpcMainInvokeEvent, selected)
    ).resolves.toEqual([]);
    await expect(
      handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, {
        kind: 'file',
        name: 'readme.md',
        path: '/fixture/readme.md',
        platform: 'electron',
        rootId: selected.rootId,
      } satisfies FileHandle)
    ).resolves.toBe('fixture content');
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fileSystem.readDirectory).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('rejects rootless and out-of-root reads instead of falling back to raw adapter paths', async () => {
    register();
    await expect(
      handlers.get('fs:readFileByPath')?.(
        {} as IpcMainInvokeEvent,
        '/users/test/workspace/readme.md'
      )
    ).rejects.toThrow('outside every mounted workspace root');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();

    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, '/users/test/outside.txt')
    ).rejects.toThrow('outside every mounted workspace root');
    await expect(
      handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, {
        kind: 'file',
        name: 'escape.txt',
        path: '/users/test/outside.txt',
        platform: 'electron',
        rootId: descriptor.handle.rootId,
      } satisfies FileHandle)
    ).rejects.toThrow('outside the selected workspace root');
  });

  it('enforces the exact claimed mounted root for scoped absolute reads', async () => {
    register();
    const rootAPath = '/users/test/workspace-a';
    const rootBPath = '/users/test/workspace-b';
    vi.mocked(fileSystem.requestDirectoryAccess)
      .mockResolvedValueOnce({
        kind: 'directory',
        name: 'workspace-a',
        path: rootAPath,
        platform: 'electron',
      })
      .mockResolvedValueOnce({
        kind: 'directory',
        name: 'workspace-b',
        path: rootBPath,
        platform: 'electron',
      });

    await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);
    await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    const readScoped = handlers.get('fs:readFileByAbsolutePath');
    expect(readScoped).toBeDefined();
    await expect(
      readScoped?.({} as IpcMainInvokeEvent, path.join(rootBPath, 'readme.md'), rootBPath)
    ).resolves.toBe('file content');
    await expect(
      readScoped?.({} as IpcMainInvokeEvent, path.join(rootBPath, 'readme.md'), rootAPath)
    ).rejects.toThrow('outside the selected workspace root');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('preserves structured oversized and missing-file payloads after authorization', async () => {
    register();
    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    const file = {
      kind: 'file',
      name: 'large.txt',
      path: '/users/test/workspace/large.txt',
      platform: 'electron',
      rootId: descriptor.handle.rootId,
    } satisfies FileHandle;
    vi.mocked(fileSystem.readFile).mockRejectedValueOnce(
      new AccessError('File too large: 1.1MB (max: 750KB)', file.path, 'read')
    );

    await expect(handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, file)).resolves.toEqual({
      code: 'TOO_LARGE',
      message: 'File too large: 1.1MB (max: 750KB)',
    });
  });

  it('fails visibly on malformed root persistence and never converges it as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    register();

    await expect(handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
      'persisted workspace root registry is not valid JSON'
    );
    expect(rootsDbQuery).not.toHaveBeenCalled();
  });

  it('retains unavailable persisted roots for retry and excludes them from DB authorization', async () => {
    const available = {
      addedAt: 1,
      path: '/users/test/workspace',
      rootId: 'root-available',
    };
    const unavailable = {
      addedAt: 2,
      path: '/users/test/offline',
      rootId: 'root-offline',
    };
    storage = createStorage({ rootsList: JSON.stringify([available, unavailable]) });
    vi.mocked(fileSystem.exists).mockImplementation(async (candidate) =>
      candidate.endsWith('/workspace')
    );
    register();

    const restored = (await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent)) as Array<{
      permissionState: string;
      rootId: string;
    }>;

    expect(restored).toEqual([
      expect.objectContaining({ permissionState: 'granted', rootId: 'root-available' }),
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-offline' }),
    ]);
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([available, unavailable]));
    expect(rootsDbQuery.mock.calls[0]?.[1]).toEqual([['/users/test/workspace']]);
  });

  it('treats lastFolderPath only as a preference for an already-mounted persisted root', async () => {
    register();
    await expect(
      handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, '/users/test/workspace')
    ).rejects.toThrow('must reference a persisted mounted root');

    const descriptor = (await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent)) as {
      handle: DirectoryHandle;
    };
    await expect(
      handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, descriptor.handle.path)
    ).resolves.toBeUndefined();
    await expect(
      handlers.get('fs:restoreLastFolder')?.({} as IpcMainInvokeEvent)
    ).resolves.toMatchObject({
      path: descriptor.handle.path,
      rootId: descriptor.handle.rootId,
    });
  });

  it('rolls persisted removal back when DB convergence fails', async () => {
    const entry = {
      addedAt: 1,
      path: '/users/test/workspace',
      rootId: 'root-a',
    };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    register();
    await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);
    rootsDbQuery.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, 'root-a')
    ).rejects.toThrow('db unavailable');
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  });

  it('unregisters every file channel and disposes the registry', () => {
    const unregister = register();
    const channels = [...handlers.keys()];
    expect(channels).toContain('fs:readFile');
    expect(channels).toContain('fs:restoreRoots');

    unregister();

    expect(handlers.size).toBe(0);
    expect(removeHandler).toHaveBeenCalledTimes(channels.length);
  });
});
