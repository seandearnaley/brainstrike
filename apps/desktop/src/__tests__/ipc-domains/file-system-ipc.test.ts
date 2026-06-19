import path from 'node:path';
import { AccessError, type DirectoryHandle, type FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function makeDirHandle(dirPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(dirPath),
    path: dirPath,
    platform: 'electron',
  };
}

function createFileSystem(pickedPath = '/real-dir'): ElectronFileSystemAdapter {
  return {
    exists: vi.fn(async () => true),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    readFileByPath: vi.fn(async () => 'path content'),
    requestDirectoryAccess: vi.fn(async () => makeDirHandle(pickedPath)),
    watchDirectory: vi.fn(),
  } as unknown as ElectronFileSystemAdapter;
}

function createStorage(storedItems: Record<string, string> = {}): ElectronStorageAdapter {
  const store: Record<string, string> = { ...storedItems };
  return {
    clear: vi.fn(async () => undefined),
    getAllKeys: vi.fn(async () => Object.keys(store)),
    getItem: vi.fn(async (key: string) => store[key] ?? null),
    removeItem: vi.fn(async (key: string) => {
      delete store[key];
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
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
    const validPath = path.resolve('/users/test/file.txt');

    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, '/tmp/\0bad')
    ).rejects.toThrow('Invalid path:');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();

    await expect(
      handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, '/users/test/file.txt')
    ).resolves.toBe('path content');
    expect(fileSystem.readFileByPath).toHaveBeenCalledWith(validPath);
  });

  it('validates handle paths before reading directories and files', async () => {
    await expect(
      handlers.get('fs:readDirectory')?.(
        {} as IpcMainInvokeEvent,
        {
          kind: 'directory',
          name: 'bad',
          path: '/tmp/\0bad',
          platform: 'electron',
        } as DirectoryHandle
      )
    ).rejects.toThrow('Invalid directory handle path:');
    expect(fileSystem.readDirectory).not.toHaveBeenCalled();

    await expect(
      handlers.get('fs:readFile')?.(
        {} as IpcMainInvokeEvent,
        {
          kind: 'file',
          name: 'bad',
          path: '/tmp/\0bad',
          platform: 'electron',
        } as FileHandle
      )
    ).rejects.toThrow('Invalid file handle path:');
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('validates persisted last-folder paths before storing or restoring them', async () => {
    await expect(
      handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, '/tmp/\0bad')
    ).resolves.toBeUndefined();
    expect(storage.setItem).not.toHaveBeenCalled();

    vi.mocked(storage.getItem).mockResolvedValue('/tmp/\0bad');
    await expect(handlers.get('fs:restoreLastFolder')?.({} as IpcMainInvokeEvent)).resolves.toBe(
      null
    );
    expect(fileSystem.exists).not.toHaveBeenCalled();
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
    const restoredPath = path.resolve('/users/test/project');
    vi.mocked(storage.getItem).mockResolvedValue('/users/test/project');

    await expect(handlers.get('fs:restoreLastFolder')?.({} as IpcMainInvokeEvent)).resolves.toEqual(
      {
        kind: 'directory',
        name: 'project',
        path: restoredPath,
        platform: 'electron',
      }
    );
    expect(fileSystem.exists).toHaveBeenCalledWith(restoredPath);

    const unregister = registerFileSystemIpcHandlers({ fileSystem, storage });
    unregister();
    expect(removeHandler).toHaveBeenCalledWith('fs:requestDirectoryAccess');
    expect(removeHandler).toHaveBeenCalledWith('fs:readFileByPath');
    expect(removeHandler).toHaveBeenCalledWith('fs:restoreLastFolder');
  });
});

