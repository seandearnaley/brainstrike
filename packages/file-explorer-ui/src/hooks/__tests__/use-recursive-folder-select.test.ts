/**
 * Tests for useRecursiveFolderSelect hook
 *
 * Tests the recursive folder selection functionality including:
 * - Fast path for fully loaded folders
 * - Lazy loading of unloaded subtrees
 * - Progress tracking
 * - Cancellation
 * - Error handling
 */

import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { FileSystemHandle } from '../../utils/worker-node-conversion';
import { useRecursiveFolderSelect } from '../use-recursive-folder-select';

// Mock utilities
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Test fixtures
function createFileNode(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    name: 'file.txt',
    path: '/root/file.txt',
    type: 'file',
    depth: 1,
    handle: {} as FileSystemFileHandle,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    ...overrides,
  };
}

function createDirectoryNode(overrides: Partial<IFileNode> = {}): IFileNode {
  return {
    name: 'dir',
    path: '/root/dir',
    type: 'directory',
    depth: 1,
    handle: {} as FileSystemDirectoryHandle,
    selectionState: 'unchecked',
    rootFolderId: 'root',
    loadState: 'unloaded',
    ...overrides,
  };
}

describe('useRecursiveFolderSelect', () => {
  let mockWorkerPort: {
    loadSubtree: Mock;
    onProgress: Mock;
    abort: Mock;
  };
  let mockHandleMap: Map<string, FileSystemHandle>;
  let mockOnTreeUpdate: Mock;
  let mockOnError: Mock;
  let mockProgressCleanup: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProgressCleanup = vi.fn();
    mockWorkerPort = {
      loadSubtree: vi.fn(),
      onProgress: vi.fn(() => mockProgressCleanup),
      abort: vi.fn(),
    };
    mockHandleMap = new Map();
    mockOnTreeUpdate = vi.fn();
    mockOnError = vi.fn();
  });

  describe('initial state', () => {
    it('should return initial state with no loading', () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      expect(result.current.isLoadingForSelection).toBe(false);
      expect(result.current.loadingPath).toBeNull();
      expect(result.current.loadingProgress).toBeNull();
    });
  });

  describe('selectFolderRecursively - validation', () => {
    it('should return error for non-directory nodes', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const fileNode = createFileNode();
      const mockAddMultipleSelectedFiles = vi.fn();

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          fileNode,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(selectionResult.success).toBe(false);
      expect(selectionResult.error).toBe('Node is not a directory');
      expect(mockAddMultipleSelectedFiles).not.toHaveBeenCalled();
    });

    it('should return error when worker is not ready', async () => {
      const workerPortRef = { current: null };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const dirNode = createDirectoryNode();
      const mockAddMultipleSelectedFiles = vi.fn();

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          dirNode,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(selectionResult.success).toBe(false);
      expect(selectionResult.error).toBe('Worker not ready');
    });

    it('should return error when handle map is not ready', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: null } as React.RefObject<Map<
        string,
        FileSystemHandle
      > | null>;

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef: handleMapRef as React.RefObject<Map<string, FileSystemHandle>>,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const dirNode = createDirectoryNode();
      const mockAddMultipleSelectedFiles = vi.fn();

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          dirNode,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(selectionResult.success).toBe(false);
      expect(selectionResult.error).toBe('Handle map not ready');
    });
  });

  describe('selectFolderRecursively - fast path', () => {
    it('should use fast path for fully loaded folders', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const fullyLoadedDir = createDirectoryNode({
        path: '/root/loaded',
        loadState: 'loaded',
        children: [
          createFileNode({ path: '/root/loaded/file1.txt' }),
          createFileNode({ path: '/root/loaded/file2.txt' }),
        ],
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          fullyLoadedDir,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(selectionResult.success).toBe(true);
      expect(selectionResult.filePaths).toHaveLength(2);
      expect(mockAddMultipleSelectedFiles).toHaveBeenCalledTimes(1);
      const calledPaths = mockAddMultipleSelectedFiles.mock.calls[0]?.[1] as string[];
      expect(calledPaths).toContain('/root/loaded/file1.txt');
      expect(calledPaths).toContain('/root/loaded/file2.txt');
      // Worker should not be called for fast path
      expect(mockWorkerPort.loadSubtree).not.toHaveBeenCalled();
    });

    it('should respect maxSelectionCount in fast path', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const fullyLoadedDir = createDirectoryNode({
        path: '/root/loaded',
        loadState: 'loaded',
        children: [
          createFileNode({ path: '/root/loaded/file1.txt' }),
          createFileNode({ path: '/root/loaded/file2.txt' }),
          createFileNode({ path: '/root/loaded/file3.txt' }),
        ],
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      // Max 2 files, already have 1 selected (so only 1 slot available)
      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          fullyLoadedDir,
          'folder-id',
          mockAddMultipleSelectedFiles,
          2, // maxSelectionCount
          1 // currentSelectionSize
        );
      });

      expect(selectionResult.success).toBe(true);
      expect(selectionResult.filePaths).toHaveLength(1);
      expect(mockAddMultipleSelectedFiles).toHaveBeenCalledTimes(1);
      // Only 1 file should be selected due to limit
      const calledPaths = mockAddMultipleSelectedFiles.mock.calls[0]?.[1] as string[];
      expect(calledPaths).toHaveLength(1);
    });

    it('should return empty filePaths for empty fully loaded folder', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const emptyLoadedDir = createDirectoryNode({
        path: '/root/empty',
        loadState: 'loaded',
        children: [],
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(
          emptyLoadedDir,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(selectionResult.success).toBe(true);
      expect(selectionResult.filePaths).toHaveLength(0);
      expect(mockAddMultipleSelectedFiles).not.toHaveBeenCalled();
    });
  });

  describe('selectFolderRecursively - lazy loading path', () => {
    it('should call worker loadSubtree for unloaded folders', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Mock successful load
      mockWorkerPort.loadSubtree.mockResolvedValue({
        tree: [
          {
            name: 'dir',
            path: '/root/dir',
            type: 'directory',
            depth: 1,
            loadState: 'loaded',
            children: [{ name: 'file.txt', path: '/root/dir/file.txt', type: 'file', depth: 2 }],
          },
        ],
        expandedPaths: ['/root/dir'],
        loadedCount: 1,
      });

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      await act(async () => {
        await result.current.selectFolderRecursively(
          unloadedDir,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(mockWorkerPort.loadSubtree).toHaveBeenCalledWith('/root/dir');
      expect(mockOnTreeUpdate).toHaveBeenCalled();
    });

    it('should set loading state during subtree load', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Create a promise that doesn't resolve immediately
      let resolveLoad: (value: unknown) => void;
      const loadPromise = new Promise((resolve) => {
        resolveLoad = resolve;
      });
      mockWorkerPort.loadSubtree.mockReturnValue(loadPromise);

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      // Start selection (don't await)
      let selectionPromise: Promise<unknown>;
      act(() => {
        selectionPromise = result.current.selectFolderRecursively(
          unloadedDir,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      // Wait for loading state to be set
      await waitFor(() => {
        expect(result.current.isLoadingForSelection).toBe(true);
        expect(result.current.loadingPath).toBe('/root/dir');
      });

      // Resolve the load
      act(() => {
        resolveLoad!({
          tree: [],
          expandedPaths: [],
          loadedCount: 0,
        });
      });

      await act(async () => {
        await selectionPromise!;
      });

      // Loading state should be cleared
      expect(result.current.isLoadingForSelection).toBe(false);
      expect(result.current.loadingPath).toBeNull();
    });

    it('should register and cleanup progress handler', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      mockWorkerPort.loadSubtree.mockResolvedValue({
        tree: [],
        expandedPaths: [],
        loadedCount: 0,
      });

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      await act(async () => {
        await result.current.selectFolderRecursively(unloadedDir, 'folder-id', vi.fn(), 10, 0);
      });

      expect(mockWorkerPort.onProgress).toHaveBeenCalled();
      expect(mockProgressCleanup).toHaveBeenCalled();
    });
  });

  describe('cancelRecursiveSelect', () => {
    it('should abort worker and reset state', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      act(() => {
        result.current.cancelRecursiveSelect();
      });

      expect(mockWorkerPort.abort).toHaveBeenCalled();
      expect(result.current.isLoadingForSelection).toBe(false);
      expect(result.current.loadingPath).toBeNull();
      expect(result.current.loadingProgress).toBeNull();
    });
  });

  describe('double-click guard', () => {
    it('should prevent concurrent selection operations', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Create a promise that doesn't resolve immediately
      let resolveLoad: (value: unknown) => void;
      const loadPromise = new Promise((resolve) => {
        resolveLoad = resolve;
      });
      mockWorkerPort.loadSubtree.mockReturnValue(loadPromise);

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      // Start first selection
      let firstPromise: Promise<unknown>;
      act(() => {
        firstPromise = result.current.selectFolderRecursively(
          unloadedDir,
          'folder-id',
          vi.fn(),
          10,
          0
        );
      });

      // Try to start second selection while first is in progress
      let secondResult: Awaited<ReturnType<typeof result.current.selectFolderRecursively>>;
      await act(async () => {
        secondResult = await result.current.selectFolderRecursively(
          unloadedDir,
          'folder-id',
          vi.fn(),
          10,
          0
        );
      });

      // Second call should be blocked
      expect(secondResult!.success).toBe(false);
      expect(secondResult!.error).toBe('Operation already in progress');

      // Resolve the first operation
      act(() => {
        resolveLoad!({
          tree: [],
          expandedPaths: [],
          loadedCount: 0,
        });
      });

      await act(async () => {
        await firstPromise!;
      });
    });
  });

  describe('error handling', () => {
    it('should call onError callback when loading fails', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const testError = new Error('Load failed');
      mockWorkerPort.loadSubtree.mockRejectedValue(testError);

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(unloadedDir, 'folder-id', vi.fn(), 10, 0);
      });

      expect(selectionResult.success).toBe(false);
      expect(selectionResult.error).toBe('Load failed');
      expect(mockOnError).toHaveBeenCalledWith(testError);
    });

    it('should not call onError for abort errors', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Simulate an abort error (name is 'AbortError')
      const abortError = new DOMException('Operation aborted', 'AbortError');
      mockWorkerPort.loadSubtree.mockRejectedValue(abortError);

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const unloadedDir = createDirectoryNode({
        path: '/root/dir',
        loadState: 'unloaded',
      });

      const selectionResult = await act(async () => {
        return result.current.selectFolderRecursively(unloadedDir, 'folder-id', vi.fn(), 10, 0);
      });

      expect(selectionResult.success).toBe(false);
      expect(selectionResult.cancelled).toBe(true);
      expect(mockOnError).not.toHaveBeenCalled();
    });
  });

  describe('isFolderFullyLoaded helper', () => {
    it('should detect fully loaded folders correctly', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      // Folder with all descendants loaded
      const fullyLoadedFolder = createDirectoryNode({
        path: '/root/parent',
        loadState: 'loaded',
        children: [
          createFileNode({ path: '/root/parent/file.txt' }),
          createDirectoryNode({
            path: '/root/parent/child',
            loadState: 'loaded',
            children: [createFileNode({ path: '/root/parent/child/file2.txt' })],
          }),
        ],
      });

      const mockAddMultipleSelectedFiles = vi.fn();

      // Should use fast path (no worker call)
      await act(async () => {
        await result.current.selectFolderRecursively(
          fullyLoadedFolder,
          'folder-id',
          mockAddMultipleSelectedFiles,
          10,
          0
        );
      });

      expect(mockWorkerPort.loadSubtree).not.toHaveBeenCalled();
    });

    it('should detect partially loaded folders correctly', async () => {
      const workerPortRef = { current: mockWorkerPort as unknown as FileTreeWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      mockWorkerPort.loadSubtree.mockResolvedValue({
        tree: [],
        expandedPaths: [],
        loadedCount: 0,
      });

      const { result } = renderHook(() =>
        useRecursiveFolderSelect({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      // Folder with an unloaded child directory
      const partiallyLoadedFolder = createDirectoryNode({
        path: '/root/parent',
        loadState: 'loaded',
        children: [
          createFileNode({ path: '/root/parent/file.txt' }),
          createDirectoryNode({
            path: '/root/parent/child',
            loadState: 'unloaded', // Not loaded
          }),
        ],
      });

      await act(async () => {
        await result.current.selectFolderRecursively(
          partiallyLoadedFolder,
          'folder-id',
          vi.fn(),
          10,
          0
        );
      });

      // Should call worker to load the unloaded child
      expect(mockWorkerPort.loadSubtree).toHaveBeenCalled();
    });
  });
});
