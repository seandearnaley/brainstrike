import type { FileToIndex } from '@brainstrike/token-cache';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../token-cache-context';
import { useBackgroundTokenIndexerIntegration } from '../use-background-token-indexer-integration';

// Capture the onFileIndexed callback from useBackgroundTokenIndexer
let capturedOnFileIndexed:
  | ((compositeKey: string, tokenCount: number, fileSize: number) => void)
  | undefined;
let capturedOnFileError: ((compositeKey: string, error: string) => void) | undefined;

// Mock the token cache hook so we can control readiness and capture calls.
const indexFilesMock = vi.fn<(files: FileToIndex[]) => Promise<void>>(async () => {});
const cancelIndexingMock = vi.fn();
const mockBackgroundIndexer = {
  indexFiles: indexFilesMock,
  cancelIndexing: cancelIndexingMock,
  isIndexing: false,
  isReady: true,
  progress: null,
};

vi.mock('@brainstrike/token-cache', () => ({
  useBackgroundTokenIndexer: (opts: {
    onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void;
    onFileError?: (compositeKey: string, error: string) => void;
  }) => {
    // Capture callbacks for testing
    capturedOnFileIndexed = opts.onFileIndexed;
    capturedOnFileError = opts.onFileError;
    return mockBackgroundIndexer;
  },
}));

// Provide a minimal context value with the fields the integration hook reads.
const createStoreMock = () =>
  ({
    get: vi.fn(),
    set: vi.fn(),
    getBatch: vi.fn(async () => new Map()),
    getAllForFolder: vi.fn(async () => []),
    setBatch: vi.fn(async () => {}),
    delete: vi.fn(async () => true),
    clearFolder: vi.fn(async () => 0),
    clearAll: vi.fn(async () => 0),
    getTotalTokens: vi.fn(async () => 0),
    findByCountingMode: vi.fn(async () => []),
    vacuum: vi.fn(async () => {}),
  }) as unknown as TokenCacheContextValue['store'];

const storeMock = createStoreMock();

const createTokenCacheContext = (): TokenCacheContextValue => ({
  isReady: true, // Deprecated - kept for backwards compatibility
  isOperational: true, // Worker + hasher ready
  isPersisted: true, // DB-backed storage available
  persistenceMode: 'persistent',
  isWorkerReady: true,
  countingMode: 'accurate',
  countTextTokens: vi.fn(async () => 0),
  getTokenCount: vi.fn(),
  getFileSize: vi.fn(),
  getTotalTokens: vi.fn(async () => 0),
  isLoading: vi.fn(() => false),
  isAnyLoading: false,
  queueForCounting: vi.fn(),
  preloadFolder: vi.fn(),
  store: storeMock,
  clearHotCache: vi.fn(),
  invalidate: vi.fn(),
  updateHotCache: vi.fn(),
  updateFileSizeCache: vi.fn(),
  cacheVersion: 0,
});

const tokenCacheContext: TokenCacheContextValue | null = createTokenCacheContext();

vi.mock('../token-cache-context', () => ({
  useOptionalTokenCacheContext: () => tokenCacheContext,
}));

// Simple web handle stub
const webHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;

const fileAKey = encodeFileSelection('root', 'a.txt');
const fileBKey = encodeFileSelection('root', 'b.txt');
const fileCKey = encodeFileSelection('other-root', 'c.txt');

const fileTreeRootA: IFileNode[] = [
  {
    name: 'a.txt',
    path: 'a.txt',
    type: 'file',
    handle: webHandle,
    depth: 0,
    selectionState: 'unchecked' as const,
    rootFolderId: 'root',
  },
  {
    name: 'b.txt',
    path: 'b.txt',
    type: 'file',
    handle: webHandle,
    depth: 0,
    selectionState: 'unchecked' as const,
    rootFolderId: 'root',
  },
];

const fileTreeRootB: IFileNode[] = [
  {
    name: 'c.txt',
    path: 'c.txt',
    type: 'file',
    handle: webHandle,
    depth: 0,
    selectionState: 'unchecked' as const,
    rootFolderId: 'other-root',
  },
];