describe('fs:restoreRoots', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
  });

  it('returns roots from rootsList, validating each path and pruning stale entries', async () => {
    const goodPath = path.resolve('/users/test/good-project');
    const badPath = path.resolve('/users/test/gone-project');
    const entry1 = { addedAt: 1000, path: goodPath, rootId: 'root-id-1' };
    const entry2 = { addedAt: 2000, path: badPath, rootId: 'root-id-2' };
    const rootsList = JSON.stringify([entry1, entry2]);

    fileSystem = {
      exists: vi.fn(async (p: string) => p === goodPath),
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => ''),
      readFileByPath: vi.fn(async () => ''),
      requestDirectoryAccess: vi.fn(async () => makeDirHandle(goodPath)),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;

    storage = createStorage({ rootsList });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);

    expect(result).toEqual([
      {
        displayName: 'good-project',
        handle: {
          kind: 'directory',
          name: 'good-project',
          path: goodPath,
          platform: 'electron',
        },
        kind: 'path',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-id-1',
      },
    ]);

    // Pruned list (only survivor) must have been written back
    expect(storage.setItem).toHaveBeenCalledWith('rootsList', JSON.stringify([entry1]));
  });

  it('returns [] when rootsList is absent (legacy lastFolderPath is NOT consulted — greenfield)', async () => {
    fileSystem = createFileSystem();
    // storage has no rootsList key but does have lastFolderPath (should be ignored)
    storage = createStorage({ lastFolderPath: '/some/old/path' });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);

    expect(result).toEqual([]);
    expect(fileSystem.exists).not.toHaveBeenCalled();
  });

  // Regression: a raw fileSystem.exists stats the real disk, so e2e-seeded
  // mock-path roots ('/mock/...') were silently pruned from rootsList on the
  // first restore — breaking every startup-restore spec that seeds roots.
  it('does NOT prune mock-path roots (e2e seeds) on restore', async () => {
    const mockEntry = { addedAt: 1000, path: '/mock/test/directory', rootId: 'mock-root-id' };
    fileSystem = {
      exists: vi.fn(async () => false), // real disk says it doesn't exist
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => ''),
      readFileByPath: vi.fn(async () => ''),
      requestDirectoryAccess: vi.fn(),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;
    storage = createStorage({ rootsList: JSON.stringify([mockEntry]) });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:restoreRoots')?.({} as IpcMainInvokeEvent);

    expect(result).toEqual([
      {
        displayName: 'directory',
        handle: {
          kind: 'directory',
          name: 'directory',
          path: '/mock/test/directory',
          platform: 'electron',
        },
        kind: 'path',
        permissionState: 'granted',
        persisted: true,
        rootId: 'mock-root-id',
      },
    ]);
    // Mock paths never reach the real adapter's exists().
    expect(fileSystem.exists).not.toHaveBeenCalled();
    // Nothing was pruned, so the list is not rewritten.
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.anything());
  });
});

