/**
 * Tests for useExpandAll hook
 *
 * Covers the expand-all functionality, rehydration optimization, and error handling.
 */

import type { FileTreeWorkerPort } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExpandAll } from '../../hooks/use-expand-all';
import type { FileSystemHandle } from '../../utils/worker-node-conversion';

// Mock logger
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...original,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Helper to create a mock worker port
function createMockWorkerPort(overrides: Partial<FileTreeWorkerPort> = {}): FileTreeWorkerPort {
  return {
    init: vi.fn(),
    expandAll: vi.fn().mockResolvedValue({ tree: [], expandedPaths: [], loadedCount: 0 }),
    loadPaths: vi.fn().mockResolvedValue({ tree: [], expandedPaths: [], loadedCount: 0 }),
    loadSubtree: vi.fn().mockResolvedValue({ tree: [], filePaths: [], loadedCount: 0 }),
    collapseAll: vi.fn(),
    abort: vi.fn(),
    updateTree: vi.fn(),
    sendLoadResult: vi.fn(),
    sendLoadError: vi.fn(),
    onRequestLoad: vi.fn(() => vi.fn()),
    onProgress: vi.fn(() => vi.fn()),
    onTreeSnapshot: vi.fn(() => vi.fn()),
    onError: vi.fn(() => vi.fn()),
    onLog: vi.fn(() => vi.fn()),
    onFlattenedResult: vi.fn(() => vi.fn()),
    flattenTree: vi.fn(),
    isReady: vi.fn(() => true),
    terminate: vi.fn(),
    ...overrides,
  };
}

