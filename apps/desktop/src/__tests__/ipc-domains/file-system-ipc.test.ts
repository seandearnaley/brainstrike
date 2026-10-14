import path from 'node:path';
import {
  AccessError,
  DialogError,
  type DirectoryHandle,
  type FileHandle,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RootDescriptor } from '@brainstrike/types';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
} from '../helpers/desktop-ipc-sender-test-helpers';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

import {
  createFileSystemIpcDomain,
  registerFileSystemIpcHandlers,
} from '../../ipc-domains/file-system-ipc';
import { assignWindowRole, clearWindowRoleByWebContentsId } from '../../window-role';
import {
  capabilityHandler,
  createFileSystem,
  createStorage,
  E2E_FILE_SYSTEM_FIXTURE_KEY,
  getRootsCatalog,
  handlers,
  removeHandler,
  resetRootsCatalog,
  rootsCatalogRequest,
} from './file-system-ipc-test-harness';

describe('file system IPC domain', () => {
  const visibleSenderId = 11_591;
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    resetRootsCatalog();
    handlers.clear();
    removeHandler.mockClear();
    rootsCatalogRequest.mockClear();
    getRootsCatalog.mockClear();
    vi.stubEnv('NODE_ENV', 'production');
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
    fileSystem = createFileSystem('/users/test/workspace');
    storage = createStorage();
  });

  afterEach(() => {
    clearWindowRoleByWebContentsId(visibleSenderId);
    vi.unstubAllEnvs();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
  });

  function register(): () => void {
    return registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      storage,
    });
  }

  it.each([
    [new UserCancelledError(), 'workspace.selection-cancelled', 'refusal'],
    [new PermissionError('private OS details'), 'workspace.permission-denied', 'refusal'],
    [new DialogError('private native stack'), 'workspace.picker-unavailable', 'fault'],
  ])('keeps picker outcome %s distinct on the wire', async (cause, code, kind) => {
    vi.mocked(fileSystem.requestDirectoryAccess).mockRejectedValueOnce(cause);
    register();
    const result = await handlers.get('fs:requestDirectoryAccess')?.(createTrustedInvokeEvent());
    expect(result).toMatchObject({ error: { code, kind, remedy: expect.any(String) }, ok: false });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('transports actionable grant refusals as plain data without Error internals', async () => {
    register();
    const result = await handlers.get('fs:addRootByPath')?.(
      createTrustedInvokeEvent(),
      '/users/test/ungranted'
    );
    expect(result).toMatchObject({
      error: {
        category: 'authorization',
        code: 'workspace.never-granted',
        kind: 'refusal',
        remedy: expect.any(String),
      },
      ok: false,
    });
    const transported = structuredClone(result);
    if (!(transported && typeof transported === 'object' && 'error' in transported)) {
      throw new Error('Expected a failure envelope');
    }
    expect(transported).toEqual(result);
    expect(transported.error).not.toBeInstanceOf(Error);
    expect(transported.error).not.toHaveProperty('cause');
    expect(transported.error).not.toHaveProperty('stack');
  });

  it('awaits the actual main deletion callback and propagates its cleanup failure', async () => {
    const held = Promise.withResolvers<void>();
    const onDeleteRootData = vi.fn(() => held.promise);
    const domain = createFileSystemIpcDomain({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      onDeleteRootData,
      storage,
    });
    const deletion = capabilityHandler('fs:deleteRootData')?.(
      createTrustedInvokeEvent(),
      'actual-root'
    );
    expect(onDeleteRootData).toHaveBeenCalledWith('actual-root');
    held.resolve();
    await deletion;
    onDeleteRootData.mockRejectedValueOnce(new Error('Native owner cleanup failed'));
    await expect(
      capabilityHandler('fs:deleteRootData')?.(createTrustedInvokeEvent(), 'actual-root')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
    await domain.close();
  });

  it('refuses deletion when its main owner has not been composed', async () => {
    register();
    await expect(
      capabilityHandler('fs:deleteRootData')?.(createTrustedInvokeEvent(), 'root')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
  });

  it('joins mounted-root disposal even when handler removal throws', async () => {
    const domain = createFileSystemIpcDomain({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      storage,
    });
    const dispose = vi.spyOn(domain.roots, 'dispose').mockResolvedValue(undefined);
    const failure = new Error('Filesystem handler removal failed.');
    removeHandler.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(domain.close()).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
      name: 'AggregateError',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('selects, mounts, persists, and stamps a root through the legacy picker channel', async () => {
    register();

    const handle = (await capabilityHandler('fs:requestDirectoryAccess')?.(
      createTrustedInvokeEvent()
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

  it('installs the managed-worktree authorizer for addRootByPath', async () => {
    const managedWorktreeAuthorizer = vi.fn(async () => 'authorized' as const);
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      managedWorktreeAuthorizer,
      storage,
    });

    await capabilityHandler('fs:addRootByPath')?.(
      createTrustedInvokeEvent(),
      '/managed/app/bright-fox'
    );

    expect(managedWorktreeAuthorizer).toHaveBeenCalledWith('/managed/app/bright-fox');
  });

  it('honors only the explicit synthetic-filesystem registration seam', async () => {
    vi.stubEnv('VITEST', 'true');
    fileSystem = createFileSystem('/mock/denied-by-explicit-seam');
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => false,
      storage,
    });

    await expect(capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.any(String));
  });

  it('freezes synthetic-filesystem classification for the mounted root', async () => {
    vi.stubEnv('VITEST', 'true');
    let classificationCalls = 0;
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => {
        classificationCalls += 1;
        return classificationCalls === 1;
      },
      storage,
    });

    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), {
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
      getRootsCatalog,
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

    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), {
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
      getRootsCatalog,
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

    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
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
      capabilityHandler('fs:readDirectory')?.(createTrustedInvokeEvent(), descriptor.handle)
    ).resolves.toMatchObject([{ name: 'native.txt' }]);
    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), fileHandle)
    ).resolves.toBe('native content');
    await expect(
      capabilityHandler('fs:readFileByPath')?.(createTrustedInvokeEvent(), fileHandle.path)
    ).resolves.toBe('native content');
    expect(nativeListDir).toHaveBeenCalledOnce();
    expect(nativeReadFile).toHaveBeenCalledTimes(2);
  });

  it('closes a native capability when canonical classification conflicts', async () => {
    fileSystem = createFileSystem('/mock/test/directory');
    const closeNativeRoot = vi.fn();
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
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

    const syntheticDescriptor = (await capabilityHandler('fs:addRoot')?.(
      createTrustedInvokeEvent()
    )) as {
      handle: DirectoryHandle;
    };
    await capabilityHandler('fs:removeRoot')?.(
      createTrustedInvokeEvent(),
      syntheticDescriptor.handle.rootId
    );
    vi.mocked(fileSystem.requestDirectoryAccess).mockResolvedValueOnce({
      kind: 'directory',
      name: 'workspace',
      path: '/users/test/workspace',
      platform: 'electron',
    });

    await expect(
      capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())
    ).rejects.toMatchObject({ code: 'boundary.internal' });
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

    const selected = (await capabilityHandler('fs:requestDirectoryAccess')?.(
      createTrustedInvokeEvent()
    )) as DirectoryHandle;
    expect(selected).toMatchObject({ path: '/fixture', rootId: expect.any(String) });
    await expect(
      capabilityHandler('fs:readDirectory')?.(createTrustedInvokeEvent(), selected)
    ).resolves.toEqual([]);
    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), {
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
      capabilityHandler('fs:readFileByPath')?.(
        createTrustedInvokeEvent(),
        '/users/test/workspace/readme.md'
      )
    ).rejects.toThrow('outside every mounted workspace root');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();

    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFileByPath')?.(
        createTrustedInvokeEvent(),
        '/users/test/outside.txt'
      )
    ).rejects.toThrow('outside every mounted workspace root');
    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), {
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

    const rootA = (await capabilityHandler('fs:addRoot')?.(
      createTrustedInvokeEvent()
    )) as RootDescriptor;
    const rootB = (await capabilityHandler('fs:addRoot')?.(
      createTrustedInvokeEvent()
    )) as RootDescriptor;
    assignWindowRole(
      {
        once: vi.fn(),
        webContents: { id: visibleSenderId },
      } as unknown as BrowserWindow,
      'visible-ui'
    );
    const visibleEvent = {
      sender: { id: visibleSenderId },
      senderFrame: createAllowlistedSenderFrame(),
    } as unknown as IpcMainInvokeEvent;

    const readScoped = capabilityHandler('fs:readFileByAbsolutePath');
    expect(readScoped).toBeDefined();
    await expect(
      readScoped?.(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, rootB.rootId)
    ).resolves.toBe('file content');
    await expect(
      readScoped?.(visibleEvent, path.join(rootBPath, 'readme.md'), rootAPath, rootA.rootId)
    ).rejects.toThrow('outside the selected workspace root');
    await expect(
      readScoped?.(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, rootA.rootId)
    ).rejects.toMatchObject({ code: 'workspace.root-mismatch' });
    await expect(
      readScoped?.(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, undefined)
    ).rejects.toMatchObject({ code: 'workspace.root-id-invalid' });
    await expect(
      readScoped?.(
        {
          sender: { id: visibleSenderId + 1 },
          senderFrame: createAllowlistedSenderFrame(),
        } as unknown as IpcMainInvokeEvent,
        path.join(rootBPath, 'readme.md'),
        rootBPath,
        rootB.rootId
      )
    ).rejects.toThrow('requires sender role visible-ui');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  // BST-1641: the whole `files` domain (reads, root grants, mutations) is
  // visible-UI-only; nothing in `dist/hidden-preload.js` exposes an `fs:*`
  // channel. Iterating the registered map pins that a channel added later
  // with the unauthenticated verb fails here rather than slipping through.
  it('rejects hidden-host and untracked senders on every registered files channel', async () => {
    register();
    const channels = [...handlers.keys()];
    expect(channels).toEqual(
      expect.arrayContaining([
        'fs:addRoot',
        'fs:addRootByPath',
        'fs:readFileByPath',
        'fs:requestDirectoryAccess',
        'fs:deleteRootData',
        'fs:removeRoot',
      ])
    );
    for (const channel of channels) {
      const rejection = `Desktop IPC ${channel} requires sender role visible-ui.`;
      await expect(
        handlers.get(channel)?.(createTrustedInvokeEvent('embedding-host'), '/tmp/x')
      ).rejects.toThrow(rejection);
      await expect(
        handlers.get(channel)?.(
          {
            sender: { id: 555_001 },
            senderFrame: createAllowlistedSenderFrame(),
          } as unknown as IpcMainInvokeEvent,
          '/tmp/x'
        )
      ).rejects.toThrow(rejection);
    }
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('preserves structured oversized and missing-file payloads after authorization', async () => {
    register();
    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
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

    await expect(
      capabilityHandler('fs:readFile')?.(createTrustedInvokeEvent(), file)
    ).resolves.toEqual({
      code: 'TOO_LARGE',
      message: 'File too large: 1.1MB (max: 750KB)',
    });
  });

  it('fails visibly on malformed root persistence and never converges it as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    register();

    await expect(
      capabilityHandler('fs:restoreRoots')?.(createTrustedInvokeEvent())
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
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

    const restored = (await capabilityHandler('fs:restoreRoots')?.(
      createTrustedInvokeEvent()
    )) as Array<{
      permissionState: string;
      rootId: string;
    }>;

    expect(restored).toEqual([
      expect.objectContaining({ permissionState: 'granted', rootId: 'root-available' }),
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-offline' }),
    ]);
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([available, unavailable]));
    expect(rootsCatalogRequest).toHaveBeenCalledWith({
      mountedPaths: ['/users/test/workspace'],
      operation: 'disconnect-except',
    });
  });

  it('treats lastFolderPath only as a preference for an already-mounted persisted root', async () => {
    register();
    await expect(
      capabilityHandler('fs:saveLastFolder')?.(createTrustedInvokeEvent(), '/users/test/workspace')
    ).rejects.toMatchObject({ code: 'boundary.internal' });

    const descriptor = (await capabilityHandler('fs:addRoot')?.(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:saveLastFolder')?.(createTrustedInvokeEvent(), descriptor.handle.path)
    ).resolves.toBeUndefined();
    await expect(
      capabilityHandler('fs:restoreLastFolder')?.(createTrustedInvokeEvent())
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
    await capabilityHandler('fs:restoreRoots')?.(createTrustedInvokeEvent());
    rootsCatalogRequest.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      capabilityHandler('fs:removeRoot')?.(createTrustedInvokeEvent(), 'root-a')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
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
