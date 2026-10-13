import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';

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

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  createFileSystem,
  createStorage,
  getRootsCatalog,
  handlers,
  resetRootsCatalog,
} from './file-system-ipc-test-harness';
import { loggerMock } from './workspace-root-registry-logger-test-helper';

function grantedStorage(grantedPath: string): ElectronStorageAdapter {
  return createStorage({
    recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: grantedPath }]),
  });
}

async function invokeAddRootByPath(requestedPath: string): Promise<unknown> {
  const handler = handlers.get('fs:addRootByPath');
  if (!handler) {
    throw new Error('fs:addRootByPath handler was not registered');
  }
  return handler(createTrustedInvokeEvent(), requestedPath);
}

describe('file system IPC root-granted notification', () => {
  beforeEach(() => {
    resetRootsCatalog();
    handlers.clear();
    loggerMock.warn.mockClear();
  });

  it('notifies exactly once with the mounted descriptor path after addRootByPath succeeds', async () => {
    const grantedPath = '/users/test/workspace';
    const onWorkspaceRootGranted = vi.fn();
    registerFileSystemIpcHandlers({
      fileSystem: createFileSystem(grantedPath),
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      onWorkspaceRootGranted,
      storage: grantedStorage(grantedPath),
    });

    await expect(invokeAddRootByPath(grantedPath)).resolves.toMatchObject({
      handle: { path: grantedPath },
    });
    expect(onWorkspaceRootGranted).toHaveBeenCalledExactlyOnceWith(grantedPath);
  });

  it('does not notify when addRootByPath rejects', async () => {
    const onWorkspaceRootGranted = vi.fn();
    registerFileSystemIpcHandlers({
      fileSystem: createFileSystem(),
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      onWorkspaceRootGranted,
      storage: createStorage(),
    });

    await expect(invokeAddRootByPath('/users/test/ungranted')).rejects.toThrow(
      'Folder was never granted in this app'
    );
    expect(onWorkspaceRootGranted).not.toHaveBeenCalled();
  });

  it('keeps a successful invoke resolved when the notification subscriber throws', async () => {
    const grantedPath = '/users/test/workspace';
    const subscriberError = new Error('menu subscriber failed');
    registerFileSystemIpcHandlers({
      fileSystem: createFileSystem(grantedPath),
      getRootsCatalog,
      isSyntheticFileSystemPath: () => true,
      onWorkspaceRootGranted: () => {
        throw subscriberError;
      },
      storage: grantedStorage(grantedPath),
    });

    await expect(invokeAddRootByPath(grantedPath)).resolves.toMatchObject({
      handle: { path: grantedPath },
    });
    expect(loggerMock.warn).toHaveBeenCalledWith('workspace-root grant subscriber threw', {
      error: subscriberError,
    });
  });
});
