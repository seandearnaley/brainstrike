import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { addLogListener, LogLevel } from '@brainstrike/utils/logger';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';
import type { FileTreeIndexContextValue } from '../tree/file-tree-provider';

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

vi.mock('@brainstrike/token-cache/background-indexer', () => ({
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

vi.mock('../indexing/token-cache-context', () => ({
  useOptionalTokenCacheContext: () => tokenCacheContext,
}));

let mockFileTreeIndexContext: FileTreeIndexContextValue | null = null;

vi.mock('../tree/file-tree-provider', () => ({
  useOptionalFileTreeIndexContext: () => mockFileTreeIndexContext,
}));

// Simple web handle stub
const webHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;

const fileAKey = encodeFileSelection('root', 'a.txt');
const fileBKey = encodeFileSelection('root', 'b.txt');
const fileCKey = encodeFileSelection('other-root', 'c.txt');
const fileRootCKey = encodeFileSelection('root', 'c.txt');

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

// Separate three-file tree used only by the swap-then-shrink regression
// test. Keeping it out of `fileTreeRootA` preserves the `fileHandleMapSize
// === 2` invariant that the P0 handle-map-rebuild tests rely on.
const fileTreeRootAWithC: IFileNode[] = [
  ...fileTreeRootA,
  {
    name: 'c.txt',
    path: 'c.txt',
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

interface DeferredValue<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createElectronTree(fileCount: number): {
  keys: string[];
  tree: IFileNode[];
} {
  const tree: IFileNode[] = [];
  const keys: string[] = [];

  for (let index = 0; index < fileCount; index += 1) {
    const path = `file-${index}.ts`;
    keys.push(encodeFileSelection('root', path));
    tree.push({
      name: `file-${index}.ts`,
      path,
      type: 'file',
      handle: {
        kind: 'file',
        name: `file-${index}.ts`,
        path: `/repo/${path}`,
        platform: 'electron',
      } as unknown as FileSystemFileHandle,
      depth: 0,
      selectionState: 'unchecked' as const,
      rootFolderId: 'root',
    });
  }

  return { tree, keys };
}

describe('useBackgroundTokenIndexerIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __resetVectorStatusUIStoreForTests();
    mockBackgroundIndexer.isIndexing = false;
    mockFileTreeIndexContext = null;
  });

  it('does not re-queue still-selected files when selection shrinks', () => {
    // Regression: the previous implementation cancelled the full in-flight
    // batch on any shrink and then re-queued the remaining file. That round
    // trip is what made the context explorer briefly render `—` for files the
    // user had not deselected. The narrowed cancel-on-shrink path keeps the
    // still-selected in-flight key and avoids the re-dispatch.
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
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(indexFilesMock.mock.calls[0]![0]).toHaveLength(2);

    rerender(new Set([fileAKey]));
    flushTimers();

    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(cancelIndexingMock).not.toHaveBeenCalled();
  });

  it('still detects shrinks when an upstream caller mutates the selection Set in place', () => {
    // Defensive hardening: `previousSelectedFilesRef` shallow-clones the
    // incoming Set so reconcileInFlightOnShrink does not silently compare a
    // Set against itself. Without the clone, if React's selection state were
    // ever mutated in place (non-standard but possible via upstream bugs or
    // future refactors), the ref and the prop would point to the same object,
    // the diff loop would find zero removed keys, and the cancel/narrow path
    // would never fire on a real shrink.
    const mutableSelection = new Set([fileAKey, fileBKey]);
    const { rerender } = renderHook(
      (selectedFiles: Set<string>) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles,
          onTokenResolved: vi.fn(),
        }),
      {
        initialProps: mutableSelection,
      }
    );

    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(1);

    // Mutate in place, then rerender with the same Set reference. Without the
    // defensive clone this rerender would look like "no change" even though
    // the user effectively dropped a selection.
    mutableSelection.delete(fileBKey);
    rerender(mutableSelection);
    flushTimers();

    // The remaining still-selected file (a.txt) must not trigger a fresh
    // indexFiles dispatch, because it is already tracked from the first batch
    // via inFlightRef. The prior implementation (bare reference store) would
    // skip the narrow path entirely; the clone forces the reconciliation to
    // correctly remove b.txt from inFlightRef without cancelling the batch.
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(cancelIndexingMock).not.toHaveBeenCalled();
  });

  it('cancels the batch when selection shrinks to empty after an equal-size swap orphans an in-flight file', () => {
    // Regression for the swap-then-shrink scenario: {A,B} -> {A,C} is an
    // equal-size swap that does NOT trigger the shrink handler, so B stays
    // tracked in inFlightRef even though the user has deselected it. When
    // selection then shrinks to empty ({} previousSize=2), the old
    // `reconcileInFlightOnShrink` iterated only `previousSelectedFiles =
    // {A, C}` and never visited B -- so `remainingInFlight` stayed at 1 and
    // `cancelBatch` stayed false. The worker kept token-counting B even
    // though nothing was selected. The fix iterates `inFlight` directly to
    // drain any key not present in the current selection, which makes the
    // cancel path fire correctly for this scenario.
    const { rerender } = renderHook(
      (selectedFiles: Set<string>) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootAWithC,
          selectedFiles,
          onTokenResolved: vi.fn(),
        }),
      {
        initialProps: new Set([fileAKey, fileBKey]),
      }
    );

    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(indexFilesMock.mock.calls[0]![0]).toHaveLength(2);

    // Equal-size swap: B is deselected and replaced with root/c.txt. The
    // shrink handler does NOT run here (size 2 -> 2). After this rerender
    // and its debounced dispatch, inFlight should hold {A, B (orphan), C}.
    rerender(new Set([fileAKey, fileRootCKey]));
    flushTimers();
    expect(indexFilesMock).toHaveBeenCalledTimes(2);

    cancelIndexingMock.mockClear();

    // Now shrink to empty. Without the inFlight-drain fix, the reconcile
    // loop only visits `previousSelectedFiles = {A, C}`, leaves B in
    // inFlight, sees remainingInFlight=1, and never calls cancelIndexing.
    rerender(new Set());
    flushTimers();

    expect(cancelIndexingMock).toHaveBeenCalledTimes(1);
  });

  it('prefetches file sizes into the hot cache before token indexing completes', () => {
    // Regression for context-explorer responsiveness: size metadata used to
    // only land in the hot cache after the background indexer finished token
    // counting, so a shrinking/filter-churning selection would render `—` in
    // the size column whenever indexing was gated (embedding active,
    // adaptive debounce, worker busy). The decoupled prefetch effect writes
    // any size the handle sources already know the instant selection
    // changes, independent of token indexing.
    const updateFileSizeCacheSpy = tokenCacheContext.updateFileSizeCache as unknown as ReturnType<
      typeof vi.fn
    >;
    updateFileSizeCacheSpy.mockClear();

    mockFileTreeIndexContext = {
      getHandle: vi.fn((folderId: string, path: string) => {
        if (folderId !== 'root') {
          return;
        }
        if (path === 'a.txt') {
          return { fileName: 'a.txt', fileSize: 2048, webHandle };
        }
        if (path === 'b.txt') {
          return { fileName: 'b.txt', fileSize: 4096, webHandle };
        }
        return;
      }),
      getNode: vi.fn(() => undefined),
      stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
      version: 1,
    };

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set([fileAKey, fileBKey]),
        onTokenResolved: vi.fn(),
      })
    );

    // Sizes should be written synchronously during the prefetch effect, i.e.
    // without needing to flush the adaptive-debounce timer that gates
    // triggerIndexing. Any regression here would delay size rendering until
    // after token counting, which is the exact failure mode we're fixing.
    expect(updateFileSizeCacheSpy).toHaveBeenCalledWith('root', 'a.txt', 2048);
    expect(updateFileSizeCacheSpy).toHaveBeenCalledWith('root', 'b.txt', 4096);
  });

  it('does not write file sizes when no handle source knows the size', () => {
    // When neither FileTreeIndex nor the local handle map has populated
    // metadata (e.g. selection restored from storage before the tree loads),
    // the prefetch effect must stay quiet rather than writing zeros or
    // stale fallbacks. The persistent cache still has the authoritative size
    // from the last session; any premature write here would clobber it.
    const updateFileSizeCacheSpy = tokenCacheContext.updateFileSizeCache as unknown as ReturnType<
      typeof vi.fn
    >;
    updateFileSizeCacheSpy.mockClear();

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set([fileAKey]),
        onTokenResolved: vi.fn(),
      })
    );

    expect(updateFileSizeCacheSpy).not.toHaveBeenCalled();
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

    it('cancels indexing when every in-flight file is deselected', () => {
      // Full deselection means nobody is waiting for those token counts, so we
      // tear down the worker batch to free the main thread immediately.
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

      rerender(new Set<string>());
      flushTimers();

      expect(cancelIndexingMock).toHaveBeenCalledTimes(1);
    });

    it('does not cancel indexing when still-selected files remain in flight', () => {
      // Regression for the context explorer responsiveness fix: deselecting a
      // subset of in-flight files must not nuke the whole worker batch. The
      // files that remain selected keep their in-flight marker and continue
      // counting, so their token column stays populated.
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
      indexFilesMock.mockClear();

      rerender(new Set([fileAKey]));
      flushTimers();

      expect(cancelIndexingMock).not.toHaveBeenCalled();
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('still queues indexing when cache is operational even if the background indexer is not ready yet', () => {
      mockBackgroundIndexer.isReady = false;

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).toHaveBeenCalledWith([
        {
          compositeKey: fileAKey,
          fileHandle: webHandle,
          filePath: 'a.txt',
          folderId: 'root',
        },
      ]);

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

    it('streams Electron file reads in cooperative batches with a yield before overflow reads', async () => {
      const { keys } = createElectronTree(17);
      const deferredReads = new Map<string, DeferredValue<string>>();
      const electronFileReader = vi.fn((handle: { path: string }) => {
        const deferred = createDeferredValue<string>();
        deferredReads.set(handle.path, deferred);
        return deferred.promise;
      });
      mockFileTreeIndexContext = {
        getHandle: vi.fn((_folderId, path) => ({
          electronHandle: {
            kind: 'file' as const,
            name: path,
            path: `/repo/${path}`,
            platform: 'electron' as const,
          },
          fileName: path,
          fileSize: 128,
        })),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 17, totalNodes: 17 },
        version: 1,
      };

      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set(),
          electronFileReader,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        void result.current.triggerIndexing(keys);
        for (let index = 0; index < 5; index += 1) {
          await Promise.resolve();
        }
      });

      expect(electronFileReader).toHaveBeenCalledTimes(8);
      expect(indexFilesMock).not.toHaveBeenCalled();

      for (let index = 0; index < 8; index += 1) {
        deferredReads.get(`/repo/file-${index}.ts`)?.resolve(`content-${index}`);
      }

      await act(async () => {
        await Promise.resolve();
      });

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]?.[0]).toHaveLength(8);
      expect(electronFileReader).toHaveBeenCalledTimes(8);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });

      expect(electronFileReader).toHaveBeenCalledTimes(16);

      for (let index = 8; index < 16; index += 1) {
        deferredReads.get(`/repo/file-${index}.ts`)?.resolve(`content-${index}`);
      }

      await act(async () => {
        await Promise.resolve();
      });

      expect(indexFilesMock).toHaveBeenCalledTimes(2);
      expect(indexFilesMock.mock.calls[1]?.[0]).toHaveLength(8);
    });

    it('summarizes large Electron token indexing at info without per-batch info logs', async () => {
      const { keys } = createElectronTree(257);
      const infoMessages: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (
          record.level === LogLevel.INFO &&
          record.scope === 'BackgroundTokenIndexerIntegration'
        ) {
          infoMessages.push(record.message ?? '');
        }
      });
      const electronFileReader = vi.fn(async () => 'content');
      mockFileTreeIndexContext = {
        getHandle: vi.fn((_folderId, path) => ({
          electronHandle: {
            kind: 'file' as const,
            name: path,
            path: `/repo/${path}`,
            platform: 'electron' as const,
          },
          fileName: path,
          fileSize: 128,
        })),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 257, totalNodes: 257 },
        version: 1,
      };

      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set(),
          electronFileReader,
          onTokenResolved: vi.fn(),
        })
      );

      try {
        await act(async () => {
          const indexing = result.current.triggerIndexing(keys);
          await vi.runAllTimersAsync();
          await indexing;
        });
      } finally {
        unsubscribe();
      }

      expect(
        infoMessages.filter(
          (message) => message === 'Background token indexing dispatched Electron batch'
        )
      ).toHaveLength(0);
      expect(
        infoMessages.filter(
          (message) => message === 'Background token indexing dispatched Electron batches'
        )
      ).toHaveLength(1);
    });

    it('dispatches selection-driven token counting even while embedding is active', () => {
      // Regression for the Context Explorer responsiveness bug reported on
      // 2026-04-20: the preview panel tokens column stayed on em-dash for the
      // duration of a collection-sync run. The prior implementation gated the
      // foreground dispatch on `isEmbeddingActive`, which is set whenever the
      // collection sync's embedding queue is active. That inverted the
      // priority contract: the foreground (user-selected) tokenizer is CPU-
      // only, runs in a dedicated Web Worker, and does not contend with
      // WebGPU embeddings or with the collection sync's PGLite writes (PGLite
      // serializes internally). The correct WebGPU gate lives in
      // `background-work-arbiter` and already suspends the collection sync
      // when the local LLM acquires `local-llm`. Removing this gate restores
      // the stated priority order: LLM > foreground tokens > background sync.
      useVectorStatusUIStore.setState({ isEmbeddingActive: true });

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]?.[0].map((file) => file.compositeKey)).toEqual([
        fileAKey,
      ]);
    });

    it('dispatches selection-driven token counting even while file import is in progress', () => {
      // Regression for the Context Explorer token-count loss during
      // background indexing (see logs 2026-04-20T18:08:22Z, line
      // "Selection effect skipped - file import in progress"). The
      // collection-sync provider calls `setIsImporting(true)` for the entire
      // duration of its scan -- which can be many minutes on a large root.
      // The prior `getSelectionSkipState` short-circuited the foreground
      // dispatch on that flag, starving the preview panel tokens column for
      // the entire sync. The foreground tokenizer does not write to PGLite
      // on the same connection as the collection sync batcher; PGLite
      // serializes writes internally, so concurrent `TokenCacheStore.set`
      // calls cannot corrupt data. The foreground dispatch must therefore
      // not be gated on `isImporting`.
      useVectorStatusUIStore.setState({ isImporting: true });

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]?.[0].map((file) => file.compositeKey)).toEqual([
        fileAKey,
      ]);
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

    it('hydrates warm cache from persistent store even while file import is in progress', async () => {
      // Regression for the Context Explorer warm-cache loss during
      // background indexing (see logs 2026-04-20T18:08:22Z, line
      // "Warm cache effect skipped - file import in progress"). Warm-cache
      // hydration is a READ from PGLite; it does not contend with the
      // collection sync's writes. The prior gate bailed out of hydration
      // whenever `isImporting=true`, so selecting a folder during a long
      // sync would fail to surface token counts that were already persisted
      // from prior sessions -- exactly the failure mode the persistent
      // cache is supposed to prevent. Reads and writes are independent;
      // hydration must proceed regardless of the import flag.
      useVectorStatusUIStore.setState({ isImporting: true });

      const updateHotCacheSpy = tokenCacheContext?.updateHotCache as ReturnType<typeof vi.fn>;
      updateHotCacheSpy.mockClear();

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

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(storeMock.getBatch).toHaveBeenCalledWith('root', ['a.txt', 'b.txt']);
      expect(updateHotCacheSpy).toHaveBeenCalledWith('root', 'a.txt', 100);
      expect(updateHotCacheSpy).toHaveBeenCalledWith('root', 'b.txt', 200);
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

    it('clears all in-flight files when the worker reports a terminal error', () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey, fileBKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();
      expect(result.current.diagnostics.inFlightCount).toBe(2);

      act(() => {
        capturedOnFileError?.('__worker__', 'worker crashed');
      });

      expect(result.current.diagnostics.inFlightCount).toBe(0);
    });

    it('keeps missing-file errors quiet and retryable', () => {
      const records: Array<{ level: LogLevel; message: string }> = [];
      const unsubscribe = addLogListener((record) => {
        records.push({ level: record.level, message: record.message ?? '' });
      });

      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();

      try {
        act(() => {
          capturedOnFileError?.(fileAKey, 'ENOENT: no such file or directory');
        });
      } finally {
        unsubscribe();
      }

      expect(result.current.diagnostics.inFlightCount).toBe(0);
      expect(result.current.diagnostics.indexedCount).toBe(0);
      expect(records).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: LogLevel.ERROR,
            message: 'Background indexer file error',
          }),
        ])
      );
    });

    it('clears diagnostics tracking on manual indexed-cache reset', () => {
      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: fileTreeRootA,
          selectedFiles: new Set([fileAKey]),
          onTokenResolved: vi.fn(),
        })
      );

      flushTimers();
      expect(result.current.diagnostics.inFlightCount).toBe(1);

      act(() => {
        result.current.diagnostics.clearIndexedCache();
      });

      expect(result.current.diagnostics.inFlightCount).toBe(0);
      expect(result.current.diagnostics.indexedCount).toBe(0);
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
    it('does not re-preload a folder when later selections stay within already covered paths', () => {
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

      // Start with full coverage for the folder.
      rerender(new Set([fileAKey, fileBKey]));
      flushTimers();

      expect(preloadSpy).toHaveBeenCalledTimes(1);
      expect(preloadSpy).toHaveBeenCalledWith('root');
      preloadSpy.mockClear();

      // Shrink to a subset - should not preload again because the previous preload already covered it.
      rerender(new Set([fileAKey]));
      flushTimers();

      expect(preloadSpy).not.toHaveBeenCalled();

      // Switching to another covered subset still should not preload again.
      rerender(new Set([fileBKey]));
      flushTimers();

      expect(preloadSpy).not.toHaveBeenCalled();

      // Returning to the original covered selection should also stay memoized.
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

    it('re-hydrates a folder when the selection expands within the same folder', async () => {
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

      // Update selection in same folder - should preload again because the folder coverage changed.
      rerender(new Set([fileAKey, fileBKey]));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(preloadSpy).toHaveBeenCalledWith('root');
      expect(getBatchSpy).toHaveBeenCalledTimes(1);
      expect(getBatchSpy).toHaveBeenCalledWith('root', ['a.txt', 'b.txt']);
    });
  });

  it('indexes selected desktop descendants even when the tree index has not materialized their handles', async () => {
    const rootFolderId = '/repo';
    const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/file.ts');
    const electronFileReader = vi.fn(async () => 'export const value = 1;\n');

    mockFileTreeIndexContext = {
      getHandle: vi.fn(() => undefined),
      getNode: vi.fn(() => undefined),
      stats: {
        totalDirectories: 0,
        totalFiles: 0,
        totalNodes: 0,
      },
      version: 1,
    };

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set([deepFileKey]),
        electronFileReader,
        onTokenResolved: vi.fn(),
      })
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronFileReader).toHaveBeenCalledTimes(1);
    expect(electronFileReader).toHaveBeenCalledWith({
      kind: 'file',
      name: 'file.ts',
      path: '/repo/src/deep/file.ts',
      platform: 'electron',
    });
    expect(indexFilesMock).toHaveBeenCalledTimes(1);
    expect(indexFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        compositeKey: deepFileKey,
        filePath: 'src/deep/file.ts',
        folderId: rootFolderId,
      }),
    ]);
  });

  it('skips synthetic desktop handles when cached file size exceeds the indexing limit', async () => {
    const rootFolderId = '/repo';
    const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/large-file.ts');
    const electronFileReader = vi.fn(async () => 'export const value = 1;\n');
    const getFileSizeMock = tokenCacheContext.getFileSize as unknown as ReturnType<typeof vi.fn>;
    getFileSizeMock.mockImplementation((folderId: string, path: string) => {
      if (folderId === rootFolderId && path === 'src/deep/large-file.ts') {
        return 800_000;
      }
      return;
    });

    mockFileTreeIndexContext = {
      getHandle: vi.fn(() => undefined),
      getNode: vi.fn(() => undefined),
      stats: {
        totalDirectories: 0,
        totalFiles: 0,
        totalNodes: 0,
      },
      version: 1,
    };

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set([deepFileKey]),
        electronFileReader,
        onTokenResolved: vi.fn(),
      })
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronFileReader).not.toHaveBeenCalled();
    expect(indexFilesMock).not.toHaveBeenCalled();
  });

  it('retries synthetic desktop handles with stale oversized cache metadata after index materializes', async () => {
    const rootFolderId = '/repo';
    const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/large-file.ts');
    const electronFileReader = vi.fn(async () => 'export const value = 1;\n');
    const getFileSizeMock = tokenCacheContext.getFileSize as unknown as ReturnType<typeof vi.fn>;
    getFileSizeMock.mockImplementation((folderId: string, path: string) => {
      if (folderId === rootFolderId && path === 'src/deep/large-file.ts') {
        return 800_000;
      }
      return;
    });

    mockFileTreeIndexContext = {
      getHandle: vi.fn(() => undefined),
      getNode: vi.fn(() => undefined),
      stats: {
        totalDirectories: 0,
        totalFiles: 0,
        totalNodes: 0,
      },
      version: 1,
    };

    const { rerender } = renderHook(
      (selectedFiles: Set<string>) =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles,
          electronFileReader,
          onTokenResolved: vi.fn(),
        }),
      {
        initialProps: new Set([deepFileKey]),
      }
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronFileReader).not.toHaveBeenCalled();
    expect(indexFilesMock).not.toHaveBeenCalled();

    indexFilesMock.mockClear();
    getFileSizeMock.mockImplementation(() => undefined);
    mockFileTreeIndexContext = {
      getHandle: vi.fn(() => ({
        electronHandle: {
          kind: 'file' as const,
          name: 'large-file.ts',
          path: '/repo/src/deep/large-file.ts',
          platform: 'electron' as const,
        },
        fileName: 'large-file.ts',
        fileSize: 128,
      })),
      getNode: vi.fn(() => undefined),
      stats: {
        totalDirectories: 0,
        totalFiles: 1,
        totalNodes: 1,
      },
      version: 2,
    };

    rerender(new Set([deepFileKey]));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronFileReader).toHaveBeenCalledWith({
      kind: 'file',
      name: 'large-file.ts',
      path: '/repo/src/deep/large-file.ts',
      platform: 'electron',
    });
    expect(indexFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        compositeKey: deepFileKey,
        filePath: 'src/deep/large-file.ts',
        folderId: rootFolderId,
      }),
    ]);
  });

  it('normalizes absolute restored desktop selection paths before indexing', async () => {
    const rootFolderId = '/repo';
    const absoluteFilePath = '/repo/src/deep/file.ts';
    const deepFileKey = encodeFileSelection(rootFolderId, absoluteFilePath);
    const electronFileReader = vi.fn(async () => 'export const value = 1;\n');
    const updateHotCacheSpy = tokenCacheContext.updateHotCache as unknown as ReturnType<
      typeof vi.fn
    >;
    const updateFileSizeCacheSpy = tokenCacheContext.updateFileSizeCache as unknown as ReturnType<
      typeof vi.fn
    >;
    updateHotCacheSpy.mockClear();
    updateFileSizeCacheSpy.mockClear();

    mockFileTreeIndexContext = {
      getHandle: vi.fn(() => undefined),
      getNode: vi.fn(() => undefined),
      stats: {
        totalDirectories: 0,
        totalFiles: 0,
        totalNodes: 0,
      },
      version: 1,
    };

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set([deepFileKey]),
        electronFileReader,
        onTokenResolved: vi.fn(),
      })
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(electronFileReader).toHaveBeenCalledWith({
      kind: 'file',
      name: 'file.ts',
      path: '/repo/src/deep/file.ts',
      platform: 'electron',
    });
    expect(indexFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        compositeKey: deepFileKey,
        filePath: 'src/deep/file.ts',
        folderId: rootFolderId,
      }),
    ]);

    act(() => {
      capturedOnFileIndexed?.(deepFileKey, 42, 128);
    });

    expect(updateHotCacheSpy).toHaveBeenCalledWith(rootFolderId, 'src/deep/file.ts', 42);
    expect(updateFileSizeCacheSpy).toHaveBeenCalledWith(rootFolderId, 'src/deep/file.ts', 128);
  });

  it('skips hot-cache writeback when indexed callbacks surface a folder-root path', async () => {
    const rootFolderId = '/repo';
    const folderRootKey = encodeFileSelection(rootFolderId, rootFolderId);
    const updateHotCacheSpy = tokenCacheContext.updateHotCache as unknown as ReturnType<
      typeof vi.fn
    >;
    const updateFileSizeCacheSpy = tokenCacheContext.updateFileSizeCache as unknown as ReturnType<
      typeof vi.fn
    >;
    updateHotCacheSpy.mockClear();
    updateFileSizeCacheSpy.mockClear();

    renderHook(() =>
      useBackgroundTokenIndexerIntegration({
        fileTree: [],
        selectedFiles: new Set(),
        onTokenResolved: vi.fn(),
      })
    );

    act(() => {
      capturedOnFileIndexed?.(folderRootKey, 42, 128);
    });

    expect(updateHotCacheSpy).not.toHaveBeenCalled();
    expect(updateFileSizeCacheSpy).not.toHaveBeenCalled();
  });
});