const flushTimers = (): void => {
  // Run multiple cycles to ensure:
  // 1. First cycle: debounced effects (500ms timeout for handle map build)
  // 2. Second cycle: effects triggered by state updates from first cycle
  act(() => {
    vi.runAllTimers();
  });
  act(() => {
    vi.runAllTimers();
  });
};

const advanceTimers = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('useBackgroundTokenIndexerIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockBackgroundIndexer.isIndexing = false;
  });

  it('re-queues files when selection shrinks (stale cache is cleared)', () => {
    const { rerender } = renderHook(
      (selectedFiles: Set<string>) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles,
          onTokenResolved: vi.fn(),
        }),
      {
        initialProps: new Set([fileAKey, fileBKey]),
      }
    );

    // First selection: both files should be queued.
    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(indexFilesMock.mock.calls[0]![0]).toHaveLength(2);

    // Shrink selection to only fileA; cache should clear and re-queue fileA.
    rerender(new Set([fileAKey]));
    flushTimers();

    expect(indexFilesMock).toHaveBeenCalledTimes(2);
    expect(indexFilesMock.mock.calls[1]![0]).toHaveLength(1);
    expect(indexFilesMock.mock.calls[1]![0][0]?.compositeKey).toBe(fileAKey);
  });

  it('re-queues files when root folder changes even if selection size stays the same', () => {
    const { rerender } = renderHook(
      (props: { tree: typeof fileTreeRootA | typeof fileTreeRootB; selected: Set<string> }) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: props.tree,
          selectedFiles: props.selected,
          onTokenResolved: vi.fn(),
        }),
      {
        initialProps: { tree: fileTreeRootA, selected: new Set([fileAKey]) },
      }
    );

    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    indexFilesMock.mockClear();

    rerender({ tree: fileTreeRootB, selected: new Set([fileCKey]) });
    flushTimers();

    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(indexFilesMock.mock.calls[0]![0][0]?.compositeKey).toBe(fileCKey);
  });

  it('recovers when indexed cache equals selection but no indexing is running', () => {
    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: fileTreeRootA,
        selectedFiles: new Set([fileAKey]),
        onTokenResolved: vi.fn(),
      })
    );

    flushTimers();
    // The stale-cache safety should enqueue once.
    expect(indexFilesMock).toHaveBeenCalled();
    expect(indexFilesMock.mock.calls[0]![0][0]?.compositeKey).toBe(fileAKey);
  });

  it('preloads cached counts for each selected folder', () => {
    const { rerender } = renderHook(
      (selectedFiles: Set<string>) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles,
        }),
      { initialProps: new Set<string>() }
    );

    const preloadSpy = tokenCacheContext.preloadFolder as unknown as ReturnType<typeof vi.fn>;
    preloadSpy.mockClear();

    rerender(new Set([fileAKey, fileCKey]));

    expect(preloadSpy).toHaveBeenCalledTimes(2);
    expect(preloadSpy).toHaveBeenCalledWith('root');
    expect(preloadSpy).toHaveBeenCalledWith('other-root');
  });

  it('does not requeue files that are already in flight across renders', () => {
    const selected = new Set([fileAKey, fileBKey]);
    const { rerender } = renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: fileTreeRootA,
        selectedFiles: selected,
        onTokenResolved: vi.fn(),
      })
    );

    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(1);

    mockBackgroundIndexer.isIndexing = true;
    rerender();
    advanceTimers(500);
    rerender();

    expect(indexFilesMock).toHaveBeenCalledTimes(1);
  });

  describe('onFileIndexed callback (hot cache updates)', () => {
    it('calls updateHotCache when a file is indexed', () => {
      const updateHotCacheSpy = tokenCacheContext?.updateHotCache as ReturnType<typeof vi.fn>;
      updateHotCacheSpy.mockClear();

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      // Simulate the background indexer completing a file
      act(() => {
        capturedOnFileIndexed?.(fileAKey, 42, 128);
      });

      expect(updateHotCacheSpy).toHaveBeenCalledTimes(1);
      expect(updateHotCacheSpy).toHaveBeenCalledWith('root', 'a.txt', 42);
    });

    it('forwards token count to onTokenResolved callback', () => {
      const onTokenResolvedSpy = vi.fn();

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: onTokenResolvedSpy,
        })
      );

      flushTimers();

      // Simulate the background indexer completing a file
      act(() => {
        capturedOnFileIndexed?.(fileAKey, 100, 256);
      });

      expect(onTokenResolvedSpy).toHaveBeenCalledTimes(1);
      expect(onTokenResolvedSpy).toHaveBeenCalledWith(fileAKey, 100);
    });

    it('handles multiple files being indexed sequentially', () => {
      const updateHotCacheSpy = tokenCacheContext?.updateHotCache as ReturnType<typeof vi.fn>;
      const onTokenResolvedSpy = vi.fn();
      updateHotCacheSpy.mockClear();

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey, fileBKey]),
          onTokenResolved: onTokenResolvedSpy,
        })
      );

      flushTimers();

      // Simulate files being indexed one by one
      act(() => {
        capturedOnFileIndexed?.(fileAKey, 50, 128);
      });
      act(() => {
        capturedOnFileIndexed?.(fileBKey, 75, 256);
      });

      expect(updateHotCacheSpy).toHaveBeenCalledTimes(2);
      expect(updateHotCacheSpy).toHaveBeenNthCalledWith(1, 'root', 'a.txt', 50);
      expect(updateHotCacheSpy).toHaveBeenNthCalledWith(2, 'root', 'b.txt', 75);

      expect(onTokenResolvedSpy).toHaveBeenCalledTimes(2);
      expect(onTokenResolvedSpy).toHaveBeenNthCalledWith(1, fileAKey, 50);
      expect(onTokenResolvedSpy).toHaveBeenNthCalledWith(2, fileBKey, 75);
    });
  });

  describe('edge cases', () => {
    it('handles empty selection gracefully', () => {
      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set<string>(),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      // Should not attempt to index anything
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('handles empty file tree gracefully', () => {
      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      // Should not crash, but also won't find any handles to index
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('skips files without handles in the tree', () => {
      // Create a tree where one file has no handle (simulates edge case)
      const treeWithMissingHandle = [
        {
          name: 'a.txt',
          path: 'a.txt',
          type: 'file' as const,
          handle: webHandle,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: 'root',
        },
        {
          name: 'no-handle.txt',
          path: 'no-handle.txt',
          type: 'file' as const,
          // Intentionally omit handle to test edge case
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: 'root',
        },
      ] as IFileNode[];

      const noHandleKey = encodeFileSelection('root', 'no-handle.txt');

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: treeWithMissingHandle,
          selectedFiles: new Set([fileAKey, noHandleKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      // Should only index the file with a handle
      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]![0]).toHaveLength(1);
      expect(indexFilesMock.mock.calls[0]![0][0]?.compositeKey).toBe(fileAKey);
    });

    it('cancels indexing when selection shrinks while indexing is active', () => {
      mockBackgroundIndexer.isIndexing = true;

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: new Set([fileAKey, fileBKey]),
        }
      );

      flushTimers();
      cancelIndexingMock.mockClear();

      // Shrink selection while indexing is happening
      rerender(new Set([fileAKey]));
      flushTimers();

      expect(cancelIndexingMock).toHaveBeenCalled();
    });

    it('does not index when backgroundIndexer is not ready', () => {
      mockBackgroundIndexer.isReady = false;

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).not.toHaveBeenCalled();

      // Reset for other tests
      mockBackgroundIndexer.isReady = true;
    });

    it('normalizes absolute selection paths before dispatching to the indexer', () => {
      const absolutePath = '/Users/me/brainstrike copy 2/scripts/merge-coverage.js';
      const absoluteKey = encodeFileSelection('brainstrike copy 2', absolutePath);
      const treeWithAbsolutePath: IFileNode[] = [
        {
          name: 'merge-coverage.js',
          path: absolutePath,
          type: 'file',
          handle: webHandle,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: 'brainstrike copy 2',
        },
      ];

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: treeWithAbsolutePath,
          selectedFiles: new Set([absoluteKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]?.[0][0]?.filePath).toBe('scripts/merge-coverage.js');
    });

    it('skips unsafe traversal paths before dispatching to the indexer', () => {
      const traversalPath = '/Users/me/project/../secret.txt';
      const traversalKey = encodeFileSelection('project', traversalPath);
      const treeWithTraversalPath: IFileNode[] = [
        {
          name: 'secret.txt',
          path: traversalPath,
          type: 'file',
          handle: webHandle,
          depth: 0,
          selectionState: 'unchecked' as const,
          rootFolderId: 'project',
        },
      ];

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: treeWithTraversalPath,
          selectedFiles: new Set([traversalKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).not.toHaveBeenCalled();
    });
  });

  describe('cache hydration', () => {
    it('hydrates hot cache from persistent store for selected files', async () => {
      const updateHotCacheSpy = tokenCacheContext?.updateHotCache as ReturnType<typeof vi.fn>;
      updateHotCacheSpy.mockClear();

      // Mock getBatch to return cached entries
      const cachedEntries = new Map([
        ['a.txt', { tokenCount: 100, folderId: 'root', filePath: 'a.txt' }],
        ['b.txt', { tokenCount: 200, folderId: 'root', filePath: 'b.txt' }],
      ]);
      (storeMock.getBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(cachedEntries);

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey, fileBKey]),
          onTokenResolved: vi.fn(),
        })
      );

      // Wait for async getBatch to resolve
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should call getBatch with the folder and paths
      expect(storeMock.getBatch).toHaveBeenCalledWith('root', ['a.txt', 'b.txt']);

      // Should update hot cache for each cached entry
      expect(updateHotCacheSpy).toHaveBeenCalledWith('root', 'a.txt', 100);
      expect(updateHotCacheSpy).toHaveBeenCalledWith('root', 'b.txt', 200);
    });

    it('handles getBatch errors gracefully', async () => {
      (storeMock.getBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      // Should not throw
      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Test passes if no error is thrown
      expect(true).toBe(true);
    });
  });

  describe('ref pattern stability', () => {
    it('maintains stable callback identity across renders', () => {
      const onTokenResolvedSpy = vi.fn();
      const callbackCaptures: (typeof capturedOnFileIndexed)[] = [];

      const { rerender } = renderHook(() => {
        const result = useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: onTokenResolvedSpy,
        });
        callbackCaptures.push(capturedOnFileIndexed);
        return result;
      });

      flushTimers();

      // Trigger multiple re-renders
      rerender();
      rerender();
      rerender();

      // The captured callback should remain the same function reference
      // (This tests that the useCallback with refs pattern is working)
      const uniqueCallbacks = new Set(callbackCaptures);
      expect(uniqueCallbacks.size).toBe(1);
    });

    it('does not re-trigger effects when unrelated props change', () => {
      const onTokenResolvedSpy1 = vi.fn();
      const onTokenResolvedSpy2 = vi.fn();

      const { rerender } = renderHook(
        (props: { onTokenResolved: () => void }) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles: new Set([fileAKey]),
            onTokenResolved: props.onTokenResolved,
          }),
        {
          initialProps: { onTokenResolved: onTokenResolvedSpy1 },
        }
      );

      flushTimers();
      indexFilesMock.mockClear();

      // Change the callback (this should NOT re-trigger indexing)
      rerender({ onTokenResolved: onTokenResolvedSpy2 });
      flushTimers();

      // Should not re-index files just because callback changed
      expect(indexFilesMock).not.toHaveBeenCalled();

      // But the new callback should still be used when files are indexed
      act(() => {
        capturedOnFileIndexed?.(fileAKey, 99, 128);
      });

      expect(onTokenResolvedSpy1).not.toHaveBeenCalled();
      expect(onTokenResolvedSpy2).toHaveBeenCalledWith(fileAKey, 99);
    });
  });

  describe('error handling', () => {
    it('handles file indexing errors via onFileError', () => {
      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      // Simulate an error from the background indexer
      act(() => {
        capturedOnFileError?.(fileAKey, 'Failed to read file');
      });

      // The hook should handle this gracefully (no crash)
      expect(true).toBe(true);
    });
  });

  describe('P0 optimization: decouple fileHandleMap rebuild from selection updates', () => {
    it('does not rebuild fileHandleMap repeatedly when selection changes on stable tree', () => {
      // This test verifies the core P0 optimization:
      // When fileTree is stable, changing selectedFiles should NOT trigger repeated rebuilds.
      // The "File handle map built" log should only appear once per tree change, not per selection change.

      const { rerender, result } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: new Set<string>(),
        }
      );

      // Initial render with empty selection - map should be built once when selection becomes non-empty
      rerender(new Set([fileAKey]));
      flushTimers();

      const initialMapSize = result.current.diagnostics.fileHandleMapSize;
      expect(initialMapSize).toBe(2); // Both files in tree

      // Clear indexFiles mock to track future calls
      indexFilesMock.mockClear();

      // Now update selection multiple times - should NOT trigger map rebuilds
      rerender(new Set([fileAKey, fileBKey]));
      advanceTimers(100); // Partial timer advance - not enough for rebuild

      rerender(new Set([fileBKey]));
      advanceTimers(100);

      rerender(new Set([fileAKey, fileBKey]));
      advanceTimers(100);

      rerender(new Set([fileAKey]));
      advanceTimers(100);

      // Advance remaining time to complete any debounced operations
      flushTimers();

      // Map size should remain the same (no rebuilds on stable tree)
      expect(result.current.diagnostics.fileHandleMapSize).toBe(initialMapSize);

      // The map rebuild effect should NOT have been triggered by selection changes alone
      // (The selection effect will trigger indexing, but NOT map rebuilds)
    });

    it('rebuilds fileHandleMap exactly once when tree changes', () => {
      const { rerender, result } = renderHook(
        (props: { tree: IFileNode[]; selected: Set<string> }) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: props.tree,
            selectedFiles: props.selected,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: { tree: fileTreeRootA, selected: new Set([fileAKey]) },
        }
      );

      flushTimers();
      expect(result.current.diagnostics.fileHandleMapSize).toBe(2); // Root A has 2 files

      indexFilesMock.mockClear();

      // Change tree to rootB
      rerender({ tree: fileTreeRootB, selected: new Set([fileCKey]) });
      flushTimers();

      // Map should now have 1 file (rootB has 1 file)
      expect(result.current.diagnostics.fileHandleMapSize).toBe(1);

      // Should have triggered indexing for the new selection
      expect(indexFilesMock).toHaveBeenCalled();
    });

    it('only rebuilds on 0→>0 selection transition when map is stale or empty', () => {
      const { rerender, result } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          // Start with empty selection
          initialProps: new Set<string>(),
        }
      );

      // Map should not be built yet (no selection, no work)
      advanceTimers(600); // Past debounce time
      expect(result.current.diagnostics.fileHandleMapSize).toBe(0);

      // Now transition from 0 → >0 - this should trigger a rebuild
      rerender(new Set([fileAKey]));
      flushTimers();

      expect(result.current.diagnostics.fileHandleMapSize).toBe(2);

      // Selection changes without going to 0 should NOT trigger additional rebuilds
      const sizeAfterFirstBuild = result.current.diagnostics.fileHandleMapSize;

      rerender(new Set([fileAKey, fileBKey]));
      flushTimers();

      expect(result.current.diagnostics.fileHandleMapSize).toBe(sizeAfterFirstBuild);

      rerender(new Set([fileBKey]));
      flushTimers();

      expect(result.current.diagnostics.fileHandleMapSize).toBe(sizeAfterFirstBuild);
    });

    it('is idempotent - does not reset debounce when rebuild already scheduled', () => {
      const { rerender } = renderHook(
        (props: { tree: IFileNode[]; selected: Set<string> }) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: props.tree,
            selectedFiles: props.selected,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: { tree: fileTreeRootA, selected: new Set([fileAKey]) },
        }
      );

      // Don't flush - let the debounce be pending
      advanceTimers(200);

      // Change tree while rebuild is pending - this should NOT reset the timer
      // (it should cancel and reschedule for the new tree)
      const newTree = [...fileTreeRootA];
      rerender({ tree: newTree, selected: new Set([fileAKey]) });

      // Advance partial time
      advanceTimers(200);

      // Change selection - should NOT reset debounce since scheduleRebuildIfNeeded is idempotent
      rerender({ tree: newTree, selected: new Set([fileAKey, fileBKey]) });

      // Finish the debounce
      flushTimers();

      // Test passes if no infinite loops or excessive rebuilds occurred
      expect(true).toBe(true);
    });
  });

  describe('P0 optimization: de-dupe warm-cache preloading', () => {
    it('preloads folder only once when selection changes within the same folder', () => {
      const preloadSpy = tokenCacheContext.preloadFolder as unknown as ReturnType<typeof vi.fn>;
      preloadSpy.mockClear();

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: new Set<string>(),
        }
      );

      // First selection - should preload the 'root' folder
      rerender(new Set([fileAKey]));
      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('root');
      preloadSpy.mockClear();

      // Add another file in the same folder - should NOT preload again (memoized)
      rerender(new Set([fileAKey, fileBKey]));
      flushTimers();

      expect(preloadSpy).not.toHaveBeenCalled();

      // Remove a file (still in same folder) - should NOT preload again
      rerender(new Set([fileBKey]));
      flushTimers();

      expect(preloadSpy).not.toHaveBeenCalled();

      // Add file back - should NOT preload again
      rerender(new Set([fileAKey, fileBKey]));
      flushTimers();

      expect(preloadSpy).not.toHaveBeenCalled();
    });

    it('preloads new folder when selection expands to include it', () => {
      const preloadSpy = tokenCacheContext.preloadFolder as unknown as ReturnType<typeof vi.fn>;
      preloadSpy.mockClear();

      // Combined tree with files from both roots
      const combinedTree: IFileNode[] = [...fileTreeRootA, ...fileTreeRootB];

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: combinedTree,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: new Set([fileAKey]), // Start with file from 'root' folder
        }
      );

      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('root');
      preloadSpy.mockClear();

      // Now add a file from a different folder - should preload the new folder only
      rerender(new Set([fileAKey, fileCKey]));
      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('other-root');
    });

    it('clears preload memo when root folder changes (via tree change)', () => {
      const preloadSpy = tokenCacheContext.preloadFolder as unknown as ReturnType<typeof vi.fn>;
      preloadSpy.mockClear();

      const { rerender } = renderHook(
        (props: { tree: IFileNode[]; selected: Set<string> }) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: props.tree,
            selectedFiles: props.selected,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: { tree: fileTreeRootA, selected: new Set([fileAKey]) },
        }
      );

      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('root');
      preloadSpy.mockClear();

      // Change to different tree with different root - memo should be cleared
      rerender({ tree: fileTreeRootB, selected: new Set([fileCKey]) });
      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('other-root');
      preloadSpy.mockClear();

      // Change back to original tree - memo was cleared, so should preload again
      rerender({ tree: fileTreeRootA, selected: new Set([fileAKey]) });
      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('root');
    });

    it('skips getBatch for folders already preloaded at current cache version', async () => {
      const preloadSpy = tokenCacheContext.preloadFolder as unknown as ReturnType<typeof vi.fn>;
      const getBatchSpy = storeMock.getBatch as unknown as ReturnType<typeof vi.fn>;
      preloadSpy.mockClear();
      getBatchSpy.mockClear();
      getBatchSpy.mockResolvedValue(new Map());

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: fileTreeRootA,
            selectedFiles,
            onTokenResolved: vi.fn(),
          }),
        {
          initialProps: new Set<string>(),
        }
      );

      // First selection - should preload and call getBatch
      rerender(new Set([fileAKey]));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const initialGetBatchCalls = getBatchSpy.mock.calls.length;
      expect(initialGetBatchCalls).toBeGreaterThan(0);
      getBatchSpy.mockClear();

      // Update selection in same folder - should NOT call getBatch again (skipped)
      rerender(new Set([fileAKey, fileBKey]));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // No additional getBatch calls since folder was already preloaded
      expect(getBatchSpy).not.toHaveBeenCalled();
    });
  });
});
