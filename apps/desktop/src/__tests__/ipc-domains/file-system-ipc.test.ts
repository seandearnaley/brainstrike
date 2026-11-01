import path from 'node:path';
import {
  DialogError,
  type DirectoryHandle,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untrackAppWindow } from '../../app-windows';
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
  getRootsCatalog,
  inMemoryRootSeams,
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
    fileSystem = createFileSystem(WORKSPACE);
    storage = createStorage();
  });

  afterEach(async () => {
    await Promise.all(registered.splice(0).map((close) => close()));
    untrackAppWindow(visibleSenderId);
    vi.unstubAllEnvs();
  });

  function registerWith(
    options: Partial<Parameters<typeof registerFileSystemIpcHandlers>[0]>
  ): void {
    registered.push(
      registerFileSystemIpcHandlers({
        fileSystem,
        getRootsCatalog,
        storage,
        workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
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
      onDeleteRootData,
      storage,
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
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
      storage,
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
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

  it('rejects untracked senders on every files method', async () => {
    register();
    const methods = Object.values(fileSystemContract)
      .filter((spec) => spec.kind === 'invoke')
      .map((spec) => spec.channel);
    expect(methods).toEqual(
      expect.arrayContaining([
        'fs:addRoot',
        'fs:addRootByPath',
        'fs:listRecentRoots',
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
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
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
      storage,
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
    });
    await expect(capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent())).resolves.toEqual(
      []
    );

    await close();

    await expect(capabilityHandler('fs:restoreRoots')(createTrustedInvokeEvent())).rejects.toThrow(
      'No desktop IPC handler for fs:restoreRoots.'
    );
    await expect(
      capabilityHandler('fs:listRecentRoots')(createTrustedInvokeEvent())
    ).rejects.toThrow('No desktop IPC handler for fs:listRecentRoots.');
  });
});