describe('useExpandAll', () => {
  let mockWorkerPort: FileTreeWorkerPort;
  let mockHandleMap: Map<string, FileSystemHandle>;
  let mockOnTreeUpdate: (tree: IFileNode[]) => void;
  let mockOnError: (error: Error) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkerPort = createMockWorkerPort();
    mockHandleMap = new Map<string, FileSystemHandle>();
    mockOnTreeUpdate = vi.fn<(tree: IFileNode[]) => void>();
    mockOnError = vi.fn<(error: Error) => void>();
  });

  it('should initialize with isExpandingAll=false', () => {
    const workerPortRef = { current: mockWorkerPort };
    const handleMapRef = { current: mockHandleMap };

    const { result } = renderHook(() =>
      useExpandAll({
        workerPortRef,
        handleMapRef,
        rootFolderId: 'test-root',
        onTreeUpdate: mockOnTreeUpdate,
        onError: mockOnError,
      })
    );

    expect(result.current.isExpandingAll).toBe(false);
  });

  it('should set isExpandingAll=true during operation', async () => {
    const workerPortRef = { current: mockWorkerPort };
    const handleMapRef = { current: mockHandleMap };

    // Make expandAll return a promise that we can control
    let resolveExpandAll: (value: {
      tree: never[];
      expandedPaths: never[];
      loadedCount: number;
    }) => void;
    const expandAllPromise = new Promise<{
      tree: never[];
      expandedPaths: never[];
      loadedCount: number;
    }>((resolve) => {
      resolveExpandAll = resolve;
    });
    mockWorkerPort.expandAll = vi.fn().mockReturnValue(expandAllPromise);

    const { result } = renderHook(() =>
      useExpandAll({
        workerPortRef,
        handleMapRef,
        rootFolderId: 'test-root',
        onTreeUpdate: mockOnTreeUpdate,
        onError: mockOnError,
      })
    );

    const setExpandedPaths = vi.fn();

    // Start the expand-all operation
    let expandPromise: Promise<void>;
    await act(async () => {
      expandPromise = result.current.expandAllProgressively(setExpandedPaths);
    });

    // Should be expanding now
    expect(result.current.isExpandingAll).toBe(true);

    // Resolve the promise
    await act(async () => {
      resolveExpandAll!({ tree: [], expandedPaths: [], loadedCount: 0 });
      await expandPromise!;
    });

    // Should be done
    expect(result.current.isExpandingAll).toBe(false);
  });

  describe('rehydration optimization', () => {
    it('should skip rehydration when loadedCount=0 (all cached)', async () => {
      const workerPortRef = { current: mockWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Return loadedCount=0 to indicate all directories were cached
      mockWorkerPort.expandAll = vi.fn().mockResolvedValue({
        tree: [{ name: 'test', path: '/test', type: 'directory' }],
        expandedPaths: ['/test'],
        loadedCount: 0, // KEY: No directories were actually loaded
      });

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // onTreeUpdate should NOT be called when loadedCount=0
      // because we skip rehydration entirely
      expect(mockOnTreeUpdate).not.toHaveBeenCalled();

      // But setExpandedPaths should be called with the expanded paths
      expect(setExpandedPaths).toHaveBeenCalled();
    });

    it('should call onTreeUpdate when loadedCount > 0 (directories loaded)', async () => {
      const workerPortRef = { current: mockWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Return loadedCount > 0 to indicate directories were loaded
      mockWorkerPort.expandAll = vi.fn().mockResolvedValue({
        tree: [{ name: 'test', path: '/test', type: 'directory' }],
        expandedPaths: ['/test'],
        loadedCount: 5, // Directories were loaded, need rehydration
      });

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // onTreeUpdate SHOULD be called when loadedCount > 0
      expect(mockOnTreeUpdate).toHaveBeenCalled();

      // setExpandedPaths should also be called
      expect(setExpandedPaths).toHaveBeenCalled();
    });
  });

  it('should cancel expand-all via cancelExpandAll', async () => {
    const workerPortRef = { current: mockWorkerPort };
    const handleMapRef = { current: mockHandleMap };

    const { result } = renderHook(() =>
      useExpandAll({
        workerPortRef,
        handleMapRef,
        rootFolderId: 'test-root',
        onTreeUpdate: mockOnTreeUpdate,
        onError: mockOnError,
      })
    );

    await act(async () => {
      result.current.cancelExpandAll();
    });

    expect(mockWorkerPort.abort).toHaveBeenCalled();
    expect(result.current.isExpandingAll).toBe(false);
  });

  it('should prevent double-clicks from starting multiple operations', async () => {
    const workerPortRef = { current: mockWorkerPort };
    const handleMapRef = { current: mockHandleMap };

    // Make expandAll never resolve to keep isExpandingAll=true
    mockWorkerPort.expandAll = vi.fn().mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() =>
      useExpandAll({
        workerPortRef,
        handleMapRef,
        rootFolderId: 'test-root',
        onTreeUpdate: mockOnTreeUpdate,
        onError: mockOnError,
      })
    );

    const setExpandedPaths = vi.fn();

    // Start first expand-all
    await act(async () => {
      result.current.expandAllProgressively(setExpandedPaths);
    });

    // Try to start second expand-all (should be blocked)
    await act(async () => {
      result.current.expandAllProgressively(setExpandedPaths);
    });

    // expandAll should only be called once
    expect(mockWorkerPort.expandAll).toHaveBeenCalledTimes(1);
  });

  describe('error handling', () => {
    it('should call onError callback when expandAll throws an error', async () => {
      const workerPortRef = { current: mockWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      const testError = new Error('Test expand-all error');
      mockWorkerPort.expandAll = vi.fn().mockRejectedValue(testError);

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // onError should be called with the error
      expect(mockOnError).toHaveBeenCalledWith(testError);
      // isExpandingAll should be reset to false
      expect(result.current.isExpandingAll).toBe(false);
    });

    it('should convert non-Error exceptions to Error objects', async () => {
      const workerPortRef = { current: mockWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Throw a string instead of an Error
      mockWorkerPort.expandAll = vi.fn().mockRejectedValue('string error');

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // onError should be called with an Error object
      expect(mockOnError).toHaveBeenCalledWith(expect.any(Error));
      const errorArg = (mockOnError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | Error
        | undefined;
      expect(errorArg?.message).toBe('string error');
    });

    it('should not call onError for AbortError (user cancellation)', async () => {
      const workerPortRef = { current: mockWorkerPort };
      const handleMapRef = { current: mockHandleMap };

      // Create an AbortError
      const abortError = new DOMException('Operation aborted', 'AbortError');
      mockWorkerPort.expandAll = vi.fn().mockRejectedValue(abortError);

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // onError should NOT be called for abort errors
      expect(mockOnError).not.toHaveBeenCalled();
      // isExpandingAll should still be reset to false
      expect(result.current.isExpandingAll).toBe(false);
    });
  });

  describe('worker port null handling', () => {
    it('should skip expand-all when worker port is null', async () => {
      const workerPortRef = { current: null };
      const handleMapRef = { current: mockHandleMap };

      const { result } = renderHook(() =>
        useExpandAll({
          workerPortRef,
          handleMapRef,
          rootFolderId: 'test-root',
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const setExpandedPaths = vi.fn();

      await act(async () => {
        await result.current.expandAllProgressively(setExpandedPaths);
      });

      // Nothing should happen when worker port is null
      expect(setExpandedPaths).not.toHaveBeenCalled();
      expect(mockOnTreeUpdate).not.toHaveBeenCalled();
      expect(result.current.isExpandingAll).toBe(false);
    });
  });
});
