import path from 'node:path';
import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({
  canonicalTarget: '/workspace/project/target.txt',
  lexicalLink: '/workspace/project/link.txt',
}));

vi.mock('electron', async () => (await import('./file-system-ipc-test-harness')).electronMock);
vi.mock('@brainstrike/file-system/path-validation', () => ({
  resolveValidatedPath: vi.fn(async ({ requestedPath }: { requestedPath: unknown }) => ({
    ok: true as const,
    path: requestedPath === paths.lexicalLink ? paths.canonicalTarget : String(requestedPath),
  })),
}));

import { registerFileSystemIpcHandlers } from '../../ipc-domains/file-system-ipc';
import {
  createAdapterBackedCapabilities,
  createFileSystem,
  createStorage,
  getRootsDatabase,
  handlers,
  removeHandler,
} from './file-system-ipc-test-harness';

describe('file-system IPC lexical path handoff', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
  });

  it('validates canonical containment but passes lexical paths to native capabilities', async () => {
    const fileSystem = createFileSystem();
    registerFileSystemIpcHandlers({
      fileSystem,
      getRootsDatabase,
      storage: createStorage(),
      workspaceFileCapabilities: createAdapterBackedCapabilities(fileSystem),
    });
    const directoryHandle = {
      kind: 'directory',
      name: path.basename(paths.lexicalLink),
      path: paths.lexicalLink,
      platform: 'electron',
      rootId: 'root-1',
    } as DirectoryHandle;
    const fileHandle = {
      kind: 'file',
      name: path.basename(paths.lexicalLink),
      path: paths.lexicalLink,
      platform: 'electron',
      rootId: 'root-1',
    } as FileHandle;

    await handlers.get('fs:readDirectory')?.({} as IpcMainInvokeEvent, directoryHandle);
    await handlers.get('fs:readFile')?.({} as IpcMainInvokeEvent, fileHandle);
    await handlers.get('fs:readFileByPath')?.({} as IpcMainInvokeEvent, paths.lexicalLink);

    expect(fileSystem.readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: paths.lexicalLink })
    );
    expect(fileSystem.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: paths.lexicalLink })
    );
    expect(fileSystem.readFileByPath).toHaveBeenCalledWith(paths.lexicalLink);
  });
});
