import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import type { IFileNode } from '@brainstrike/types';
import { fileContent } from '@brainstrike/utils/file-content';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectFileContentProcessor } from '../file-content-processor.js';
import { useFileContentLoading } from '../use-file-content-loading.js';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers.js';

// Define mock implementations
vi.mock('@brainstrike/utils/file-content', async (importOriginal) => {
  const actual: typeof import('@brainstrike/utils/file-content') = await importOriginal();
  return {
    ...actual,
    fileContent: {
      ...actual.fileContent,
      isBinaryExtension: vi.fn(),
      isTextContent: vi.fn(),
      isTextExtension: vi.fn(),
    },
  };
});

vi.mock('@brainstrike/file-explorer/selection', async (importOriginal) => {
  const actual: typeof import('@brainstrike/file-explorer/selection') = await importOriginal();
  return {
    ...actual,
    encodeFileSelection: vi.fn((folderId: string, path: string) => `${folderId}|@|${path}`),
  };
});

describe('useFileContentLoading', () => {
  const TestFolderId = 'test-folder-id';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    MockFileSystemAdapter.clearMockData(); // Clear adapter mocks
    // Setup fake timers for each test
    vi.useFakeTimers();

    // Setup fileExplorer mock
    fileExplorer.findNodeByPath = vi.fn((_: IFileNode[], path: string, rootId?: string) => {
      const fileName = path.split('/').pop() || 'unknown.file';
      return createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: fileName,
          path,
          platform: 'web',
        } as FileSystemFileHandle,
        name: fileName,
        path,
        rootFolderId: rootId || 'default-folder',
      });
    });

    // Setup fileContent mock (isTextExtension, isBinaryExtension might still be needed by the hook)
    vi.mocked(fileContent.isTextContent).mockReturnValue(true);
    vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
    vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore real timers after each test
    vi.useRealTimers();
  });

  const renderUseFileContentLoadingHook = (fileTree: IFileNode[] = []) => {
    const processor = new DirectFileContentProcessor();
    return renderHook(() => useFileContentLoading(fileTree, { processor }), {
      wrapper: AdaptersTestWrapper,
    });
  };

  const getCompositeKey = (path: string) => encodeFileSelection(TestFolderId, path);

  // Helper to wait for state updates
  const waitForStateUpdate = async () => {
    // Run all pending timers
    vi.runAllTimers();
    // Wait for all promises to resolve
    await act(async () => {}); // A more robust way to wait for react state updates
  };

  describe('Basic Functionality', () => {
    it('should initialize with empty state', () => {
      const { result } = renderUseFileContentLoadingHook();

      expect(result.current.fileContents).toEqual({});
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should load text file content', async () => {
      const filePath = '/test.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'test.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'test.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      const expectedContent = 'custom test content for text file';
      MockFileSystemAdapter.setMockFileContent(filePath, expectedContent);

      // Render the hook with the file tree containing our file node
      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      // Execute the loading function
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(expectedContent);
    });

    it('should handle binary files', async () => {
      const filePath = '/test.png';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'test.png',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'test.png',
        path: filePath,
        rootFolderId: TestFolderId,
      });

      // Make this extension binary
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(true);
      vi.mocked(fileContent.isTextExtension).mockReturnValue(false); // Ensure it's not also text

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe('Binary file - preview not available');
    });

    it('should handle large files', async () => {
      const filePath = '/large.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'large.txt',
          path: filePath,
          platform: 'web',
          size: 2 * 1024 * 1024,
        } as FileSystemFileHandle,
        name: 'large.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      const expectedLargeContent = 'content of large file';
      MockFileSystemAdapter.setMockFileContent(filePath, expectedLargeContent);
      // The hook itself checks size, not the adapter, so fileContent.isTextExtension needs to be true
      vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(expectedLargeContent);
    });

    it('should handle absolute paths for electron platform', async () => {
      const absolutePath = '/Users/test/project/src/main.tsx';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'main.tsx',
          path: absolutePath,
          platform: 'electron',
        } as FileSystemFileHandle,
        name: 'main.tsx',
        path: absolutePath, // Absolute path for Electron
        rootFolderId: TestFolderId,
      });
      const expectedContent = 'electron file content';
      MockFileSystemAdapter.setMockFileContent(absolutePath, expectedContent);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(absolutePath);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(expectedContent);
    });

    it('passes platform information to the adapter', async () => {
      const filePath = '/platform.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'platform.txt',
          path: filePath,
          platform: 'electron',
        } as FileSystemFileHandle,
        name: 'platform.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      // Override the fileExplorer mock to return this specific node
      fileExplorer.findNodeByPath = vi.fn(() => fileNode);
      MockFileSystemAdapter.setMockFileContent(filePath, 'platform content');
      vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);
      const readFileSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(readFileSpy).toHaveBeenCalledWith(expect.objectContaining({ platform: 'electron' }));
      readFileSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('should handle file loading errors', async () => {
      const filePath = '/error.txt';
      const errorMessage = 'Failed to load file via adapter';
      MockFileSystemAdapter.setMockReadFileError(filePath, new Error(errorMessage));

      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'error.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'error.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      // Ensure it's treated as a text file that would attempt loading
      vi.mocked(fileContent.isTextExtension).mockReturnValue(true);
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).not.toBe('test content');
      expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
    });

    it('should clear error state on subsequent successful load', async () => {
      const errorFilePath = '/error-then-success.txt';
      const successFilePath = '/success-after-error.txt';
      const errorFileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'error-then-success.txt',
          path: errorFilePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'error-then-success.txt',
        path: errorFilePath,
        rootFolderId: TestFolderId,
      });
      const successFileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'success-after-error.txt',
          path: successFilePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'success-after-error.txt',
        path: successFilePath,
        rootFolderId: TestFolderId,
      });

      const errorMessage = 'Initial load error';
      MockFileSystemAdapter.setMockReadFileError(errorFilePath, new Error(errorMessage));
      const successContent = 'Successfully loaded content';
      MockFileSystemAdapter.setMockFileContent(successFilePath, successContent);

      // Ensure both are treated as text files
      vi.mocked(fileContent.isTextExtension).mockImplementation((extensionOrFileName: string) => {
        // Basic mock, adjust if more specific logic is needed for different extensions
        if (typeof extensionOrFileName === 'string') {
          return extensionOrFileName.endsWith('.txt');
        }
        return false;
      });
      vi.mocked(fileContent.isBinaryExtension).mockReturnValue(false);

      const { result, rerender } = renderUseFileContentLoadingHook([
        errorFileNode,
        successFileNode,
      ]);
      const errorCompositeKey = getCompositeKey(errorFilePath);
      const successCompositeKey = getCompositeKey(successFilePath);

      // First, load the file that will cause an error
      await act(async () => {
        result.current.handleFileContentLoading([errorCompositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[errorCompositeKey]).toBe('Error accessing file');

      // Then, load a different file successfully
      await act(async () => {
        result.current.handleFileContentLoading([successCompositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      // After successful load of a *different* file:
      // The global error state should be null (or remain null)
      expect(result.current.error).toBeNull();
      // The previously errored file should still have its error message in fileContents
      expect(result.current.fileContents[errorCompositeKey]).toBe('Error accessing file');
      // The newly loaded file should have its content
      expect(result.current.fileContents[successCompositeKey]).toBe(successContent);
      // Loading state should be false
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('Caching Logic', () => {
    it('should use cached content for already loaded files', async () => {
      const filePath = '/cached-file.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'cached-file.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'cached-file.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      const initialContent = 'Initial content for caching test';
      MockFileSystemAdapter.setMockFileContent(filePath, initialContent);
      const readFileSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);
      // Ensure the hook considers this a text file for caching logic
      vi.mocked(fileContent.isTextExtension).mockImplementation(
        (name) => name === filePath || name.endsWith('.txt')
      );

      // First load
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(initialContent);
      expect(readFileSpy).toHaveBeenCalledTimes(1);

      // Attempt to load again
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      // Should not call readFile again, content should be from cache
      expect(result.current.fileContents[compositeKey]).toBe(initialContent);
      expect(readFileSpy).toHaveBeenCalledTimes(1); // Still 1, meaning cache was used
      readFileSpy.mockRestore();
    });

    it('should reload content after clearing cache', async () => {
      const filePath = '/force-reload.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'force-reload.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'force-reload.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      const initialContent = 'Initial content for force reload';
      const updatedContent = 'Updated content after force reload';
      MockFileSystemAdapter.setMockFileContent(filePath, initialContent);
      const readFileSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');
      // Ensure the hook considers this text file for reload logic
      vi.mocked(fileContent.isTextExtension).mockImplementation(
        (name) => name === filePath || name.endsWith('.txt')
      );

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      // First load
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(initialContent);
      expect(readFileSpy).toHaveBeenCalledTimes(1);

      // Clear the cache for this item
      act(() => {
        result.current.clearFileContents([compositeKey]);
      });
      // Rerender if necessary, though clearFileContents might trigger it
      rerender();

      // Update mock content and load again
      MockFileSystemAdapter.setMockFileContent(filePath, updatedContent);
      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey]).toBe(updatedContent);
      expect(readFileSpy).toHaveBeenCalledTimes(2); // Called again due to cache clear + reload
      readFileSpy.mockRestore();
    });
  });

  // Add more tests for multiple file loading, unsupported types, etc.
  describe('Multiple File Loading', () => {
    it('should load multiple files successfully', async () => {
      const filePath1 = '/multi1.txt';
      const filePath2 = '/multi2.txt';
      const content1 = 'Content for multi1';
      const content2 = 'Content for multi2';

      const fileNode1 = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'multi1.txt',
          path: filePath1,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'multi1.txt',
        path: filePath1,
        rootFolderId: TestFolderId,
      });
      const fileNode2 = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'multi2.txt',
          path: filePath2,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'multi2.txt',
        path: filePath2,
        rootFolderId: TestFolderId,
      });

      MockFileSystemAdapter.setMockFileContent(filePath1, content1);
      MockFileSystemAdapter.setMockFileContent(filePath2, content2);
      vi.mocked(fileContent.isTextExtension).mockReturnValue(true);

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode1, fileNode2]);
      const compositeKey1 = getCompositeKey(filePath1);
      const compositeKey2 = getCompositeKey(filePath2);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey1, compositeKey2]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[compositeKey1]).toBe(content1);
      expect(result.current.fileContents[compositeKey2]).toBe(content2);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should handle partial success when loading multiple files', async () => {
      const successPath = '/multi-success.txt';
      const errorPath = '/multi-error.txt';
      const successContentText = 'Multi success content';
      const errorMessageText = 'Multi error message';

      const successNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'multi-success.txt',
          path: successPath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'multi-success.txt',
        path: successPath,
        rootFolderId: TestFolderId,
      });
      const errorNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'multi-error.txt',
          path: errorPath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'multi-error.txt',
        path: errorPath,
        rootFolderId: TestFolderId,
      });

      MockFileSystemAdapter.setMockFileContent(successPath, successContentText);
      MockFileSystemAdapter.setMockReadFileError(errorPath, new Error(errorMessageText));
      vi.mocked(fileContent.isTextExtension).mockReturnValue(true);

      const { result, rerender } = renderUseFileContentLoadingHook([successNode, errorNode]);
      const successKey = getCompositeKey(successPath);
      const errorKey = getCompositeKey(errorPath);

      await act(async () => {
        result.current.handleFileContentLoading([successKey, errorKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(result.current.fileContents[successKey]).toBe(successContentText);
      expect(result.current.fileContents[errorKey]).toBe('Error accessing file');
      expect(result.current.isLoading).toBe(false);
      // The global error should be null as errors are handled per-file
      expect(result.current.error).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('stores error message for folder mismatch', async () => {
      const filePath = '/mismatch.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'mismatch.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'mismatch.txt',
        path: filePath,
        rootFolderId: 'other-folder-id',
      });

      const compositeKey = getCompositeKey(filePath);
      fileExplorer.findNodeByPath = vi.fn(() => fileNode);
      const readSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');
      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(readSpy).not.toHaveBeenCalled();
      expect(result.current.fileContents[compositeKey]).toBe(
        `File not accessible - Folder mismatch. Expected: ${TestFolderId}, Found: other-folder-id`
      );
    });

    it('skips loading when file tree is empty', async () => {
      const compositeKey = getCompositeKey('/missing.txt');
      const readSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');
      const { result, rerender } = renderUseFileContentLoadingHook([]);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(readSpy).not.toHaveBeenCalled();
      expect(result.current.fileContents[compositeKey]).toBeUndefined();
    });

    it('skips loading when node remains missing after retry', async () => {
      vi.mocked(fileExplorer.findNodeByPath).mockReturnValue(undefined as unknown as IFileNode);
      const compositeKey = getCompositeKey('/still-missing.txt');
      const readSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readFile');
      const dummyNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'dummy.txt',
          path: '/dummy.txt',
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'dummy.txt',
        path: '/dummy.txt',
        rootFolderId: TestFolderId,
      });
      const { result, rerender } = renderUseFileContentLoadingHook([dummyNode]);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(readSpy).not.toHaveBeenCalled();
      expect(result.current.fileContents[compositeKey]).toBeUndefined();
    });

    it('records per-file error and keeps global error null when readFile throws', async () => {
      const filePath = '/adapter-error.txt';
      const fileNode = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'adapter-error.txt',
          path: filePath,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'adapter-error.txt',
        path: filePath,
        rootFolderId: TestFolderId,
      });
      const readSpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readFile')
        .mockRejectedValue(new Error('boom'));

      const { result, rerender } = renderUseFileContentLoadingHook([fileNode]);
      const compositeKey = getCompositeKey(filePath);

      await act(async () => {
        result.current.handleFileContentLoading([compositeKey]);
        await waitForStateUpdate();
        rerender();
      });

      expect(readSpy).toHaveBeenCalled();
      expect(result.current.fileContents[compositeKey]).toBe('Error accessing file');
      expect(result.current.error).toBeNull();
    });

    it('processes files successfully regardless of concurrency strategy', async () => {
      const total = 7; // Test with multiple files
      const filePaths = Array.from({ length: total }, (_, i) => `/chunk-${i}.txt`);
      const fileNodes = filePaths.map((path) =>
        createFileNode({
          handle: {
            createWritable: vi.fn(),
            getFile: vi.fn(),
            isSameEntry: vi.fn(),
            kind: 'file',
            name: path.slice(1),
            path,
            platform: 'web',
          } as FileSystemFileHandle,
          name: path.slice(1),
          path,
          rootFolderId: TestFolderId,
        })
      );

      const compositeKeys = filePaths.map(getCompositeKey);
      let callCount = 0;

      // Mock readFile to return unique content for each file
      vi.spyOn(MockFileSystemAdapter.prototype, 'readFile').mockImplementation((handle) => {
        callCount++;
        return Promise.resolve(`content-${handle.path}`);
      });

      const { result, rerender } = renderUseFileContentLoadingHook(fileNodes);

      await act(async () => {
        result.current.handleFileContentLoading(compositeKeys);
        await waitForStateUpdate();
        rerender();
      });

      // Verify all files were processed
      expect(callCount).toBe(total);

      // Verify all files have content loaded
      for (let i = 0; i < total; i++) {
        const key = compositeKeys[i]!;
        const path = filePaths[i]!;
        expect(result.current.fileContents[key]).toBe(`content-${path}`);
      }

      // Verify loading completed
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('clearFileContents removes specified keys', async () => {
      const path1 = '/clear1.txt';
      const path2 = '/clear2.txt';
      const node1 = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'clear1.txt',
          path: path1,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'clear1.txt',
        path: path1,
        rootFolderId: TestFolderId,
      });
      const node2 = createFileNode({
        handle: {
          createWritable: vi.fn(),
          getFile: vi.fn(),
          isSameEntry: vi.fn(),
          kind: 'file',
          name: 'clear2.txt',
          path: path2,
          platform: 'web',
        } as FileSystemFileHandle,
        name: 'clear2.txt',
        path: path2,
        rootFolderId: TestFolderId,
      });
      MockFileSystemAdapter.setMockFileContent(path1, 'one');
      MockFileSystemAdapter.setMockFileContent(path2, 'two');

      const { result, rerender } = renderUseFileContentLoadingHook([node1, node2]);
      const key1 = getCompositeKey(path1);
      const key2 = getCompositeKey(path2);

      act(() => {
        result.current.fileContents[key1] = 'one';
        result.current.fileContents[key2] = 'two';
      });

      act(() => {
        result.current.clearFileContents([key1]);
      });
      rerender();

      expect(result.current.fileContents[key1]).toBeUndefined();
      expect(result.current.fileContents[key2]).toBeDefined();
    });
  });
});
