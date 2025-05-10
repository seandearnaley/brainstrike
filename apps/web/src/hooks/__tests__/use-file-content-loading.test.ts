import type { IFileNode } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileExplorer } from '../../lib/file/explorer';
import { createFileNode } from '../../test/factories/file-node';
import { useFileContentLoading } from '../use-file-content-loading';

// Define mock implementations
vi.mock('../../lib/file/system', () => ({
  fileSystem: {
    readFileContent: vi.fn().mockResolvedValue('test content'),
  },
}));

vi.mock('@brainstrike/utils/file-content', () => ({
  fileContent: {
    isTextContent: vi.fn(),
    isTextExtension: vi.fn(),
    isBinaryExtension: vi.fn(),
    readFileContent: vi.fn(),
  },
}));

vi.mock('../../lib/file/explorer', () => ({
  fileExplorer: {
    findNodeByPath: vi.fn(),
    getFileExtension: vi.fn().mockReturnValue('.txt'),
  },
}));

// Mock console.debug and error to avoid test noise
vi.spyOn(console, 'debug').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('useFileContentLoading', () => {
  let mockFileHandle: FileSystemFileHandle;
  let mockFile: File;
  let mockText: ReturnType<typeof vi.fn>;
  const TEST_FOLDER_ID = 'test-folder-id';

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup fake timers for each test
    vi.useFakeTimers();

    // Setup mock file content loading
    mockText = vi.fn().mockResolvedValue('test content');
    mockFile = {
      size: 100,
      name: 'test.txt',
      text: mockText,
      type: 'text/plain',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    } as unknown as File;

    mockFileHandle = {
      kind: 'file' as const,
      name: 'test.txt',
      getFile: vi.fn().mockResolvedValue(mockFile),
      createWritable: vi.fn(),
      isSameEntry: vi.fn(),
    };

    // Setup fileExplorer mock
    vi.mocked(fileExplorer.findNodeByPath).mockImplementation(
      (_: IFileNode[], path: string, rootId?: string) => {
        // Return a mock file node that matches the path and rootId
        return createFileNode({
          name: path.split('/').pop() || 'test.txt',
          path,
          handle: mockFileHandle,
          rootFolderId: rootId || 'default-folder',
        });
      }
    );

    // Setup fileContent mock
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Restore real timers after each test
    vi.useRealTimers();
  });

  const renderUseFileContentLoadingHook = (fileTree: IFileNode[] = []) => {
    return renderHook(() => useFileContentLoading(fileTree));
  };

  const getCompositeKey = (path: string) => encodeFileSelection(TEST_FOLDER_ID, path);

  // Helper to wait for state updates
  const waitForStateUpdate = async () => {
    // Run all pending timers
    vi.runAllTimers();
    // Wait for all promises to resolve
    await vi.runAllTimersAsync();
  };

  describe('Basic Functionality', () => {
    it('should initialize with empty state', () => {
      const { result } = renderUseFileContentLoadingHook();

      expect(result.current.fileContents).toEqual({});
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should load text file content', async () => {
      // Create a mock file node
      const fileNode = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      // Ensure findNodeByPath returns the file node
      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(fileNode);

      // Render the hook with the file tree containing our file node
      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.txt');

      // Execute the loading function
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('test content');
    });

    it('should handle binary files', async () => {
      const fileNode = createFileNode({
        name: 'test.png',
        path: '/test.png',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(fileNode);
      // Make this extension binary
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(true);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.png');

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('Binary file - preview not available');
    });

    it('should handle large files', async () => {
      const largeFile = {
        ...mockFile,
        size: 2 * 1024 * 1024, // 2MB
      };

      mockFileHandle.getFile = vi.fn().mockResolvedValue(largeFile);

      const fileNode = createFileNode({
        name: 'large.txt',
        path: '/large.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(fileNode);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/large.txt');

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('test content');
    });
  });

  describe('Error Handling', () => {
    it('should handle file loading errors', async () => {
      mockFileHandle.getFile = vi.fn().mockRejectedValue(new Error('Failed to load file'));

      const fileNode = createFileNode({
        name: 'error.txt',
        path: '/error.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(fileNode);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/error.txt');

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
    });

    it('should handle missing file nodes', async () => {
      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(null);

      const { result } = renderUseFileContentLoadingHook([]);
      const compositeKey = getCompositeKey('/nonexistent.txt');

      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
      });

      expect(result.current.fileContents[compositeKey]).toBeUndefined();
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

      vi.mocked(fileExplorer.findNodeByPath).mockImplementation(
        (_: IFileNode[], path: string, rootId?: string) => {
          return files.find((n: IFileNode) => n.path === path && n.rootFolderId === rootId) || null;
        }
      );

      const { result, rerender } = renderUseFileContentLoadingHook(files);
      const compositeKeys = files.map((f) => getCompositeKey(f.path));

      await act(async () => {
        result.current.handleFileContentLoading(compositeKeys);
        await waitForStateUpdate();
        rerender();
      });

      for (const compositeKey of compositeKeys) {
        expect(result.current.fileContents[compositeKey]).toBe('test content');
      }
    });

    it('should handle mixed success and failure', async () => {
      const failedFileHandle = {
        ...mockFileHandle,
        getFile: vi.fn().mockRejectedValue(new Error('Failed to load')),
      };

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
          handle: failedFileHandle,
          rootFolderId: TEST_FOLDER_ID,
        }),
      ];

      vi.mocked(fileExplorer.findNodeByPath).mockImplementation(
        (_: IFileNode[], path: string, rootId?: string) => {
          return files.find((n: IFileNode) => n.path === path && n.rootFolderId === rootId) || null;
        }
      );

      const { result, rerender } = renderUseFileContentLoadingHook(files);
      const compositeKeys = files.map((f) => getCompositeKey(f.path));

      await act(async () => {
        result.current.handleFileContentLoading(compositeKeys);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[getCompositeKey('/success.txt')]).toBe('test content');
      expect(result.current.fileContents[getCompositeKey('/error.txt')]).toBe(
        'Error accessing file'
      );
    });

    it('should skip already loaded files', async () => {
      const fileNode = createFileNode({
        name: 'test.txt',
        path: '/test.txt',
        handle: mockFileHandle,
        rootFolderId: TEST_FOLDER_ID,
      });

      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(fileNode);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey('/test.txt');

      // First load the file
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('test content');

      // Reset the mock to track second call
      mockText.mockClear();

      // Try to load it again
      await act(async () => {
        await result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
      });

      // Should not have called text() again
      expect(mockText).not.toHaveBeenCalled();
    });
  });
});
