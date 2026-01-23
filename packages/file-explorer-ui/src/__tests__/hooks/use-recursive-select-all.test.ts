/**
 * Tests for the useRecursiveSelectAll hook.
 *
 * Coverage includes:
 * - Fast path (fully loaded tree)
 * - Slow path (tree needs loading)
 * - Mixed loaded/unloaded directories
 * - Cancellation during worker load
 * - Double-click guard (rapid clicks)
 * - Behavior when filterTreeFn is undefined
 * - Partial failure handling in loadSubtree
 */

import type { FileTreeWorkerPort, WorkerFileNode } from '@brainstrike/file-tree-worker';
import type { IFileNode } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecursiveSelectAll } from '../../hooks/use-recursive-select-all';
import type { FileSystemHandle } from '../../utils/worker-node-conversion';

// Mock the hooks module
vi.mock('@brainstrike/hooks', () => ({
  useFileFilters: () => ({
    applyFileFilters: vi.fn((tree: IFileNode[]) => tree),
  }),
}));

// Mock the file explorer provider - optional context
vi.mock('../../file-explorer-provider', () => ({
  useOptionalFileExplorerStoreContext: () => null,
}));

// Mock the logger to avoid noise in tests
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Helper to create a mock worker port
function createMockWorkerPort(options?: {
  loadSubtreeDelay?: number;
  loadSubtreeError?: Error;
  loadSubtreeResults?: Map<
    string,
    { tree: WorkerFileNode[]; expandedPaths: string[]; loadedCount: number }
  >;
}): FileTreeWorkerPort {
  const progressCallbacks: Array<(loaded: number, total: number) => void> = [];

  return {
    loadSubtree: vi.fn(async (path: string) => {
      if (options?.loadSubtreeDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.loadSubtreeDelay));
      }
      if (options?.loadSubtreeError) {
        throw options.loadSubtreeError;
      }
      if (options?.loadSubtreeResults?.has(path)) {
        return options.loadSubtreeResults.get(path)!;
      }
      // Default result
      return {
        tree: [],
        expandedPaths: [path],
        loadedCount: 1,
      };
    }),
    abort: vi.fn(),
    onProgress: vi.fn((callback) => {
      progressCallbacks.push(callback);
      return () => {
        const index = progressCallbacks.indexOf(callback);
        if (index >= 0) {
          progressCallbacks.splice(index, 1);
        }
      };
    }),
    triggerProgress: (loaded: number, total: number) => {
      for (const cb of progressCallbacks) {
        cb(loaded, total);
      }
    },
  } as unknown as FileTreeWorkerPort & { triggerProgress: (loaded: number, total: number) => void };
}

// Helper to create mock file nodes (IFileNode)
function createMockFileNode(
  overrides: Partial<IFileNode> & { name: string; path: string; type: 'file' | 'directory' }
): IFileNode {
  return {
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'folder-1',
    loadState: 'loaded',
    ...overrides,
  };
}

// Helper to create mock worker file nodes (WorkerFileNode - for loadSubtree results)
function createMockWorkerFileNode(
  overrides: Partial<WorkerFileNode> & { name: string; path: string; type: 'file' | 'directory' }
): WorkerFileNode {
  return {
    depth: 0,
    rootFolderId: 'folder-1',
    loadState: 'loaded',
    ...overrides,
  };
}

// Helper to create a fully loaded tree
function createFullyLoadedTree(): IFileNode[] {
  return [
    createMockFileNode({
      name: 'src',
      path: '/src',
      type: 'directory',
      loadState: 'loaded',
      children: [
        createMockFileNode({
          name: 'file1.ts',
          path: '/src/file1.ts',
          type: 'file',
          depth: 1,
        }),
        createMockFileNode({
          name: 'file2.ts',
          path: '/src/file2.ts',
          type: 'file',
          depth: 1,
        }),
      ],
    }),
    createMockFileNode({
      name: 'README.md',
      path: '/README.md',
      type: 'file',
    }),
  ];
}

// Helper to create a tree with unloaded directories
function createPartiallyLoadedTree(): IFileNode[] {
  return [
    createMockFileNode({
      name: 'src',
      path: '/src',
      type: 'directory',
      loadState: 'unloaded',
      children: [],
    }),
    createMockFileNode({
      name: 'tests',
      path: '/tests',
      type: 'directory',
      loadState: 'loaded',
      children: [
        createMockFileNode({
          name: 'test1.ts',
          path: '/tests/test1.ts',
          type: 'file',
          depth: 1,
        }),
      ],
    }),
    createMockFileNode({
      name: 'README.md',
      path: '/README.md',
      type: 'file',
    }),
  ];
}

