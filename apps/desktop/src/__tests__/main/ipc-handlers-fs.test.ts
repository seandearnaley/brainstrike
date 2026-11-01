import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedWorktreeAuthorizer } from '@brainstrike/assistant-service/node-workspace-services';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers } from '../../ipc-handlers';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  getRootsCatalog,
  resetRootsCatalog,
} from '../ipc-domains/file-system-ipc-test-harness';

vi.mock('electron', async () => ({
  ...(await import('../ipc-domains/file-system-ipc-test-harness')).electronMock,
  app: { getPath: vi.fn(() => '/Users/test/Documents') },
}));

describe('ipc-handlers filesystem composition', () => {
  let base: string;
  let fileSystem: ElectronFileSystemAdapter;
  let managedWorktreeAuthorizer: ReturnType<typeof vi.fn<ManagedWorktreeAuthorizer>>;
  let storage: ElectronStorageAdapter;
  let storedValues: Map<string, string>;
  let close: () => Promise<void>;
  let docs: string;
  let managed: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ipc-handlers-fs-')));
    docs = path.join(base, 'docs');
    managed = path.join(base, 'bright-fox');
    mkdirSync(docs);
    mkdirSync(managed);
    resetRootsCatalog();
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ELECTRON_IS_E2E_TEST', '');
    storedValues = new Map();
    fileSystem = {
      exists: vi.fn(async () => true),
      requestDirectoryAccess: vi.fn(async () => ({
        kind: 'directory',
        name: 'docs',
        path: docs,
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
    close = registerIpcHandlers(fileSystem, storage, {
      getRootsCatalog,
      managedWorktreeAuthorizer,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await close();
    rmSync(base, { force: true, recursive: true });
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
      path: docs,
      rootId: expect.any(String),
    });
    expect(storedValues.get('rootsList')).toContain(handle.rootId);
  });

  it("opens the E2E harness's real folder from test mode's picker, and refuses without one", async () => {
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    vi.stubEnv('BRAINSTRIKE_E2E_REAL_ROOT_PATH', managed);

    await expect(mountRoot()).resolves.toMatchObject({ path: managed, rootId: expect.any(String) });
    expect(fileSystem.requestDirectoryAccess).not.toHaveBeenCalled();

    vi.stubEnv('BRAINSTRIKE_E2E_REAL_ROOT_PATH', '');
    await expect(mountRoot()).rejects.toMatchObject({ code: 'boundary.internal' });
  });

  it('threads the managed-worktree authorizer through the filesystem composition root', async () => {
    managedWorktreeAuthorizer.mockResolvedValue('authorized');

    await capabilityHandler('fs:addRootByPath')(createTrustedInvokeEvent(), managed);

    expect(managedWorktreeAuthorizer).toHaveBeenCalledWith(managed);
  });
});