describe('fs:addRoot', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
    // Vitest sets NODE_ENV='test', which trips the handler's e2e test-mode
    // short-circuit. The real-flow tests below stub 'production' to exercise
    // the dialog branch; test-mode tests re-stub 'test' explicitly.
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
  });

  it('opens the directory dialog, generates a rootId, appends to rootsList, returns the descriptor', async () => {
    const pickedPath = path.resolve('/users/test/new-project');
    fileSystem = createFileSystem(pickedPath);
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    expect(result).toMatchObject({
      displayName: 'new-project',
      handle: {
        kind: 'directory',
        name: 'new-project',
        path: pickedPath,
        platform: 'electron',
      },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
    });

    const descriptor = result as {
      rootId: string;
      persisted: boolean;
    };
    expect(descriptor.rootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // rootsList should have been written
    expect(storage.setItem).toHaveBeenCalledWith('rootsList', expect.stringContaining(pickedPath));
    // lastFolderPath shim parity
    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', pickedPath);
  });

  it('re-uses the existing rootId when the picked path is already in rootsList', async () => {
    const existingPath = path.resolve('/users/test/existing-project');
    const existingRootId = 'existing-root-id-abc123';
    const existingEntry = { addedAt: 1000, path: existingPath, rootId: existingRootId };
    storage = createStorage({ rootsList: JSON.stringify([existingEntry]) });
    fileSystem = createFileSystem(existingPath);
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    const descriptor = result as { rootId: string };
    expect(descriptor.rootId).toBe(existingRootId);

    // Verify only one entry in rootsList (no duplicate)
    const setItemCalls = vi
      .mocked(storage.setItem)
      .mock.calls.filter(([key]) => key === 'rootsList');
    expect(setItemCalls.length).toBeGreaterThan(0);
    const lastRootsList = JSON.parse(setItemCalls.at(-1)?.[1] ?? '[]') as Array<{
      rootId: string;
    }>;
    expect(lastRootsList.filter((e) => e.rootId === existingRootId)).toHaveLength(1);
  });

  it('keeps persisted: true when only the addedAt bump fails for an EXISTING entry', async () => {
    // The root is already durably stored; a failed addedAt bump must not
    // downgrade the persisted contract (callers would skip DB registration
    // for a perfectly durable root).
    const pickedPath = path.resolve('/users/test/already-stored');
    const existingRootId = 'existing-root-id-123';
    fileSystem = createFileSystem(pickedPath);
    storage = createStorage();
    vi.mocked(storage.getItem).mockImplementation(async (key: string) =>
      key === 'rootsList'
        ? JSON.stringify([{ addedAt: 1, path: pickedPath, rootId: existingRootId }])
        : null
    );
    vi.mocked(storage.setItem).mockImplementation(async (key: string) => {
      if (key === 'rootsList') {
        throw new Error('disk full');
      }
    });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    expect(result).toMatchObject({
      persisted: true,
      rootId: existingRootId,
    });
  });

  it('returns persisted: false and warns (without throwing) when the rootsList write fails', async () => {
    const pickedPath = path.resolve('/users/test/unpersisted-project');
    fileSystem = createFileSystem(pickedPath);
    storage = createStorage();
    vi.mocked(storage.setItem).mockImplementation(async (key: string) => {
      if (key === 'rootsList') {
        throw new Error('disk full');
      }
    });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    setLogLevel(LogLevel.WARN);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileSystemIpc') {
        captured.push(record);
      }
    });

    let result: unknown;
    try {
      result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);
    } finally {
      removeListener();
    }

    expect(result).toMatchObject({
      displayName: 'unpersisted-project',
      kind: 'path',
      permissionState: 'granted',
      persisted: false,
    });
    // lastFolderPath shim write still happens despite the rootsList failure
    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', pickedPath);
    expect(
      captured.some(
        (record) =>
          record.level === LogLevel.WARN && record.message === 'addRoot: failed to write rootsList'
      )
    ).toBe(true);
  });

  // Regression: phase-5 routed the FIRST pick through fs:addRoot, which called
  // the real adapter directly — in e2e the real requestDirectoryAccess stats
  // the mock path and throws ENOENT, breaking every desktop smoke spec that
  // selects a root. fs:addRoot must follow the same test-mode contract as
  // fs:requestDirectoryAccess.
  it('test mode: returns the E2E fixture handle without calling the real adapter', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const rootHandle = {
      id: 'fixture-root',
      kind: 'directory',
      name: 'fixture',
      path: '/fixture',
      type: 'directory',
    } as DirectoryHandle & { id: string; type: 'directory' };
    const fixture = {
      directoriesByPath: { '/fixture': [] },
      fileContentsByPath: {},
      readDirectoryCalls: [],
      readFileByPathCalls: [],
      readFileCalls: [],
      requestDirectoryAccessCount: 0,
      rootHandle,
    };
    (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY] =
      fixture;

    fileSystem = createFileSystem();
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    expect(result).toMatchObject({
      displayName: 'fixture',
      handle: { path: '/fixture' },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
    });
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fixture.requestDirectoryAccessCount).toBe(1);
    // The fixture root still gets a rootsList entry (rootId reuse on re-pick).
    expect(storage.setItem).toHaveBeenCalledWith('rootsList', expect.stringContaining('/fixture'));
  });

  it('test mode: uses the opt-in real root path and persists it through rootsList', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const realRootPath = path.resolve('/users/test/real-e2e-root');
    vi.stubEnv('BRAINSTRIKE_E2E_REAL_ROOT_PATH', realRootPath);
    fileSystem = createFileSystem('/unused-picker');
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, storage });

    const result = await handlers.get('fs:addRoot')?.({} as IpcMainInvokeEvent);

    expect(result).toMatchObject({
      displayName: 'real-e2e-root',
      handle: {
        kind: 'directory',
        name: 'real-e2e-root',
        path: realRootPath,
        platform: 'electron',
      },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
    });
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fileSystem.exists).toHaveBeenCalledWith(realRootPath);
    expect(storage.setItem).toHaveBeenCalledWith(
      'rootsList',
      expect.stringContaining(realRootPath)
    );
  });
});