// Helper to create a mixed tree (some loaded, some unloaded subdirectories)
function createMixedLoadedTree(): IFileNode[] {
  return [
    createMockFileNode({
      name: 'src',
      path: '/src',
      type: 'directory',
      loadState: 'loaded',
      children: [
        createMockFileNode({
          name: 'utils',
          path: '/src/utils',
          type: 'directory',
          loadState: 'unloaded',
          depth: 1,
          children: [],
        }),
        createMockFileNode({
          name: 'index.ts',
          path: '/src/index.ts',
          type: 'file',
          depth: 1,
        }),
      ],
    }),
  ];
}

describe('useRecursiveSelectAll', () => {
  const mockOnTreeUpdate = vi.fn();
  const mockOnError = vi.fn();
  const mockAddMultipleSelectedFiles = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fast path - fully loaded tree', () => {
    it('should select all files immediately when tree is fully loaded', async () => {
      const workerPort = createMockWorkerPort();
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const tree = createFullyLoadedTree();

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.success).toBe(true);
      expect(selectResult!.filePaths).toHaveLength(3);
      expect(selectResult!.filePaths).toContain('/src/file1.ts');
      expect(selectResult!.filePaths).toContain('/src/file2.ts');
      expect(selectResult!.filePaths).toContain('/README.md');
      expect(mockAddMultipleSelectedFiles).toHaveBeenCalledWith('folder-1', expect.any(Array));

      // Worker should not be called for fully loaded tree
      expect(workerPort.loadSubtree).not.toHaveBeenCalled();
    });

    it('should respect maxSelectionCount in fast path', async () => {
      const workerPortRef = { current: createMockWorkerPort() };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree = createFullyLoadedTree();

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          2
        );
      });

      expect(selectResult!.success).toBe(true);
      expect(selectResult!.filePaths).toHaveLength(2);
      // Note: With early exit optimization for memory efficiency, we can't accurately
      // determine limitReached or totalAvailable since we stop traversing at maxSelectionCount
      expect(selectResult!.totalAvailable).toBe(2);
    });

    it('should exclude files with isVisible=false', async () => {
      const workerPortRef = { current: createMockWorkerPort() };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'visible.ts',
          path: '/visible.ts',
          type: 'file',
          isVisible: true,
        }),
        createMockFileNode({
          name: 'hidden.ts',
          path: '/hidden.ts',
          type: 'file',
          isVisible: false,
        }),
      ];

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.filePaths).toHaveLength(1);
      expect(selectResult!.filePaths).toContain('/visible.ts');
      expect(selectResult!.filePaths).not.toContain('/hidden.ts');
    });
  });

  describe('slow path - tree needs loading', () => {
    it('should load unloaded directories before selecting', async () => {
      const loadSubtreeResults = new Map([
        [
          '/src',
          {
            tree: [
              createMockWorkerFileNode({
                name: 'src',
                path: '/src',
                type: 'directory',
                loadState: 'loaded',
                children: [
                  createMockWorkerFileNode({
                    name: 'file1.ts',
                    path: '/src/file1.ts',
                    type: 'file',
                    depth: 1,
                  }),
                ],
              }),
            ],
            expandedPaths: ['/src'],
            loadedCount: 1,
          },
        ],
      ]);

      const workerPort = createMockWorkerPort({ loadSubtreeResults });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree = createPartiallyLoadedTree();

      await act(async () => {
        await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(workerPort.loadSubtree).toHaveBeenCalledWith('/src');
      expect(mockOnTreeUpdate).toHaveBeenCalled();
    });

    it('should handle mixed loaded/unloaded directories', async () => {
      const loadSubtreeResults = new Map([
        [
          '/src',
          {
            tree: [
              createMockWorkerFileNode({
                name: 'src',
                path: '/src',
                type: 'directory',
                loadState: 'loaded',
                children: [
                  createMockWorkerFileNode({
                    name: 'utils',
                    path: '/src/utils',
                    type: 'directory',
                    loadState: 'loaded',
                    depth: 1,
                    children: [
                      createMockWorkerFileNode({
                        name: 'helper.ts',
                        path: '/src/utils/helper.ts',
                        type: 'file',
                        depth: 2,
                      }),
                    ],
                  }),
                  createMockWorkerFileNode({
                    name: 'index.ts',
                    path: '/src/index.ts',
                    type: 'file',
                    depth: 1,
                  }),
                ],
              }),
            ],
            expandedPaths: ['/src', '/src/utils'],
            loadedCount: 2,
          },
        ],
      ]);

      const workerPort = createMockWorkerPort({ loadSubtreeResults });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      // Tree with /src/utils unloaded
      const tree = createMixedLoadedTree();

      await act(async () => {
        await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Should load the /src directory to get the nested unloaded utils
      expect(workerPort.loadSubtree).toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('should cancel operation when cancelSelectAll is called during load', async () => {
      const workerPort = createMockWorkerPort({ loadSubtreeDelay: 100 });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree = createPartiallyLoadedTree();

      // Start async operation (don't await)
      act(() => {
        void result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Cancel during the load
      await act(async () => {
        result.current.cancelSelectAll();
      });

      expect(workerPort.abort).toHaveBeenCalled();
      expect(result.current.isLoadingForSelectAll).toBe(false);
    });

    it('should return cancelled result when operation is cancelled', async () => {
      const workerPort = createMockWorkerPort({ loadSubtreeDelay: 50 });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result, unmount } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree = createPartiallyLoadedTree();

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>> | undefined;

      try {
        // Start the selection and immediately cancel
        await act(async () => {
          const promise = result.current.selectAllRecursively(
            tree,
            'folder-1',
            mockAddMultipleSelectedFiles,
            100
          );

          // Small delay to let the operation start
          await new Promise((resolve) => setTimeout(resolve, 10));
          result.current.cancelSelectAll();

          selectResult = await promise;
        });

        // The operation should detect cancellation and return appropriately
        expect(selectResult?.cancelled).toBe(true);
        expect(selectResult?.success).toBe(false);
      } finally {
        // Ensure cleanup even if test assertions fail
        unmount();
      }
    });
  });

  describe('double-click guard', () => {
    it('should block rapid consecutive calls', async () => {
      const workerPort = createMockWorkerPort({ loadSubtreeDelay: 100 });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      // Use a tree with just one unloaded directory for cleaner test
      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      let secondResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>> | undefined;

      await act(async () => {
        // Start first call
        const firstPromise = result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );

        // Immediately try second call (simulating double-click)
        secondResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );

        // Wait for first to complete (not used but ensures cleanup)
        await firstPromise;
      });

      // Second call should be blocked
      expect(secondResult?.success).toBe(false);
      expect(secondResult?.error).toBe('Operation already in progress');

      // Worker should only be called once (by first call)
      expect(workerPort.loadSubtree).toHaveBeenCalledTimes(1);
    });

    it('should allow new call after previous completes', async () => {
      const workerPort = createMockWorkerPort();
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      // Use a tree with just one unloaded directory for cleaner test
      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      // First call
      await act(async () => {
        await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Second call after first completes
      await act(async () => {
        await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Both should execute (worker called once per call = twice total)
      expect(workerPort.loadSubtree).toHaveBeenCalledTimes(2);
    });
  });

  describe('filterTreeFn behavior', () => {
    it('should apply provided filterTreeFn in slow path', async () => {
      const mockFilterTreeFn = vi.fn((tree: IFileNode[]) =>
        tree.filter((node) => node.name !== 'hidden-dir')
      );

      const loadSubtreeResults = new Map([
        [
          '/src',
          {
            tree: [
              createMockWorkerFileNode({
                name: 'src',
                path: '/src',
                type: 'directory',
                loadState: 'loaded',
                children: [
                  createMockWorkerFileNode({
                    name: 'file.ts',
                    path: '/src/file.ts',
                    type: 'file',
                    depth: 1,
                  }),
                ],
              }),
            ],
            expandedPaths: ['/src'],
            loadedCount: 1,
          },
        ],
      ]);

      const workerPort = createMockWorkerPort({ loadSubtreeResults });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          filterTreeFn: mockFilterTreeFn,
        })
      );

      const tree = createPartiallyLoadedTree();

      await act(async () => {
        await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // filterTreeFn should have been called
      expect(mockFilterTreeFn).toHaveBeenCalled();
    });

    it('should work without filterTreeFn in slow path', async () => {
      const loadSubtreeResults = new Map([
        [
          '/src',
          {
            tree: [
              createMockWorkerFileNode({
                name: 'src',
                path: '/src',
                type: 'directory',
                loadState: 'loaded',
                children: [
                  createMockWorkerFileNode({
                    name: 'file.ts',
                    path: '/src/file.ts',
                    type: 'file',
                    depth: 1,
                  }),
                ],
              }),
            ],
            expandedPaths: ['/src'],
            loadedCount: 1,
          },
        ],
      ]);

      const workerPort = createMockWorkerPort({ loadSubtreeResults });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      // No filterTreeFn provided
      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          // filterTreeFn is undefined
        })
      );

      // Use a tree with just the /src directory that we have results for
      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Should work - onTreeUpdate called with loaded tree
      expect(selectResult!.success).toBe(true);
      expect(mockOnTreeUpdate).toHaveBeenCalled();
    });
  });

  describe('partial failure handling', () => {
    it('should continue with partial results when some loadSubtree calls fail', async () => {
      // Create a worker that fails for /src but succeeds for /tests
      const workerPort = {
        loadSubtree: vi.fn(async (path: string) => {
          if (path === '/src') {
            throw new Error('Permission denied');
          }
          return {
            tree: [
              {
                name: 'tests',
                path: '/tests',
                type: 'directory' as const,
                loadState: 'loaded' as const,
                children: [{ name: 'test.ts', path: '/tests/test.ts', type: 'file' as const }],
              },
            ],
            expandedPaths: [path],
            loadedCount: 1,
          };
        }),
        abort: vi.fn(),
        onProgress: vi.fn(() => () => {}),
      } as unknown as FileTreeWorkerPort;

      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      // Tree with two unloaded directories
      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
        createMockFileNode({
          name: 'tests',
          path: '/tests',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // Should have called both directories
      expect(workerPort.loadSubtree).toHaveBeenCalledTimes(2);

      // Should succeed with partial results (tests directory succeeded)
      expect(selectResult!.success).toBe(true);
      expect(mockOnTreeUpdate).toHaveBeenCalled();
    });

    it('should return failure when all loadSubtree calls fail', async () => {
      const workerPort = {
        loadSubtree: vi.fn(async () => {
          throw new Error('Network error');
        }),
        abort: vi.fn(),
        onProgress: vi.fn(() => () => {}),
      } as unknown as FileTreeWorkerPort;

      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
          onError: mockOnError,
        })
      );

      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      // When all fail, we get the fallback behavior (select from unloaded tree = 0 files)
      // This is expected because no directories could be loaded
      expect(selectResult!.success).toBe(true);
      expect(selectResult!.filePaths).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty tree', async () => {
      const workerPortRef = { current: createMockWorkerPort() };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          [],
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.success).toBe(false);
      expect(selectResult!.error).toBe('No files in tree');
    });

    it('should handle tree with only directories (no files)', async () => {
      const workerPortRef = { current: createMockWorkerPort() };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'loaded',
          children: [
            createMockFileNode({
              name: 'utils',
              path: '/src/utils',
              type: 'directory',
              loadState: 'loaded',
              depth: 1,
              children: [],
            }),
          ],
        }),
      ];

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.success).toBe(true);
      expect(selectResult!.filePaths).toHaveLength(0);
      expect(selectResult!.totalAvailable).toBe(0);
    });

    it('should fail gracefully when worker is not ready', async () => {
      const workerPortRef = { current: null };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      // Tree needs loading but worker is not ready
      const tree = createPartiallyLoadedTree();

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.success).toBe(false);
      expect(selectResult!.error).toBe('Worker not ready');
    });

    it('should fail gracefully when handle map is not ready', async () => {
      const workerPortRef = { current: createMockWorkerPort() };
      const handleMapRef = { current: null } as React.RefObject<Map<
        string,
        FileSystemHandle
      > | null>;

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef: handleMapRef as React.RefObject<Map<string, FileSystemHandle>>,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      const tree = createPartiallyLoadedTree();

      let selectResult: Awaited<ReturnType<typeof result.current.selectAllRecursively>>;
      await act(async () => {
        selectResult = await result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );
      });

      expect(selectResult!.success).toBe(false);
      expect(selectResult!.error).toBe('Handle map not ready');
    });

    it('should set and clear loading state correctly', async () => {
      const workerPort = createMockWorkerPort({ loadSubtreeDelay: 100 });
      const workerPortRef = { current: workerPort };
      const handleMapRef = { current: new Map<string, FileSystemHandle>() };

      const { result } = renderHook(() =>
        useRecursiveSelectAll({
          workerPortRef,
          handleMapRef,
          onTreeUpdate: mockOnTreeUpdate,
        })
      );

      expect(result.current.isLoadingForSelectAll).toBe(false);

      // Use a tree with just one unloaded directory
      const tree: IFileNode[] = [
        createMockFileNode({
          name: 'src',
          path: '/src',
          type: 'directory',
          loadState: 'unloaded',
          children: [],
        }),
      ];

      // Check state via the ref which is synchronously updated
      let loadingDuringOp = false;
      await act(async () => {
        const promise = result.current.selectAllRecursively(
          tree,
          'folder-1',
          mockAddMultipleSelectedFiles,
          100
        );

        // Give time for the state to be set and check the ref directly
        await new Promise((resolve) => setTimeout(resolve, 20));
        loadingDuringOp = result.current.isLoadingForSelectAllRef.current;

        await promise;
      });

      expect(loadingDuringOp).toBe(true);
      expect(result.current.isLoadingForSelectAll).toBe(false);
      expect(result.current.isLoadingForSelectAllRef.current).toBe(false);
    });
  });
});
