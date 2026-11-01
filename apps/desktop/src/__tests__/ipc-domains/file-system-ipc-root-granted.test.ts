import path from 'node:path';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  capabilityHandler,
  createFileSystem,
  createStorage,
  getRootsCatalog,
  inMemoryRootSeams,
  resetRootsCatalog,
} from './file-system-ipc-test-harness';
import { loggerMock } from './workspace-root-registry-logger-test-helper';

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const { loggerMock: sharedLoggerMock } = await import(
    './workspace-root-registry-logger-test-helper'
  );
  return {
    ...(await importOriginal<typeof import('@brainstrike/logging')>()),
    createLogger: () => sharedLoggerMock,
  };
});

function grantedStorage(grantedPath: string): ElectronStorageAdapter {
  return createStorage({
    recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: grantedPath }]),
  });
}

async function invokeAddRootByPath(requestedPath: string): Promise<unknown> {
  return capabilityHandler('fs:addRootByPath')(createTrustedInvokeEvent(), requestedPath);
}

describe('file system IPC root-granted notification', () => {
  const registered: Array<() => Promise<void>> = [];

  function register(options: Parameters<typeof registerFileSystemIpcHandlers>[0]): void {
    registered.push(registerFileSystemIpcHandlers(options));
  }

  beforeEach(() => {
    resetRootsCatalog();
    loggerMock.warn.mockClear();
  });

  afterEach(async () => {
    await Promise.all(registered.splice(0).map((close) => close()));
  });

  it('notifies exactly once with the mounted descriptor path after addRootByPath succeeds', async () => {
    const grantedPath = path.resolve('/users/test/workspace');
    const onWorkspaceRootGranted = vi.fn();
    register({
      fileSystem: createFileSystem(grantedPath),
      getRootsCatalog,
      onWorkspaceRootGranted,
      storage: grantedStorage(grantedPath),
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
    });

    await expect(invokeAddRootByPath(grantedPath)).resolves.toMatchObject({
      handle: { path: grantedPath },
    });
    expect(onWorkspaceRootGranted).toHaveBeenCalledExactlyOnceWith(grantedPath);
  });

  it('does not notify when addRootByPath rejects', async () => {
    const onWorkspaceRootGranted = vi.fn();
    register({
      fileSystem: createFileSystem(),
      getRootsCatalog,
      onWorkspaceRootGranted,
      storage: createStorage(),
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
    });

    await expect(invokeAddRootByPath('/users/test/ungranted')).rejects.toThrow(
      'Folder was never granted in this app'
    );
    expect(onWorkspaceRootGranted).not.toHaveBeenCalled();
  });

  it('keeps a successful invoke resolved when the notification subscriber throws', async () => {
    const grantedPath = path.resolve('/users/test/workspace');
    const subscriberError = new Error('menu subscriber failed');
    register({
      fileSystem: createFileSystem(grantedPath),
      getRootsCatalog,
      onWorkspaceRootGranted: () => {
        throw subscriberError;
      },
      storage: grantedStorage(grantedPath),
      workspaceRootRegistryFileSystemSeams: inMemoryRootSeams,
    });

    await expect(invokeAddRootByPath(grantedPath)).resolves.toMatchObject({
      handle: { path: grantedPath },
    });
    expect(loggerMock.warn).toHaveBeenCalledWith('workspace-root grant subscriber threw', {
      error: subscriberError,
    });
  });
});
