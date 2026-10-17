import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  markDesktopShuttingDown,
  resetDesktopShutdownStateForTests,
} from '../../desktop-shutdown-state';
import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  createFileSystem,
  createStorage,
  getRootsCatalog,
  handlers,
  resetRootsCatalog,
} from './file-system-ipc-test-harness';
import { loggerMock } from './workspace-root-registry-logger-test-helper';

/**
 * BST-2118: the app closing during startup disposes the workspace root registry
 * while the renderer's `fs:restoreRoots` is still queued behind it.
 */
async function restoreRootsQueuedBehindClose(): Promise<unknown> {
  const close = registerFileSystemIpcHandlers({
    fileSystem: createFileSystem(),
    getRootsCatalog,
    isSyntheticFileSystemPath: () => true,
    storage: createStorage(),
  });
  const handler = handlers.get('fs:restoreRoots');
  if (!handler) {
    throw new Error('fs:restoreRoots handler was not registered');
  }
  const restoring = handler(createTrustedInvokeEvent());
  await close();
  return await restoring;
}

const disposedRefusal = {
  error: { code: 'workspace.root-registry-disposed', kind: 'refusal' },
  ok: false,
};

describe('file system IPC after its workspace root registry is disposed', () => {
  beforeEach(() => {
    resetRootsCatalog();
    handlers.clear();
    for (const log of Object.values(loggerMock)) {
      log.mockClear();
    }
  });
  afterEach(() => {
    resetDesktopShutdownStateForTests();
  });

  it('settles a restoreRoots that the app’s own shutdown cancelled as a typed refusal, at info', async () => {
    markDesktopShuttingDown();
    await expect(restoreRootsQueuedBehindClose()).resolves.toMatchObject(disposedRefusal);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Workspace root registry refused work: the app is quitting',
      expect.objectContaining({
        operation: { category: 'files', code: 'files.restore-roots-failed' },
      })
    );
  });

  it('still reports a disposed registry at error when the app is not shutting down', async () => {
    await expect(restoreRootsQueuedBehindClose()).resolves.toMatchObject(disposedRefusal);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Workspace root registry refused work after it was disposed',
      expect.objectContaining({
        operation: { category: 'files', code: 'files.restore-roots-failed' },
      })
    );
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      'Workspace root registry refused work: the app is quitting',
      expect.anything()
    );
  });
});
