// @vitest-environment jsdom
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronRendererFileSystemAdapter } from '../../renderer/adapters';
import { mockElectronAPI } from '../setup';

// The adapter's watches reach the agent host; the window's real connector loads the browser transport.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

describe('ElectronRendererFileSystemAdapter', () => {
  let adapter: ElectronRendererFileSystemAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
  });

  it('reconstructs a folder authorization refusal after the context bridge', async () => {
    mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce({
      error: {
        category: 'authorization',
        code: 'workspace.never-granted',
        kind: 'refusal',
        message: 'Folder access was declined.',
        remedy: 'Choose this folder with Add folder to grant access.',
      },
      ok: false,
    } as never);
    await expect(adapter.requestDirectoryAccess()).rejects.toMatchObject({
      code: 'workspace.never-granted',
      failure: { remedy: 'Choose this folder with Add folder to grant access.' },
    });
  });

  it('declares platform "electron" (roots registry derives kind "path" from this)', () => {
    expect(adapter.platform).toBe('electron');
  });

  describe('requestDirectoryAccess', () => {
    it('should call electronAPI.fileSystem.requestDirectoryAccess', async () => {
      const result = await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.requestDirectoryAccess).toHaveBeenCalledOnce();
      expect(result).toEqual({
        kind: 'directory',
        name: 'mock-directory',
        path: '/mock/path',
        platform: 'electron',
      });
    });

    it('does not perform a follow-up IPC call to persist the folder path', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'test-directory',
        path: '/test/folder/path',
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce({
        ok: true,
        value: mockHandle,
      });

      await adapter.requestDirectoryAccess();

      // Main owns the last-folder preference via the registry's addRoot, so
      // the renderer must not perform a separate saveLastFolder write.
      expect(mockElectronAPI.fileSystem.saveLastFolder).not.toHaveBeenCalled();
    });
  });

  describe('readDirectory', () => {
    it('should call electronAPI.fileSystem.readDirectory with handle', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'test',
        path: '/test',
        platform: 'electron' as const,
      };
      const mockFiles = [
        {
          depth: 0,
          isVisible: true,
          name: 'file1.txt',
          path: '/test/file1.txt',
          rootFolderId: 'test',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      mockElectronAPI.fileSystem.readDirectory.mockResolvedValue({ ok: true, value: mockFiles });

      const result = await adapter.readDirectory(mockHandle);

      expect(mockElectronAPI.fileSystem.readDirectory).toHaveBeenCalledWith(mockHandle);
      expect(result).toEqual(mockFiles);
    });
  });

  describe('readFile', () => {
    it('should call electronAPI.fileSystem.readFile with handle', async () => {
      const mockHandle = {
        kind: 'file' as const,
        name: 'file.txt',
        path: '/test/file.txt',
        platform: 'electron' as const,
      };
      const mockContent = 'file content';

      mockElectronAPI.fileSystem.readFile.mockResolvedValue({ ok: true, value: mockContent });

      const result = await adapter.readFile(mockHandle);

      expect(mockElectronAPI.fileSystem.readFile).toHaveBeenCalledWith(mockHandle);
      expect(result).toBe(mockContent);
    });
  });

  describe('exists', () => {
    it('should call electronAPI.fileSystem.exists with path', async () => {
      const testPath = '/test/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue({ ok: true, value: true });

      const result = await adapter.exists(testPath);

      expect(mockElectronAPI.fileSystem.exists).toHaveBeenCalledWith(testPath);
      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      const testPath = '/nonexistent/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue({ ok: true, value: false });

      const result = await adapter.exists(testPath);

      expect(result).toBe(false);
    });
  });

  // BST-307: Tests for readFileByPath
  describe('readFileByPath', () => {
    it('should call electronAPI.fileSystem.readFileByPath with absolute path', async () => {
      const absolutePath = '/Users/test/project/file.ts';
      const mockContent = 'export const example = "hello";';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue({ ok: true, value: mockContent });

      const result = await adapter.readFileByPath(absolutePath);

      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(absolutePath);
      expect(result).toBe(mockContent);
    });

    it('should return file content for valid paths', async () => {
      const testPath = '/test/documents/readme.md';
      const expectedContent = '# Test README\n\nThis is a test file.';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue({
        ok: true,
        value: expectedContent,
      });

      const result = await adapter.readFileByPath(testPath);

      expect(result).toBe(expectedContent);
    });

    it('should handle errors from the IPC call', async () => {
      const testPath = '/nonexistent/file.txt';

      mockElectronAPI.fileSystem.readFileByPath.mockRejectedValue(new Error('File not found'));

      await expect(adapter.readFileByPath(testPath)).rejects.toThrow(INTERNAL_FAULT.message);
    });

    it('should propagate path validation errors from main process', async () => {
      const invalidPath = '/etc/passwd';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue({
        error: {
          category: 'input',
          code: 'workspace.path-invalid',
          kind: 'refusal',
          message: 'Invalid path',
          remedy: 'Choose a connected folder.',
        },
        ok: false,
      } as never);

      await expect(adapter.readFileByPath(invalidPath)).rejects.toThrow('Invalid path');
      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(invalidPath);
    });
  });

  describe('readFileByAbsolutePath', () => {
    it('carries the claimed mounted root through the scoped bridge API', async () => {
      const absolutePath = '/Users/test/project/file.txt';
      const rootPath = '/Users/test/project';
      const rootId = 'root-project';
      mockElectronAPI.fileSystem.readFileByAbsolutePath.mockResolvedValue({
        ok: true,
        value: 'absolute content',
      });

      await expect(adapter.readFileByAbsolutePath(absolutePath, rootPath, rootId)).resolves.toBe(
        'absolute content'
      );
      expect(mockElectronAPI.fileSystem.readFileByAbsolutePath).toHaveBeenCalledExactlyOnceWith(
        absolutePath,
        rootPath,
        rootId
      );
      expect(mockElectronAPI.fileSystem.readFileByPath).not.toHaveBeenCalled();
    });

    it.each([
      { absolutePath: '/workspace/file.txt', rootPath: '' },
      { absolutePath: '/workspace/file.txt', rootPath: '   ' },
      { absolutePath: '/workspace/file.txt', rootPath: 'workspace' },
      { absolutePath: 'file.txt', rootPath: '/workspace' },
      { absolutePath: '\\file.txt', rootPath: '/workspace' },
    ])(
      'rejects malformed explicit read authority root=$rootPath path=$absolutePath',
      async ({ absolutePath, rootPath }) => {
        mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue({
          ok: true,
          value: 'unsafe-content',
        });

        await expect(
          adapter.readFileByAbsolutePath(absolutePath, rootPath, 'root-project')
        ).rejects.toThrow('absolute path');
        expect(mockElectronAPI.fileSystem.readFileByPath).not.toHaveBeenCalled();
      }
    );

    it('rejects missing durable root identity before invoking the bridge', async () => {
      await expect(
        adapter.readFileByAbsolutePath('/workspace/file.txt', '/workspace', '')
      ).rejects.toThrow('durable rootId');
      expect(mockElectronAPI.fileSystem.readFileByAbsolutePath).not.toHaveBeenCalled();
    });
  });

  describe('addRoot', () => {
    it('should call electronAPI.fileSystem.addRoot and return the descriptor', async () => {
      const mockDescriptor = {
        displayName: 'my-project',
        handle: {
          kind: 'directory' as const,
          name: 'my-project',
          path: '/test/my-project',
          platform: 'electron' as const,
        },
        kind: 'path' as const,
        permissionState: 'granted' as const,
        persisted: true,
        rootId: 'abc-123',
      };
      mockElectronAPI.fileSystem.addRoot.mockResolvedValueOnce({ ok: true, value: mockDescriptor });

      const result = await adapter.addRoot();

      expect(mockElectronAPI.fileSystem.addRoot).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptor);
    });
  });

  describe('restoreRoots', () => {
    it('should call electronAPI.fileSystem.restoreRoots and return descriptors', async () => {
      const mockDescriptors = [
        {
          displayName: 'project-a',
          handle: {
            kind: 'directory' as const,
            name: 'project-a',
            path: '/test/project-a',
            platform: 'electron' as const,
          },
          kind: 'path' as const,
          permissionState: 'granted' as const,
          persisted: true,
          rootId: 'root-a',
        },
      ];
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce({
        ok: true,
        value: mockDescriptors,
      });

      const result = await adapter.restoreRoots();

      expect(mockElectronAPI.fileSystem.restoreRoots).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptors);
    });

    it('should return empty array when no roots are stored', async () => {
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce({ ok: true, value: [] });

      const result = await adapter.restoreRoots();

      expect(result).toEqual([]);
    });
  });

  describe('restoreLastFolder', () => {
    it('should call electronAPI.fileSystem.restoreLastFolder', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'restored-folder',
        path: '/restored/folder/path',
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue({
        ok: true,
        value: mockHandle,
      });

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toEqual(mockHandle);
    });

    it('should return null when no folder to restore', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue({ ok: true, value: null });

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockRejectedValue(new Error('Restore failed'));

      await expect(adapter.restoreLastFolder()).rejects.toThrow(INTERNAL_FAULT.message);
    });
  });
});
