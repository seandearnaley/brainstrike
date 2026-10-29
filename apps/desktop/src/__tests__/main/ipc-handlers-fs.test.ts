import path from 'node:path';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWorktreeAuthorizer } from '../../ipc-domains/workspace-recent-roots';
import { registerIpcHandlers } from '../../ipc-handlers';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  getRootsCatalog,
  resetRootsCatalog,
} from '../ipc-domains/file-system-ipc-test-harness';

const DOCS = path.resolve('/users/test/docs');
const MANAGED = path.resolve('/managed/app/bright-fox');

vi.mock('electron', async () => ({
  ...(await import('../ipc-domains/file-system-ipc-test-harness')).electronMock,
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
}));

describe('ipc-handlers filesystem composition', () => {
  let fileSystem: ElectronFileSystemAdapter;
  let managedWorktreeAuthorizer: ReturnType<typeof vi.fn<ManagedWorktreeAuthorizer>>;
  let storage: ElectronStorageAdapter;
  let storedValues: Map<string, string>;
  let close: () => Promise<void>;

  beforeEach(() => {
    resetRootsCatalog();
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
        path: DOCS,
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
    close = registerIpcHandlers(fileSystem, storage, () => null, {
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      managedWorktreeAuthorizer,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await close();
  });

  async function mountRoot(): Promise<DirectoryHandle> {
    return (await capabilityHandler('fs:requestDirectoryAccess')(
      createTrustedInvokeEvent()
    )) as DirectoryHandle;
  }

  it('registers and mounts a selected real root before returning its handle', async () => {
    const handle = await mountRoot();

    expect(fileSystem.requestDirectoryAccess).toHaveBeenCalledOnce();
    expect(handle).toMatchObject({
      path: DOCS,
      rootId: expect.any(String),
    });
    expect(storedValues.get('rootsList')).toContain(handle.rootId);
  });

  it('keeps the E2E mock path isolated from the real adapter', async () => {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');

    const handle = await mountRoot();
    const entries = await capabilityHandler('fs:readDirectory')(createTrustedInvokeEvent(), handle);
    const content = await capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), {
      kind: 'file',
      name: 'file.txt',
      path: path.join(handle.path, 'file.txt'),
      platform: 'electron',
      ...(handle.rootId === undefined ? {} : { rootId: handle.rootId }),
    } satisfies FileHandle);

    // The mock root is an absolute path: `C:\mock\…` on Windows.
    expect(handle).toMatchObject({
      path: path.resolve('/mock/test/directory'),
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
      path: path.join(DOCS, 'file.txt'),
      platform: 'electron',
      ...(root.rootId === undefined ? {} : { rootId: root.rootId }),
    } satisfies FileHandle;

    await expect(
      capabilityHandler('fs:readDirectory')(createTrustedInvokeEvent(), root)
    ).resolves.toEqual([]);
    await expect(capabilityHandler('fs:readFile')(createTrustedInvokeEvent(), file)).resolves.toBe(
      'file content'
    );
    await expect(
      capabilityHandler('fs:readFileByPath')(createTrustedInvokeEvent(), file.path)
    ).resolves.toBe('file content');
    expect(fileSystem.readDirectory).toHaveBeenCalledOnce();
    expect(fileSystem.readFile).toHaveBeenCalledTimes(2);
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('rejects unmounted, escaped, and malformed paths', async () => {
    const readByPath = capabilityHandler('fs:readFileByPath');
    await expect(
      readByPath(createTrustedInvokeEvent(), path.join(DOCS, 'file.txt'))
    ).rejects.toMatchObject({
      code: 'workspace.path-outside-root',
      failure: { category: 'authorization', kind: 'refusal' },
    });

    await mountRoot();
    await expect(
      readByPath(createTrustedInvokeEvent(), '/users/test/outside.txt')
    ).rejects.toMatchObject({
      code: 'workspace.path-outside-root',
      failure: { category: 'authorization', kind: 'refusal' },
    });
    await expect(
      readByPath(createTrustedInvokeEvent(), '/users/test/docs/\0malicious.txt')
    ).rejects.toMatchObject({
      code: 'workspace.path-invalid',
      failure: { category: 'input', kind: 'refusal' },
    });
    expect(fileSystem.readFileByPath).not.toHaveBeenCalled();
  });

  it('retains the existing guarded existence endpoint', async () => {
    await expect(
      capabilityHandler('fs:exists')(createTrustedInvokeEvent(), '/tmp/\0oops')
    ).resolves.toBe(false);
    await expect(capabilityHandler('fs:exists')(createTrustedInvokeEvent(), DOCS)).resolves.toBe(
      true
    );
    expect(fileSystem.exists).toHaveBeenCalledWith(DOCS);
  });

  it('threads the managed-worktree authorizer through the filesystem composition root', async () => {
    managedWorktreeAuthorizer.mockResolvedValue('authorized');

    await capabilityHandler('fs:addRootByPath')(createTrustedInvokeEvent(), MANAGED);

    expect(managedWorktreeAuthorizer).toHaveBeenCalledWith(MANAGED);
  });
});