describe('fs:saveLastFolder (legacy shim)', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
  });

  it('still writes lastFolderPath AND upserts the path into rootsList', async () => {
    const folderPath = '/users/test/my-project';
    const resolvedPath = path.resolve(folderPath);
    fileSystem = createFileSystem();
    storage = createStorage();
    registerFileSystemIpcHandlers({ fileSystem, storage });

    await handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, folderPath);

    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', resolvedPath);
    expect(storage.setItem).toHaveBeenCalledWith(
      'rootsList',
      expect.stringContaining(resolvedPath)
    );
  });

  it('still writes lastFolderPath and warns (without throwing) when the rootsList upsert fails', async () => {
    const folderPath = '/users/test/my-project';
    const resolvedPath = path.resolve(folderPath);
    fileSystem = createFileSystem();
    storage = createStorage();
    vi.mocked(storage.setItem).mockImplementation(async (key: string) => {
      if (key === 'rootsList') {
        throw new Error('disk full');
      }
    });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    setLogLevel(LogLevel.WARN);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileSystemIpc') {
        captured.push(record);
      }
    });

    try {
      await expect(
        handlers.get('fs:saveLastFolder')?.({} as IpcMainInvokeEvent, folderPath)
      ).resolves.toBeUndefined();
    } finally {
      removeListener();
    }

    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', resolvedPath);
    expect(
      captured.some(
        (record) =>
          record.level === LogLevel.WARN &&
          record.message === 'saveLastFolder: failed to upsert rootsList'
      )
    ).toBe(true);
  });
});

describe('fs:removeRoot', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  const pathA = path.resolve('/users/test/project-a');
  const pathB = path.resolve('/users/test/project-b');
  const entryA = { addedAt: 1000, path: pathA, rootId: 'root-id-a' };
  const entryB = { addedAt: 2000, path: pathB, rootId: 'root-id-b' };

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    fileSystem = createFileSystem();
  });

  it('removes the matching rootsList entry and leaves the others intact', async () => {
    storage = createStorage({ rootsList: JSON.stringify([entryA, entryB]) });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    await handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, 'root-id-a');

    expect(storage.setItem).toHaveBeenCalledWith('rootsList', JSON.stringify([entryB]));
    // Disconnect ≠ delete: nothing DB-related is touched by this handler;
    // the file system adapter is never consulted either.
    expect(fileSystem.exists).not.toHaveBeenCalled();
  });

  it('clears lastFolderPath when it equals the removed root path', async () => {
    storage = createStorage({
      lastFolderPath: pathA,
      rootsList: JSON.stringify([entryA, entryB]),
    });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    await handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, 'root-id-a');

    expect(storage.removeItem).toHaveBeenCalledWith('lastFolderPath');
  });

  it('leaves lastFolderPath untouched when it points at a different root', async () => {
    storage = createStorage({
      lastFolderPath: pathB,
      rootsList: JSON.stringify([entryA, entryB]),
    });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    await handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, 'root-id-a');

    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(await storage.getItem('lastFolderPath')).toBe(pathB);
  });

  it('is a no-op (no write) when the rootId is not in rootsList', async () => {
    storage = createStorage({ rootsList: JSON.stringify([entryA]) });
    registerFileSystemIpcHandlers({ fileSystem, storage });

    await handlers.get('fs:removeRoot')?.({} as IpcMainInvokeEvent, 'unknown-root-id');

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
