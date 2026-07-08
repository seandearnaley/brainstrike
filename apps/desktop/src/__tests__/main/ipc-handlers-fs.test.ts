import path from 'node:path';
import { AccessError, type DirectoryHandle, type FileHandle } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture registered handlers
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/Users/test/Documents'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
  },
}));

import { registerIpcHandlers } from '../../ipc-handlers';

describe('ipc-handlers filesystem endpoints', () => {
  let fsAdapter: ElectronFileSystemAdapter;
  let storage: ElectronStorageAdapter;
  let store: Record<string, unknown>;

  beforeEach(() => {
    handlers.clear();
    vi.resetModules();
    vi.clearAllMocks();

    fsAdapter = {
      exists: vi.fn(async () => true),
      readDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => 'ok'),
      readFileByPath: vi.fn(async () => 'file content by path'),
      requestDirectoryAccess: vi.fn(
        async () =>
          ({
            id: 'real-dir',
            kind: 'directory',
            name: 'real',
            path: '/real',
            type: 'directory',
          }) as unknown as DirectoryHandle
      ),
      watchDirectory: vi.fn(),
    } as unknown as ElectronFileSystemAdapter;

    storage = {
      clear: vi.fn(),
      getAllKeys: vi.fn(),
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } as unknown as ElectronStorageAdapter;

    store = {};

    registerIpcHandlers(fsAdapter, storage, store as never);
  });

  it('fs:requestDirectoryAccess returns mock handle in test mode', async () => {
    process.env['ELECTRON_IS_E2E_TEST'] = 'true';
    const handler = handlers.get('fs:requestDirectoryAccess');
    const result = await handler?.({} as unknown as IpcMainInvokeEvent);
    expect(result).toMatchObject({ id: 'mock-directory-handle', kind: 'directory' });
    process.env['ELECTRON_IS_E2E_TEST'] = undefined;
  });

  it('fs:requestDirectoryAccess proxies to adapter when not test mode', async () => {
    const prevElectronTest = process.env['ELECTRON_IS_E2E_TEST'];
    const prevNodeEnv = process.env['NODE_ENV'];
    process.env['ELECTRON_IS_E2E_TEST'] = undefined;
    process.env['NODE_ENV'] = 'development';

    const handler = handlers.get('fs:requestDirectoryAccess');
    const result = await handler?.({} as unknown as IpcMainInvokeEvent);
    expect(fsAdapter.requestDirectoryAccess).toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'real-dir' });

    if (prevElectronTest !== undefined) {
      process.env['ELECTRON_IS_E2E_TEST'] = prevElectronTest;
    }
    if (prevNodeEnv !== undefined) {
      process.env['NODE_ENV'] = prevNodeEnv;
    }
  });

  it('fs:readDirectory returns canned listing for mock handle', async () => {
    const handler = handlers.get('fs:readDirectory');
    const mockHandle = { id: 'mock-directory-handle' } as unknown as DirectoryHandle;
    const items = await handler?.({} as unknown as IpcMainInvokeEvent, mockHandle);

    // Should match the structure returned by getMockDirectoryStructure
    const rootPath = '/mock/test/directory';
    expect(items).toEqual([
      {
        depth: 1,
        handle: {
          id: 'mock-file-1',
          kind: 'file',
          name: 'mock-file1.txt',
          path: `${rootPath}/mock-file1.txt`,
          platform: 'electron',
        },
        name: 'mock-file1.txt',
        path: `${rootPath}/mock-file1.txt`,
        rootFolderId: 'mock-directory-handle',
        selectionState: 'unchecked',
        size: 100,
        type: 'file',
      },
      {
        depth: 1,
        handle: {
          id: 'mock-file-2',
          kind: 'file',
          name: 'mock-file2.ts',
          path: `${rootPath}/mock-file2.ts`,
          platform: 'electron',
        },
        name: 'mock-file2.ts',
        path: `${rootPath}/mock-file2.ts`,
        rootFolderId: 'mock-directory-handle',
        selectionState: 'unchecked',
        size: 250,
        type: 'file',
      },
      {
        children: [],
        depth: 1,
        handle: {
          id: 'mock-subfolder',
          kind: 'directory',
          name: 'mock-subfolder',
          path: `${rootPath}/mock-subfolder`,
          platform: 'electron',
        },
        name: 'mock-subfolder',
        path: `${rootPath}/mock-subfolder`,
        rootFolderId: 'mock-directory-handle',
        selectionState: 'unchecked',
        type: 'directory',
      },
    ]);
  });

  it('fs:readDirectory proxies to adapter for real handle', async () => {
    const handler = handlers.get('fs:readDirectory');
    const resolvedPath = path.resolve('/users/test/docs');
    const realHandle = {
      id: 'real',
      kind: 'directory',
      path: '/users/test/docs',
    } as unknown as DirectoryHandle;
    await handler?.({} as unknown as IpcMainInvokeEvent, realHandle);
    expect(fsAdapter.readDirectory).toHaveBeenCalledWith({ ...realHandle, path: resolvedPath });
  });

  it('fs:readFile returns canned content for mock file handle', async () => {
    const handler = handlers.get('fs:readFile');
    const mockFile = { id: 'mock-file-123' } as unknown as FileHandle;
    const content = await handler?.({} as unknown as IpcMainInvokeEvent, mockFile);
    expect(String(content)).toContain('Mock file content for testing');
  });

  it('fs:readFile proxies to adapter for real file handle', async () => {
    const handler = handlers.get('fs:readFile');
    const resolvedPath = path.resolve('/users/test/docs/file.txt');
    const realFile = {
      id: 'real-file',
      path: '/users/test/docs/file.txt',
    } as unknown as FileHandle;
    await handler?.({} as unknown as IpcMainInvokeEvent, realFile);
    expect(fsAdapter.readFile).toHaveBeenCalledWith({ ...realFile, path: resolvedPath });
  });

  it('fs:readFile returns structured size-limit payload for oversized files', async () => {
    const handler = handlers.get('fs:readFile');
    const realFile = { id: 'real-file', path: '/users/test/large.json' } as unknown as FileHandle;
    vi.mocked(fsAdapter.readFile).mockRejectedValueOnce(
      new AccessError('File too large: 1.1MB (max: 750KB)', '/users/test/large.json', 'read')
    );

    const result = await handler?.({} as unknown as IpcMainInvokeEvent, realFile);

    expect(result).toEqual({
      code: 'TOO_LARGE',
      message: 'File too large: 1.1MB (max: 750KB)',
    });
  });

  it('fs:readFile maps TOO_LARGE coded errors to structured payloads', async () => {
    const handler = handlers.get('fs:readFile');
    const realFile = { id: 'real-file', path: '/users/test/large.json' } as unknown as FileHandle;
    const codedError = Object.assign(new Error('Size limit exceeded by adapter'), {
      code: 'TOO_LARGE' as const,
    });
    vi.mocked(fsAdapter.readFile).mockRejectedValueOnce(codedError);

    const result = await handler?.({} as unknown as IpcMainInvokeEvent, realFile);

    expect(result).toEqual({
      code: 'TOO_LARGE',
      message: 'Size limit exceeded by adapter',
    });
  });

  it('fs:exists rejects null bytes', async () => {
    const handler = handlers.get('fs:exists');
    const result = await handler?.({} as unknown as IpcMainInvokeEvent, '/tmp/\0oops');
    expect(result).toBe(false);
    expect(fsAdapter.exists).not.toHaveBeenCalled();
  });

  it('fs:exists rejects excessive traversal', async () => {
    const handler = handlers.get('fs:exists');
    const pathWithTraversal = '../../'.repeat(11);
    const result = await handler?.({} as unknown as IpcMainInvokeEvent, pathWithTraversal);
    expect(result).toBe(false);
    expect(fsAdapter.exists).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'fs:exists rejects sensitive directories on Unix',
    async () => {
      const handler = handlers.get('fs:exists');
      const result = await handler?.({} as unknown as IpcMainInvokeEvent, '/etc/passwd');
      expect(result).toBe(false);
    }
  );

  it('fs:exists proxies to adapter for normal paths', async () => {
    const handler = handlers.get('fs:exists');
    const ok = await handler?.({} as unknown as IpcMainInvokeEvent, '/users/test/docs');
    expect(ok).toBe(true);
    expect(fsAdapter.exists).toHaveBeenCalledWith(path.resolve('/users/test/docs'));
  });

  // BST-307: Tests for fs:readFileByPath endpoint
  describe('fs:readFileByPath', () => {
    it('returns canned content for mock paths', async () => {
      const handler = handlers.get('fs:readFileByPath');
      const content = await handler?.({} as unknown as IpcMainInvokeEvent, '/mock/test/file.txt');
      expect(String(content)).toContain('Mock file content for testing');
      expect(fsAdapter.readFileByPath).not.toHaveBeenCalled();
    });

    it('proxies to adapter for normal paths', async () => {
      const handler = handlers.get('fs:readFileByPath');
      const content = await handler?.({} as unknown as IpcMainInvokeEvent, '/users/test/file.txt');
      expect(content).toBe('file content by path');
      expect(fsAdapter.readFileByPath).toHaveBeenCalledWith(path.resolve('/users/test/file.txt'));
    });

    it('returns structured size-limit payload instead of throwing for oversized files', async () => {
      const handler = handlers.get('fs:readFileByPath');
      vi.mocked(fsAdapter.readFileByPath).mockRejectedValueOnce(
        new AccessError('File too large: 1.1MB (max: 750KB)', '/users/test/large-file.json', 'read')
      );

      const result = await handler?.(
        {} as unknown as IpcMainInvokeEvent,
        '/users/test/large-file.json'
      );

      expect(result).toEqual({
        code: 'TOO_LARGE',
        message: 'File too large: 1.1MB (max: 750KB)',
      });
    });

    it('rejects null bytes in path', async () => {
      const handler = handlers.get('fs:readFileByPath');
      await expect(
        handler?.({} as unknown as IpcMainInvokeEvent, '/tmp/\0malicious.txt')
      ).rejects.toThrow('Invalid path');
      expect(fsAdapter.readFileByPath).not.toHaveBeenCalled();
    });

    it('rejects excessive traversal in path', async () => {
      const handler = handlers.get('fs:readFileByPath');
      const pathWithTraversal = `${'../../'.repeat(11)}secret.txt`;
      await expect(
        handler?.({} as unknown as IpcMainInvokeEvent, pathWithTraversal)
      ).rejects.toThrow('Invalid path');
      expect(fsAdapter.readFileByPath).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'win32')('rejects sensitive directories on Unix', async () => {
      const handler = handlers.get('fs:readFileByPath');
      await expect(handler?.({} as unknown as IpcMainInvokeEvent, '/etc/passwd')).rejects.toThrow(
        'Invalid path'
      );
      expect(fsAdapter.readFileByPath).not.toHaveBeenCalled();
    });
  });
});
