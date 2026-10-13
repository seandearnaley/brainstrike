import path from 'node:path';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWorktreeAuthorizer } from '../../ipc-domains/workspace-recent-roots';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
  },
}));

// Main records each folder it mounts (BST-1990); a double stands in for its database.
vi.mock('../../db-main', async () => {
  const { createRootsDatabaseDouble } = await import('./roots-database-double');
  const database = createRootsDatabaseDouble();
  return { getDatabase: async () => database };
});

import { registerIpcHandlers } from '../../ipc-handlers';

describe('ipc-handlers filesystem composition', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let managedWorktreeAuthorizer: ReturnType<typeof vi.fn<ManagedWorktreeAuthorizer>>;
  let storage: ElectronStorageAdapter;
  let storedValues: Map<string, string>;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ELECTRON_IS_E2E_TEST', '');
    storedValues = new Map();
    fileSystem = {
      exists: vi.fn(async () => true),
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => 'file content'),
      readFileByPath: vi.fn(async () => 'unsafe raw content'),
      requestDirectoryAccess: vi.fn(async () => ({
        kind: 'directory',
        name: 'docs',
        path: '/users/test/docs',
        platform: 'electron',
      })),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;
    storage = {
      clear: vi.fn(async () => storedValues.clear()),
      getAllKeys: vi.fn(async () => [...storedValues.keys()]),
      getItem: vi.fn(async (key: string) => storedValues.get(key) ?? null),
      removeItem: vi.fn(async (key: string) => storedValues.delete(key)),
      setItem: vi.fn(async (key: string, value: string) => {
        storedValues.set(key, value);
      }),
    } as unknown as ElectronStorageAdapter;
    managedWorktreeAuthorizer = vi.fn<ManagedWorktreeAuthorizer>(async () => 'unmanaged');
    registerIpcHandlers(fileSystem, storage, () => null, {
      isSyntheticFileSystemPath: () => true,
      managedWorktreeAuthorizer,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function mountRoot(): Promise<DirectoryHandle> {
    return (await handlers.get('fs:requestDirectoryAccess')?.(
      createTrustedInvokeEvent()
    )) as DirectoryHandle;
  }

  it('registers and mounts a selected real root before returning its handle', async () => {
    const handle = await mountRoot();

    expect(fileSystem.requestDirectoryAccess).toHaveBeenCalledOnce();
    expect(handle).toMatchObject({
      path: path.resolve('/users/test/docs'),
      rootId: expect.any(String),
    });
    expect(storedValues.get('rootsList')).toContain(handle.rootId);
  });

  it('keeps the E2E mock path isolated from the real adapter', async () => {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');

    const handle = await mountRoot();
    const entries = await handlers.get('fs:readDirectory')?.(createTrustedInvokeEvent(), handle);
    const content = await handlers.get('fs:readFile')?.(createTrustedInvokeEvent(), {
      kind: 'file',
      name: 'file.txt',
      path: '/mock/test/directory/file.txt',
      platform: 'electron',
      rootId: handle.rootId,
    } satisfies FileHandle);

    expect(handle).toMatchObject({
      path: '/mock/test/directory',
      rootId: expect.any(String),
    });
    expect(entries).toHaveLength(3);
    expect(String(content)).toContain('Mock file content for testing');
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();
    expect(fileSystem.readDirectory).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('routes mounted reads through the registry and never through raw readFileByPath', async () => {
    const root = await mountRoot();
    const file = {
      kind: 'file',
      name: 'file.txt',
      path: '/users/test/docs/file.txt',
      platform: 'electron',
      rootId: root.rootId,
    } satisfies FileHandle;

    await expect(
      handlers.get('fs:readDirectory')?.(createTrustedInvokeEvent(), root)
    ).resolves.toEqual([]);
    await expect(handlers.get('fs:readFile')?.(createTrustedInvokeEvent(), file)).resolves.toBe(
      'file content'
    );
    await expect(
      handlers.get('fs:readFileByPath')?.(createTrustedInvokeEvent(), file.path)
    ).resolves.toBe('file content');
    expect(fileSystem.readDirectory).toHaveBeenCalledOnce();
    expect(fileSystem.readFile).toHaveBeenCalledTimes(2);
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('rejects unmounted, escaped, and malformed paths', async () => {
    const readByPath = handlers.get('fs:readFileByPath');
    await expect(
      readByPath?.(createTrustedInvokeEvent(), '/users/test/docs/file.txt')
    ).rejects.toThrow('outside every mounted workspace root');

    await mountRoot();
    await expect(
      readByPath?.(createTrustedInvokeEvent(), '/users/test/outside.txt')
    ).rejects.toThrow('outside every mounted workspace root');
    await expect(
      readByPath?.(createTrustedInvokeEvent(), '/users/test/docs/\0malicious.txt')
    ).rejects.toThrow('null bytes');
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('retains the existing guarded existence endpoint', async () => {
    await expect(
      handlers.get('fs:exists')?.(createTrustedInvokeEvent(), '/tmp/\0oops')
    ).resolves.toBe(false);
    await expect(
      handlers.get('fs:exists')?.(createTrustedInvokeEvent(), '/users/test/docs')
    ).resolves.toBe(true);
    expect(fileSystem.exists).toHaveBeenCalledWith(path.resolve('/users/test/docs'));
  });

  it('threads the managed-worktree authorizer through the filesystem composition root', async () => {
    managedWorktreeAuthorizer.mockResolvedValue('authorized');

    await handlers.get('fs:addRootByPath')?.(createTrustedInvokeEvent(), '/managed/app/bright-fox');

    expect(managedWorktreeAuthorizer).toHaveBeenCalledWith('/managed/app/bright-fox');
  });
});
