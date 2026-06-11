import type { DirectoryHandle } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { PartialRefreshError } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTree } from '../use-file-tree';
import { AdaptersTestWrapper, MockFileSystemAdapter } from './test-helpers';

// Logger mock type for test purposes - uses generic Mock for variadic logging functions
type LogFn = Mock<(...args: unknown[]) => void>;
interface MockLogger {
  debug: LogFn;
  error: LogFn;
  fatal: LogFn;
  info: LogFn;
  trace: LogFn;
  warn: LogFn;
}

const loggerMock = vi.hoisted<MockLogger>(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: vi.fn(() => loggerMock),
  };
});

const createLoggerMock = vi.mocked(createLogger);

describe('useFileTree', () => {
  let mockDirectoryHandle: DirectoryHandle;

  beforeEach(() => {
    // Clear any previous mock data
    MockFileSystemAdapter.clearMockData();
    loggerMock.error.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.info.mockReset();
    loggerMock.debug.mockReset();
    createLoggerMock.mockReturnValue(loggerMock);

    mockDirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: 'root',
      platform: 'web',
    };
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useFileTree(null), { wrapper: AdaptersTestWrapper });

    expect(result.current.fileTree).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('rootFolderId stamping (storage v5)', () => {
    const seedRootWithOneFile = () => {
      MockFileSystemAdapter.setMockDirectoryData('root', [
        {
          name: 'file.ts',
          path: 'root/file.ts',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'adapter-supplied',
        },
      ]);
    };

    it('stamps nodes with options.rootFolderId when provided', async () => {
      seedRootWithOneFile();

      const { result } = renderHook(
        () => useFileTree(mockDirectoryHandle, { rootFolderId: 'root-uuid-1234' }),
        { wrapper: AdaptersTestWrapper }
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));

      expect(result.current.fileTree[0]?.rootFolderId).toBe('root-uuid-1234');
    });

    it('defaults node rootFolderId to the root handle path when no option is provided', async () => {
      seedRootWithOneFile();

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));

      expect(result.current.fileTree[0]?.rootFolderId).toBe('root');
    });
  });

  describe('Partial Refresh Scenarios', () => {
    it('should throw PartialRefreshError when some subdirectories fail to load', async () => {
      // Create a structure with files and subdirectories
      const mockSuccessFile: IFileNode = {
        name: 'success.txt',
        path: 'root/success.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        size: 100,
      };

      const mockSuccessDir: IFileNode = {
        name: 'success-dir',
        path: 'root/success-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailDir: IFileNode = {
        name: 'fail-dir',
        path: 'root/fail-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      // Setup root directory with mixed content
      MockFileSystemAdapter.setMockDirectoryData('root', [
        mockSuccessFile,
        mockSuccessDir,
        mockFailDir,
      ]);

      // Success directory has some files (hook will call with just the directory name)
      MockFileSystemAdapter.setMockDirectoryData('success-dir', [
        {
          name: 'nested.txt',
          path: 'root/success-dir/nested.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 2,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ]);

      // Fail directory will throw an error when accessed (hook will call with just the directory name)
      MockFileSystemAdapter.setMockDirectoryError('fail-dir', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBeGreaterThan(0);
        expect(error.failCount).toBeGreaterThan(0);
      }
    });

    it('should throw regular Error when all subdirectories fail to load', async () => {
      // Create directories that will all fail
      const mockFailDir1: IFileNode = {
        name: 'fail-dir1',
        path: 'root/fail-dir1',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailDir2: IFileNode = {
        name: 'fail-dir2',
        path: 'root/fail-dir2',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockFailDir1, mockFailDir2]);

      // Make both directories fail (hook will call with just directory names)
      MockFileSystemAdapter.setMockDirectoryError('fail-dir1', new Error('Access denied'));
      MockFileSystemAdapter.setMockDirectoryError('fail-dir2', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PartialRefreshError);
      if (error instanceof Error) {
        expect(error.message).toMatch(/Failed to refresh file tree/);
      }
    });

    it('should handle nested directory partial failures', async () => {
      // Create a complex nested structure
      const mockRootFile: IFileNode = {
        name: 'root.txt',
        path: 'root/root.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      const mockParentDir: IFileNode = {
        name: 'parent',
        path: 'root/parent',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockSuccessNestedDir: IFileNode = {
        name: 'success-nested',
        path: 'root/parent/success-nested',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFailNestedDir: IFileNode = {
        name: 'fail-nested',
        path: 'root/parent/fail-nested',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      // Setup directory structure (hook will call with full paths for nested dirs)
      MockFileSystemAdapter.setMockDirectoryData('root', [mockRootFile, mockParentDir]);
      MockFileSystemAdapter.setMockDirectoryData('parent', [
        mockSuccessNestedDir,
        mockFailNestedDir,
      ]);
      MockFileSystemAdapter.setMockDirectoryData('parent/success-nested', [
        {
          name: 'deep.txt',
          path: 'root/parent/success-nested/deep.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 3,
          selectionState: 'unchecked',
          rootFolderId: 'root',
        },
      ]);

      // Make one nested directory fail (hook will call with full path for nested dirs)
      MockFileSystemAdapter.setMockDirectoryError('parent/fail-nested', new Error('Access denied'));

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Attempt refresh and expect it to throw
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      if (error instanceof PartialRefreshError) {
        expect(error.successCount).toBeGreaterThan(0);
        expect(error.failCount).toBeGreaterThan(0);
      }
    });

    it('should maintain file tree state after partial refresh', async () => {
      // Setup initial successful structure
      const mockSuccessFile: IFileNode = {
        name: 'success.txt',
        path: 'root/success.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      const mockSuccessDir: IFileNode = {
        name: 'success-dir',
        path: 'root/success-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockSuccessFile, mockSuccessDir]);
      MockFileSystemAdapter.setMockDirectoryData('success-dir', []);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Add a failing directory for refresh
      const mockFailDir: IFileNode = {
        name: 'fail-dir',
        path: 'root/fail-dir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [
        mockSuccessFile,
        mockSuccessDir,
        mockFailDir,
      ]);
      MockFileSystemAdapter.setMockDirectoryError('fail-dir', new Error('Access denied'));

      // Attempt refresh
      let error: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (e) {
          error = e;
        }
      });

      expect(error).toBeInstanceOf(PartialRefreshError);
      // Verify tree still contains successful files/directories
      expect(result.current.fileTree.length).toBeGreaterThan(0);
      const fileNames = result.current.fileTree.map((node) => node.name);
      expect(fileNames).toContain('success.txt');
    });
  });

  describe('Basic functionality', () => {
    it('should load a simple file tree successfully', async () => {
      const mockFile: IFileNode = {
        name: 'test.txt',
        path: 'root/test.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      MockFileSystemAdapter.setMockDirectoryData('root', [mockFile]);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.fileTree).toHaveLength(1);
      expect(result.current.fileTree[0]?.name).toBe('test.txt');
      expect(result.current.error).toBeNull();
    });

    it('should sort subdirectory children correctly', async () => {
      // Create a directory with mixed files and subdirectories in unsorted order
      const mockParentDir: IFileNode = {
        name: 'parent',
        path: 'root/parent',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 1,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      // Create subdirectory children in intentionally unsorted order
      const mockSubDirZ: IFileNode = {
        name: 'z-subdir',
        path: 'root/parent/z-subdir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFileY: IFileNode = {
        name: 'y-file.txt',
        path: 'root/parent/y-file.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      const mockSubDirA: IFileNode = {
        name: 'a-subdir',
        path: 'root/parent/a-subdir',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [],
      };

      const mockFileB: IFileNode = {
        name: 'b-file.txt',
        path: 'root/parent/b-file.txt',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 2,
        selectionState: 'unchecked',
        rootFolderId: 'root',
      };

      // Setup directory structure with intentionally unsorted children
      MockFileSystemAdapter.setMockDirectoryData('root', [mockParentDir]);
      MockFileSystemAdapter.setMockDirectoryData('parent', [
        mockFileY,
        mockSubDirZ,
        mockFileB,
        mockSubDirA,
      ]);
      MockFileSystemAdapter.setMockDirectoryData('parent/a-subdir', []);
      MockFileSystemAdapter.setMockDirectoryData('parent/z-subdir', []);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.fileTree).toHaveLength(1);
      const parentNode = result.current.fileTree[0];
      expect(parentNode?.name).toBe('parent');
      expect(parentNode?.children).toHaveLength(4);

      // Verify that children are sorted: directories first, then files, alphabetically within each type
      const children = parentNode?.children;
      expect(children?.[0]?.name).toBe('a-subdir');
      expect(children?.[0]?.type).toBe('directory');
      expect(children?.[1]?.name).toBe('z-subdir');
      expect(children?.[1]?.type).toBe('directory');
      expect(children?.[2]?.name).toBe('b-file.txt');
      expect(children?.[2]?.type).toBe('file');
      expect(children?.[3]?.name).toBe('y-file.txt');
      expect(children?.[3]?.type).toBe('file');
    });

    it('accepts batchSize option without errors', async () => {
      MockFileSystemAdapter.setMockDirectoryData('root', []);
      vi.useFakeTimers();
      const { result } = renderHook(() => useFileTree(mockDirectoryHandle, { batchSize: 2 }), {
        wrapper: AdaptersTestWrapper,
      });
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
      });
      expect(result.current.fileTree).toEqual([]);
      vi.useRealTimers();
    });
  });

  describe('Lifecycle behavior', () => {
    it('reloads the tree when the root directory handle changes', async () => {
      const firstHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-a',
        path: 'root-a',
        platform: 'web',
      };
      const secondHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-b',
        path: 'root-b',
        platform: 'web',
      };

      MockFileSystemAdapter.setMockDirectoryData('root-a', [
        {
          name: 'first.txt',
          path: 'root-a/first.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root-a',
        },
      ]);
      MockFileSystemAdapter.setMockDirectoryData('root-b', [
        {
          name: 'second.txt',
          path: 'root-b/second.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root-b',
        },
      ]);

      const { result, rerender } = renderHook(({ handle }) => useFileTree(handle), {
        initialProps: { handle: firstHandle },
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.fileTree[0]?.name).toBe('first.txt'));

      rerender({ handle: secondHandle });

      await waitFor(() => expect(result.current.fileTree[0]?.name).toBe('second.txt'));
    });

    it('refreshTree uses updated dependencies after rerender', async () => {
      const staleHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-old',
        path: 'root-old',
        platform: 'web',
      };
      const freshHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-new',
        path: 'root-new',
        platform: 'web',
      };

      MockFileSystemAdapter.setMockDirectoryData('root-old', [
        {
          name: 'old.txt',
          path: 'root-old/old.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root-old',
        },
      ]);
      MockFileSystemAdapter.setMockDirectoryData('root-new', [
        {
          name: 'new.txt',
          path: 'root-new/new.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root-new',
        },
      ]);

      const { result, rerender } = renderHook(({ handle }) => useFileTree(handle), {
        initialProps: { handle: staleHandle },
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.fileTree[0]?.name).toBe('old.txt'));

      MockFileSystemAdapter.setMockDirectoryError(
        'root-old',
        new Error('stale root should not be used')
      );
      rerender({ handle: freshHandle });

      await waitFor(() => expect(result.current.fileTree[0]?.name).toBe('new.txt'));

      MockFileSystemAdapter.setMockDirectoryData('root-new', [
        {
          name: 'newer.txt',
          path: 'root-new/newer.txt',
          type: 'file',
          handle: {} as FileSystemFileHandle,
          depth: 1,
          selectionState: 'unchecked',
          rootFolderId: 'root-new',
        },
      ]);

      await act(async () => {
        await result.current.refreshTree();
      });

      expect(result.current.fileTree[0]?.name).toBe('newer.txt');
    });

    it('aborts any in-flight load when unmounted', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      let resolveDirectory: ((value: IFileNode[]) => void) | undefined;
      const readDirectorySpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readDirectory')
        .mockImplementation(
          () =>
            new Promise<IFileNode[]>((resolve) => {
              resolveDirectory = resolve;
            })
        );

      const { unmount } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(readDirectorySpy).toHaveBeenCalled());

      await act(async () => {
        unmount();
      });

      expect(abortSpy).toHaveBeenCalled();

      resolveDirectory?.([]);
      readDirectorySpy.mockRestore();
      abortSpy.mockRestore();
    });

    it('logs initial load failures with descriptive messaging', async () => {
      MockFileSystemAdapter.setMockDirectoryError('root', new Error('initial load failed'));

      renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() =>
        expect(loggerMock.error).toHaveBeenCalledWith(
          'Error in initial tree load:',
          expect.any(Error)
        )
      );
    });
  });

  describe('State management guarantees', () => {
    it('resets loading indicators when the root directory changes', async () => {
      const firstHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-one',
        path: 'root-one',
        platform: 'web',
      };
      const secondHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'root-two',
        path: 'root-two',
        platform: 'web',
      };

      const readQueue: Array<() => void> = [];
      const readSpy = vi.spyOn(MockFileSystemAdapter.prototype, 'readDirectory').mockImplementation(
        () =>
          new Promise<IFileNode[]>((resolve) => {
            readQueue.push(() => resolve([]));
          })
      );

      const { result, rerender } = renderHook(({ handle }) => useFileTree(handle), {
        initialProps: { handle: firstHandle },
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));

      rerender({ handle: secondHandle });

      await waitFor(() => expect(readSpy).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        const { loadingProgress } = result.current;
        expect(typeof loadingProgress.loaded).toBe('number');
        expect(['counting', 'loading']).toContain(loadingProgress.phase);
        expect(typeof loadingProgress.total).toBe('number');
      });
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        while (readQueue.length > 0) {
          readQueue.shift()?.();
          await Promise.resolve();
        }
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      readSpy.mockRestore();
    });

    it('logs refresh failures with detailed context', async () => {
      const refreshError = new Error('refresh failure');
      const readSpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readDirectory')
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(refreshError);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.refreshTree();
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('Failed to refresh file tree');
      expect(loggerMock.error).toHaveBeenCalledWith('Error loading file tree:', caught);

      readSpy.mockRestore();
    });

    it('ignores aborted refresh results', async () => {
      const initialNode = createFileNode({
        name: 'initial.txt',
        path: 'root/initial.txt',
        rootFolderId: 'root',
      });
      const abortedNode = createFileNode({
        name: 'aborted.txt',
        path: 'root/aborted.txt',
        rootFolderId: 'root',
      });
      const finalNode = createFileNode({
        name: 'final.txt',
        path: 'root/final.txt',
        rootFolderId: 'root',
      });

      const originalReadDirectory = MockFileSystemAdapter.prototype.readDirectory;
      const readQueue: Array<() => void> = [];
      const readSpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readDirectory')
        .mockImplementation(function (this: MockFileSystemAdapter, handle: DirectoryHandle) {
          return new Promise<IFileNode[]>((resolve, reject) => {
            readQueue.push(() => {
              originalReadDirectory.call(this, handle).then(resolve, reject);
            });
          });
        });

      MockFileSystemAdapter.setMockDirectoryData('root', [initialNode]);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(readQueue.length).toBeGreaterThan(0));

      await act(async () => {
        readQueue.shift()?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      MockFileSystemAdapter.setMockDirectoryData('root', [abortedNode]);

      let firstError: unknown;
      let firstRefresh: Promise<void> | undefined;
      await act(async () => {
        firstRefresh = result.current.refreshTree().catch((error) => {
          firstError = error;
        });
      });

      await waitFor(() => expect(readQueue.length).toBeGreaterThan(0));

      MockFileSystemAdapter.setMockDirectoryData('root', [finalNode]);

      let secondError: unknown;
      let secondRefresh: Promise<void> | undefined;
      await act(async () => {
        secondRefresh = result.current.refreshTree().catch((error) => {
          secondError = error;
        });
      });

      await waitFor(() => expect(readQueue.length).toBeGreaterThan(1));

      const abortedResolve = readQueue.shift();
      await act(async () => {
        abortedResolve?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await waitFor(() =>
        expect(result.current.fileTree.some((node) => node.name === 'aborted.txt')).toBe(false)
      );

      const finalResolve = readQueue.pop();
      await act(async () => {
        finalResolve?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await waitFor(() => expect(result.current.fileTree[0]?.name).toBe('final.txt'));
      await firstRefresh;
      await secondRefresh;
      expect(firstError).toBeInstanceOf(DOMException);
      if (firstError instanceof DOMException) {
        expect(firstError.name).toBe('AbortError');
        expect(firstError.message).toBe('Operation was cancelled');
      }
      expect(secondError).toBeUndefined();

      readSpy.mockRestore();
      MockFileSystemAdapter.clearMockData();
    });

    it('clears existing tree and resets progress before reloading', async () => {
      const initialNode = createFileNode({
        name: 'stale.txt',
        path: 'root/stale.txt',
        rootFolderId: 'root',
      });

      const originalReadDirectory = MockFileSystemAdapter.prototype.readDirectory;
      const readQueue: Array<() => void> = [];
      const readSpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readDirectory')
        .mockImplementation(function (this: MockFileSystemAdapter, handle: DirectoryHandle) {
          return new Promise<IFileNode[]>((resolve, reject) => {
            readQueue.push(() => {
              originalReadDirectory.call(this, handle).then(resolve, reject);
            });
          });
        });

      MockFileSystemAdapter.setMockDirectoryData('root', [initialNode]);

      const { result } = renderHook(() => useFileTree(mockDirectoryHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(readQueue.length).toBeGreaterThan(0));
      await act(async () => {
        readQueue.shift()?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.fileTree.length).toBeGreaterThan(0));

      MockFileSystemAdapter.setMockDirectoryData('root', [initialNode]);

      let refreshPromise: Promise<void> | undefined;
      await act(async () => {
        refreshPromise = result.current.refreshTree();
      });

      await waitFor(() => expect(result.current.fileTree).toEqual([]));
      await waitFor(() => expect(result.current.loadingProgress.loaded).toBe(0));
      expect(result.current.loadingProgress.currentPath ?? '').toBe('');

      await act(async () => {
        readQueue.shift()?.();
        await Promise.resolve();
      });
      if (!refreshPromise) {
        throw new Error('Expected refreshPromise to be defined');
      }
      await refreshPromise;

      readSpy.mockRestore();
      MockFileSystemAdapter.clearMockData();
    });

    it('initial load transitions progress phase to loading', async () => {
      const firstHandle: DirectoryHandle = {
        kind: 'directory',
        name: 'phase-root',
        path: 'phase-root',
        platform: 'web',
      };

      const originalReadDirectory = MockFileSystemAdapter.prototype.readDirectory;
      const readQueue: Array<() => void> = [];
      const readSpy = vi
        .spyOn(MockFileSystemAdapter.prototype, 'readDirectory')
        .mockImplementation(function (this: MockFileSystemAdapter, handle: DirectoryHandle) {
          return new Promise<IFileNode[]>((resolve, reject) => {
            readQueue.push(() => {
              originalReadDirectory.call(this, handle).then(resolve, reject);
            });
          });
        });

      MockFileSystemAdapter.setMockDirectoryData('phase-root', []);

      const { result } = renderHook(() => useFileTree(firstHandle), {
        wrapper: AdaptersTestWrapper,
      });

      await waitFor(() => expect(readQueue.length).toBeGreaterThan(0));
      expect(result.current.isLoading).toBe(true);
      expect(result.current.loadingProgress.phase).toBe('loading');
      expect(result.current.loadingProgress.loaded).toBe(0);

      await act(async () => {
        readQueue.shift()?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      readSpy.mockRestore();
      MockFileSystemAdapter.clearMockData();
    });
  });

  it('creates a logger scoped to useFileTree', () => {
    expect(createLoggerMock).toHaveBeenCalledWith('useFileTree');
  });
});
