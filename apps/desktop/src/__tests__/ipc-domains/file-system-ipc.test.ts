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
import { trackAppWindow, untrackAppWindow } from '../../app-windows';
import { fileSystemContract } from '../../ipc-domains/file-system.contract';
import {
  createFileSystemIpcDomain,
  registerFileSystemIpcHandlers,
} from '../../ipc-domains/file-system-ipc';
import {
  createAllowlistedSenderFrame,
  createTrustedInvokeEvent,
} from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  createFileSystem,
  createStorage,
  E2E_FILE_SYSTEM_FIXTURE_KEY,
  getRootsCatalog,
  ipcMethod,
  resetRootsCatalog,
  rootsCatalogRequest,
} from './file-system-ipc-test-harness';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);

const WORKSPACE = path.resolve('/users/test/workspace');
const MANAGED = path.resolve('/managed/app/bright-fox');

describe('file system IPC domain', () => {
  const visibleSenderId = 11_591;
  let fileSystem: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  const registered: Array<() => Promise<void>> = [];

  beforeEach(() => {
    resetRootsCatalog();
    rootsCatalogRequest.mockClear();
    getRootsCatalog.mockClear();
    vi.stubEnv('NODE_ENV', 'production');
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
    fileSystem = createFileSystem(WORKSPACE);
    storage = createStorage();
  });

  afterEach(async () => {
    await Promise.all(registered.splice(0).map((close) => close()));
    untrackAppWindow(visibleSenderId);
    vi.unstubAllEnvs();
    delete (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY];
  });

  function registerWith(
    options: Partial<Parameters<typeof registerFileSystemIpcHandlers>[0]>
  ): void {
    registered.push(
      registerFileSystemIpcHandlers({
        fileSystem,
        getRootsCatalog,
        isSyntheticFileSystemPath: () => true,
        storage,
        ...options,
      })
    );
  }

  function register(): void {
    registerWith({});
  }

  it.each([
    [new UserCancelledError(), 'workspace.selection-cancelled', 'refusal'],
    [new PermissionError('private OS details'), 'workspace.permission-denied', 'refusal'],
    [new DialogError('private native stack'), 'workspace.picker-unavailable', 'fault'],
  ])('keeps picker outcome %s distinct on the wire', async (cause, code, kind) => {
    vi.mocked(fileSystem.requestDirectoryAccess).mockRejectedValueOnce(cause);
    register();
    const result = await ipcMethod('fs:requestDirectoryAccess')(createTrustedInvokeEvent());
    expect(result).toMatchObject({ error: { code, kind, remedy: expect.any(String) }, ok: false });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('transports actionable grant refusals as plain data without Error internals', async () => {
    register();
    const result = await ipcMethod('fs:addRootByPath')(
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
    const deletion = capabilityHandler('fs:deleteRootData')(
      createTrustedInvokeEvent(),
      'actual-root'
    );
    expect(onDeleteRootData).toHaveBeenCalledWith('actual-root');
    held.resolve();
    await deletion;
    onDeleteRootData.mockRejectedValueOnce(new Error('Native owner cleanup failed'));
    await expect(
      capabilityHandler('fs:deleteRootData')(createTrustedInvokeEvent(), 'actual-root')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
    await domain.close();
  });

  it('refuses deletion when its main owner has not been composed', async () => {
    register();
    await expect(
      capabilityHandler('fs:deleteRootData')(createTrustedInvokeEvent(), 'root')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
  });

  it('still unregisters every files method when mounted-root disposal fails', async () => {
    const domain = createFileSystemIpcDomain({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      storage,
    });
    const failure = new Error('Mounted-root disposal failed.');
    vi.spyOn(domain.roots, 'dispose').mockRejectedValue(failure);

    await expect(domain.close()).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
      name: 'AggregateError',
    });
    await expect(ipcMethod('fs:addRoot')(createTrustedInvokeEvent())).rejects.toThrow(
      'No desktop IPC handler for fs:addRoot.'
    );
  });

  it('selects, mounts, persists, and stamps a root through the legacy picker channel', async () => {
    register();

    const handle = (await capabilityHandler('fs:requestDirectoryAccess')(
      createTrustedInvokeEvent()
    )) as DirectoryHandle;

    expect(handle).toMatchObject({
      kind: 'directory',
      path: WORKSPACE,
      platform: 'electron',
    });
    expect(handle.rootId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(storage.setItem).toHaveBeenCalledWith(
      'rootsList',
      expect.stringContaining(handle.rootId ?? '')
    );
    expect(storage.setItem).toHaveBeenCalledWith('lastFolderPath', handle.path);
  });

  it('installs the managed-worktree authorizer for addRootByPath', async () => {
    const managedWorktreeAuthorizer = vi.fn(async () => 'authorized' as const);
    registerWith({
      managedWorktreeAuthorizer,
    });

    await capabilityHandler('fs:addRootByPath')(createTrustedInvokeEvent(), MANAGED);

    expect(managedWorktreeAuthorizer).toHaveBeenCalledWith(MANAGED);
  });

  it('honors only the explicit synthetic-filesystem registration seam', async () => {
    vi.stubEnv('VITEST', 'true');
    fileSystem = createFileSystem('/mock/denied-by-explicit-seam');
    registerWith({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => false,
      storage,
    });

    await expect(capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.any(String));
  });

  it('freezes synthetic-filesystem classification for the mounted root', async () => {
    vi.stubEnv('VITEST', 'true');
    let classificationCalls = 0;
    registerWith({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => {
        classificationCalls += 1;
        return classificationCalls === 1;
      },
      storage,
    });

    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), {
        kind: 'file',
        name: 'readme.md',
        path: '/users/test/workspace/readme.md',
        platform: 'electron',
        ...(descriptor.handle.rootId === undefined ? {} : { rootId: descriptor.handle.rootId }),
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
    const mockParent = path.resolve('/mock');
    const canonicalRoot = path.join(mockParent, 'canonical-native-root');
    registerWith({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: (rootPath) => rootPath.startsWith(`${mockParent}${path.sep}`),
      storage,
      workspaceRootRegistryFileSystemSeams: {
        createSecureRoot: async () => ({
          canonicalPath: canonicalRoot,
          close: () => undefined,
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: nativeReadFile,
        }),
        resolveReadPath: resolveNativeReadPath,
      },
    });

    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), {
        kind: 'file',
        name: 'readme.md',
        path: path.join(WORKSPACE, 'readme.md'),
        platform: 'electron',
        ...(descriptor.handle.rootId === undefined ? {} : { rootId: descriptor.handle.rootId }),
      } satisfies FileHandle)
    ).resolves.toBe('native content');
    expect(resolveNativeReadPath).toHaveBeenCalledWith(
      path.join(WORKSPACE, 'readme.md'),
      canonicalRoot
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
    registerWith({
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

    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    const fileHandle = {
      kind: 'file',
      name: 'native.txt',
      path: '/mock/native-root/native.txt',
      platform: 'electron',
      ...(descriptor.handle.rootId === undefined ? {} : { rootId: descriptor.handle.rootId }),
    } satisfies FileHandle;

    await expect(
      capabilityHandler('fs:readDirectory')(createTrustedInvokeEvent(), descriptor.handle)
    ).resolves.toMatchObject([{ name: 'native.txt' }]);
    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), fileHandle)
    ).resolves.toBe('native content');
    await expect(
      capabilityHandler('fs:readFileByPath')(createTrustedInvokeEvent(), fileHandle.path)
    ).resolves.toBe('native content');
    expect(nativeListDir).toHaveBeenCalledOnce();
    expect(nativeReadFile).toHaveBeenCalledTimes(2);
  });

  it('closes a native capability when canonical classification conflicts', async () => {
    // Test mode's default mock root, in the host's own grammar.
    const mockRoot = path.resolve('/mock/test/directory');
    fileSystem = createFileSystem(mockRoot);
    const closeNativeRoot = vi.fn();
    registerWith({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: (rootPath) => rootPath === mockRoot,
      storage,
      workspaceRootRegistryFileSystemSeams: {
        createSecureRoot: async () => ({
          canonicalPath: mockRoot,
          close: closeNativeRoot,
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: async () => ({ content: Buffer.alloc(0), status: 'ok' }),
        }),
        resolveReadPath: async (requestedPath) => requestedPath,
      },
    });

    const syntheticDescriptor = (await capabilityHandler('fs:addRoot')(
      createTrustedInvokeEvent()
    )) as {
      handle: DirectoryHandle;
    };
    await capabilityHandler('fs:removeRoot')(
      createTrustedInvokeEvent(),
      syntheticDescriptor.handle.rootId
    );
    vi.mocked(fileSystem.requestDirectoryAccess).mockResolvedValueOnce({
      kind: 'directory',
      name: 'workspace',
      path: WORKSPACE,
      platform: 'electron',
    });

    await expect(capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())).rejects.toMatchObject(
      { code: 'boundary.internal' }
    );
    expect(closeNativeRoot).toHaveBeenCalledOnce();
  });

  it('keeps fixture I/O isolated from the real adapter while still stamping authority', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const fixturePath = path.resolve('/fixture');
    const fixtureFile = path.join(fixturePath, 'readme.md');
    const fixtureRoot = {
      id: 'fixture-root',
      kind: 'directory',
      name: 'fixture',
      path: fixturePath,
      type: 'directory',
    } as DirectoryHandle & { id: string; type: 'directory' };
    const fixture = {
      directoriesByPath: { [fixturePath]: [] },
      fileContentsByPath: { [fixtureFile]: 'fixture content' },
      readDirectoryCalls: [] as string[],
      readFileByPathCalls: [] as string[],
      readFileCalls: [] as string[],
      requestDirectoryAccessCount: 0,
      rootHandle: fixtureRoot,
    };
    (globalThis as { [E2E_FILE_SYSTEM_FIXTURE_KEY]?: unknown })[E2E_FILE_SYSTEM_FIXTURE_KEY] =
      fixture;
    register();

    const selected = (await capabilityHandler('fs:requestDirectoryAccess')(
      createTrustedInvokeEvent()
    )) as DirectoryHandle;
    expect(selected).toMatchObject({ path: fixturePath, rootId: expect.any(String) });
    await expect(
      capabilityHandler('fs:readDirectory')(createTrustedInvokeEvent(), selected)
    ).resolves.toEqual([]);
    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), {
        kind: 'file',
        name: 'readme.md',
        path: fixtureFile,
        platform: 'electron',
        ...(selected.rootId === undefined ? {} : { rootId: selected.rootId }),
      } satisfies FileHandle)
    ).resolves.toBe('fixture content');
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fileSystem.readDirectory).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('rejects rootless and out-of-root reads instead of falling back to raw adapter paths', async () => {
    register();
    await expect(
      capabilityHandler('fs:readFileByPath')(
        createTrustedInvokeEvent(),
        '/users/test/workspace/readme.md'
      )
    ).rejects.toThrow('outside every mounted workspace root');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();

    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:readFileByPath')(createTrustedInvokeEvent(), '/users/test/outside.txt')
    ).rejects.toThrow('outside every mounted workspace root');
    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), {
        kind: 'file',
        name: 'escape.txt',
        path: '/users/test/outside.txt',
        platform: 'electron',
        ...(descriptor.handle.rootId === undefined ? {} : { rootId: descriptor.handle.rootId }),
      } satisfies FileHandle)
    ).rejects.toThrow('outside the selected workspace root');
  });

  it('enforces the exact claimed mounted root for scoped absolute reads', async () => {
    register();
    const rootAPath = path.resolve('/users/test/workspace-a');
    const rootBPath = path.resolve('/users/test/workspace-b');
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

    const rootA = (await capabilityHandler('fs:addRoot')(
      createTrustedInvokeEvent()
    )) as RootDescriptor;
    const rootB = (await capabilityHandler('fs:addRoot')(
      createTrustedInvokeEvent()
    )) as RootDescriptor;
    trackAppWindow({
      once: vi.fn(),
      webContents: { id: visibleSenderId },
    } as unknown as BrowserWindow);
    const visibleEvent = {
      sender: { id: visibleSenderId },
      senderFrame: createAllowlistedSenderFrame(),
    } as unknown as IpcMainInvokeEvent;

    const readScoped = capabilityHandler('fs:readFileByAbsolutePath');
    await expect(
      readScoped(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, rootB.rootId)
    ).resolves.toBe('file content');
    await expect(
      readScoped(visibleEvent, path.join(rootBPath, 'readme.md'), rootAPath, rootA.rootId)
    ).rejects.toThrow('outside the selected workspace root');
    await expect(
      readScoped(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, rootA.rootId)
    ).rejects.toMatchObject({ code: 'workspace.root-mismatch' });
    await expect(
      readScoped(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, '')
    ).rejects.toMatchObject({ code: 'workspace.root-id-invalid' });
    await expect(
      readScoped(visibleEvent, path.join(rootBPath, 'readme.md'), rootBPath, undefined)
    ).rejects.toThrow('invalid arguments');
    await expect(
      readScoped(
        {
          sender: { id: visibleSenderId + 1 },
          senderFrame: createAllowlistedSenderFrame(),
        } as unknown as IpcMainInvokeEvent,
        path.join(rootBPath, 'readme.md'),
        rootBPath,
        rootB.rootId
      )
    ).rejects.toThrow('Desktop IPC fs:readFileByAbsolutePath requires an app window sender.');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  // BST-1641: every `files` method (reads, root grants, mutations) answers
  // only an app window, so an untracked sender is refused before any handler.
  it('rejects untracked senders on every files method', async () => {
    register();
    const methods = Object.values(fileSystemContract)
      .filter((spec) => spec.kind === 'invoke')
      .map((spec) => spec.channel);
    expect(methods).toEqual(
      expect.arrayContaining([
        'fs:addRoot',
        'fs:addRootByPath',
        'fs:readFileByPath',
        'fs:requestDirectoryAccess',
        'fs:deleteRootData',
        'fs:removeRoot',
      ])
    );
    for (const method of methods) {
      await expect(
        ipcMethod(method)(
          {
            sender: { id: 555_001 },
            senderFrame: createAllowlistedSenderFrame(),
          } as unknown as IpcMainInvokeEvent,
          '/tmp/x'
        )
      ).rejects.toThrow(`Desktop IPC ${method} requires an app window sender.`);
    }
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
  });

  it('preserves structured oversized and missing-file payloads after authorization', async () => {
    register();
    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    const file = {
      kind: 'file',
      name: 'large.txt',
      path: '/users/test/workspace/large.txt',
      platform: 'electron',
      ...(descriptor.handle.rootId === undefined ? {} : { rootId: descriptor.handle.rootId }),
    } satisfies FileHandle;
    vi.mocked(fileSystem.readFile).mockRejectedValueOnce(
      new AccessError('File too large: 1.1MB (max: 750KB)', file.path, 'read')
    );

    await expect(
      capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), file)
    ).resolves.toEqual({
      code: 'TOO_LARGE',
      message: 'File too large: 1.1MB (max: 750KB)',
    });
  });

  it('fails visibly on malformed root persistence and never converges it as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    register();

    await expect(
      capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent())
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(rootsCatalogRequest).not.toHaveBeenCalled();
  });

  it('retains unavailable persisted roots for retry and excludes them from DB authorization', async () => {
    const available = {
      addedAt: 1,
      path: WORKSPACE,
      rootId: 'root-available',
    };
    const unavailable = {
      addedAt: 2,
      path: path.resolve('/users/test/offline'),
      rootId: 'root-offline',
    };
    storage = createStorage({ rootsList: JSON.stringify([available, unavailable]) });
    vi.mocked(fileSystem.exists).mockImplementation(async (candidate) => candidate === WORKSPACE);
    register();

    const restored = (await capabilityHandler('fs:restoreRoots')(
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
      mountedPaths: [WORKSPACE],
      operation: 'disconnect-except',
    });
  });

  it('treats lastFolderPath only as a preference for an already-mounted persisted root', async () => {
    register();
    await expect(
      capabilityHandler('fs:saveLastFolder')(createTrustedInvokeEvent(), '/users/test/workspace')
    ).rejects.toMatchObject({ code: 'boundary.internal' });

    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };
    await expect(
      capabilityHandler('fs:saveLastFolder')(createTrustedInvokeEvent(), descriptor.handle.path)
    ).resolves.toBeUndefined();
    await expect(
      capabilityHandler('fs:restoreLastFolder')(createTrustedInvokeEvent())
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
    await capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent());
    rootsCatalogRequest.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      capabilityHandler('fs:removeRoot')(createTrustedInvokeEvent(), 'root-a')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  });

  it('asks Main to re-read the folders once a removal retires a mounted folder', async () => {
    const rootsChanged = vi.fn();
    registerWith({
      onWorkspaceRootsChanged: rootsChanged,
    });
    const descriptor = (await capabilityHandler('fs:addRoot')(createTrustedInvokeEvent())) as {
      handle: DirectoryHandle;
    };

    await capabilityHandler('fs:removeRoot')(createTrustedInvokeEvent(), descriptor.handle.rootId);
    expect(rootsChanged).toHaveBeenCalledOnce();
    // Removing it again (as the renderer does after deleting a folder's data) changes nothing.
    await capabilityHandler('fs:removeRoot')(createTrustedInvokeEvent(), descriptor.handle.rootId);
    expect(rootsChanged).toHaveBeenCalledOnce();
  });

  it('asks Main to re-read the folders when a removal fails after retiring the mount', async () => {
    const entry = { addedAt: 1, path: '/users/test/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const rootsChanged = vi.fn();
    registerWith({
      onWorkspaceRootsChanged: rootsChanged,
    });
    await capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent());
    rootsCatalogRequest.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      capabilityHandler('fs:removeRoot')(createTrustedInvokeEvent(), 'root-a')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
    // The folder stays connected, but its borrowed mount was already retired.
    expect(rootsChanged).toHaveBeenCalledOnce();
  });

  it('unregisters every files method when the domain closes', async () => {
    const close = registerFileSystemIpcHandlers({
      fileSystem,
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      storage,
    });
    await expect(capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent())).resolves.toEqual(
      []
    );

    await close();

    await expect(capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent())).rejects.toThrow(
      'No desktop IPC handler for fs:restoreRoots.'
    );
    await expect(capabilityHandler('fs:readFile')(createTrustedInvokeEvent())).rejects.toThrow(
      'No desktop IPC handler for fs:readFile.'
    );
  });
});
