import type { IFileNode } from '@/lib/file/types';
import { createFileNode } from '@/test/factories/file-node';
import { ConcurrentLoadingError, FileContentError } from '@/types/errors';
import { encodeFileSelection } from '@/utils/file-selection-utils';
import { act, renderHook } from '@testing-library/react';
import { useFileContentLoading } from '../use-file-content-loading';

describe('useFileContentLoading', () => {
  let mockFileHandle: FileSystemFileHandle;
  let mockFile: File;
  let mockText: jest.Mock;
  const TEST_FOLDER_ID = 'test-folder-id';

  beforeEach(() => {
    // Setup mock file content loading
    mockText = jest.fn().mockResolvedValue('test content');
    mockFile = {
      size: 100,
      name: 'test.txt',
      text: mockText,
    } as unknown as File;

    mockFileHandle = {
      kind: 'file' as const,
      name: 'test.txt',
      getFile: jest.fn().mockResolvedValue(mockFile),
      createWritable: jest.fn(),
      isSameEntry: jest.fn(),
    };
  });

  const renderUseFileContentLoadingHook = (fileTree: IFileNode[] = []) => {
    return renderHook(() => useFileContentLoading(fileTree));
  };

  const getCompositeKey = (path: string) => encodeFileSelection(TEST_FOLDER_ID, path);

  describe('Basic Functionality', () => {
    it('should initialize with empty state', () => {
      const { result } = renderUseFileContentLoadingHook();

      expect(result.current.fileContents).toEqual({});
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should load text file content', async () => {
      const fileNode = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.txt');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(result.current.fileContents[compositeKey]).toBe('test content');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should handle binary files', async () => {
      const fileNode = createFileNode({
        name: 'test.png',
        path: '/test.png',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.png');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(result.current.fileContents[compositeKey]).toBe('Binary file - preview not available');
      expect(result.current.error).toBeNull();
    });

    it('should handle large files', async () => {
      const largeFile = {
        ...mockFile,
        size: 2 * 1024 * 1024, // 2MB
      };

      mockFileHandle.getFile = jest.fn().mockResolvedValue(largeFile);

      const fileNode = createFileNode({
        name: 'large.txt',
        path: '/large.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/large.txt');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(result.current.fileContents[compositeKey]).toBe('test content');
      expect(result.current.error).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should handle file loading errors', async () => {
      mockFileHandle.getFile = jest.fn().mockRejectedValue(new Error('Failed to load file'));

      const fileNode = createFileNode({
        name: 'error.txt',
        path: '/error.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/error.txt');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
      expect(result.current.error).toBeNull();
    });

    it('should handle missing file nodes', async () => {
      const { result } = renderUseFileContentLoadingHook([]);
      const compositeKey = getCompositeKey('/nonexistent.txt');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(result.current.fileContents[compositeKey]).toBeUndefined();
      expect(result.current.error).toBeNull();
    });
  });

  describe('Concurrent Loading', () => {
    it('should handle multiple files loading concurrently', async () => {
      const files = Array.from({ length: 3 }, (_, i) =>
        createFileNode({
          name: `test${i}.txt`,
          path: `/test${i}.txt`,
          handle: mockFileHandle,
          rootFolderId: TEST_FOLDER_ID,
        })
      );

      const { result } = renderUseFileContentLoadingHook(files);
      const compositeKeys = files.map((f) => getCompositeKey(f.path));

      await act(async () => {
        await result.current.handleFileContentLoading(compositeKeys);
      });

      for (const compositeKey of compositeKeys) {
        expect(result.current.fileContents[compositeKey]).toBe('test content');
      }
      expect(mockText).toHaveBeenCalledTimes(3);
      expect(result.current.error).toBeNull();
    });

    it('should handle mixed success and failure', async () => {
      const files = [
        createFileNode({
          name: 'success.txt',
          path: '/success.txt',
          handle: mockFileHandle,
          rootFolderId: TEST_FOLDER_ID,
        }),
        createFileNode({
          name: 'error.txt',
          path: '/error.txt',
          handle: {
            ...mockFileHandle,
            getFile: jest.fn().mockRejectedValue(new Error('Failed to load')),
          },
          rootFolderId: TEST_FOLDER_ID,
        }),
      ];

      const { result } = renderUseFileContentLoadingHook(files);
      const compositeKeys = files.map((f) => getCompositeKey(f.path));

      await act(async () => {
        await result.current.handleFileContentLoading(compositeKeys);
      });

      expect(result.current.fileContents[getCompositeKey('/success.txt')]).toBe('test content');
      expect(result.current.fileContents[getCompositeKey('/error.txt')]).toBe(
        'Error accessing file'
      );
      expect(result.current.error).toBeNull();
    });

    it('should skip already loaded files', async () => {
      const fileNode = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.txt');

      // Load the file once and wait for it to complete
      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      // Try to load it again
      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
      });

      expect(mockText).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeNull();
    });

    it('should prevent duplicate loading of the same file', async () => {
      const fileNode = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      const { result } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.txt');

      // Try to load the same file concurrently
      await act(async () => {
        await Promise.all([
          result.current.handleFileContentLoading([compositeKey]),
          result.current.handleFileContentLoading([compositeKey]),
        ]);
      });

      expect(mockText).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeNull();
    });
  });

  describe('Memory Management', () => {
    it('properly cleans up file contents when files are unselected', async () => {
      const files = Array.from({ length: 3 }, (_, i) =>
        createFileNode({
          name: `test${i}.txt`,
          path: `/test${i}.txt`,
          handle: mockFileHandle,
          rootFolderId: TEST_FOLDER_ID,
        })
      );

      const { result } = renderUseFileContentLoadingHook(files);
      const compositeKeys = files.map((f) => getCompositeKey(f.path));

      // Load all files
      await act(async () => {
        await result.current.handleFileContentLoading(compositeKeys);
      });

      // Verify all files are loaded
      for (const compositeKey of compositeKeys) {
        expect(result.current.fileContents[compositeKey]).toBe('test content');
      }

      // Unselect two files
      await act(async () => {
        result.current.clearFileContents([compositeKeys[0], compositeKeys[1]]);
      });

      // Verify unselected files are removed and selected file remains
      expect(result.current.fileContents[compositeKeys[0]]).toBeUndefined();
      expect(result.current.fileContents[compositeKeys[1]]).toBeUndefined();
      expect(result.current.fileContents[compositeKeys[2]]).toBe('test content');

      // Unselect the last file
      await act(async () => {
        result.current.clearFileContents([compositeKeys[2]]);
      });

      // Verify all files are cleaned up
      expect(Object.keys(result.current.fileContents)).toHaveLength(0);
    });

    it('handles clearing non-existent files', async () => {
      const { result } = renderUseFileContentLoadingHook([]);
      const compositeKey = getCompositeKey('/nonexistent.txt');

      await act(async () => {
        result.current.clearFileContents([compositeKey]);
      });

      expect(Object.keys(result.current.fileContents)).toHaveLength(0);
    });
  });
});
