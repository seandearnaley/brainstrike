import { __resetVectorStatusUIStoreForTests } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { FileToIndex } from '@brainstrike/token-cache/background-indexer';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import {
  useBackgroundTokenIndexerIntegration,
  type WebFileForIndexingResolution,
} from '../indexing/use-background-token-indexer-integration';
import type { FileTreeIndexContextValue } from '../tree/file-tree-provider';

// Capture the onFileIndexed callback from useBackgroundTokenIndexer
let capturedOnFileIndexed:
  | ((compositeKey: string, tokenCount: number, fileSize: number) => void)
  | undefined;

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

describe('useBackgroundTokenIndexerIntegration web resolver fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __resetVectorStatusUIStoreForTests();
    mockBackgroundIndexer.isIndexing = false;
    mockBackgroundIndexer.isReady = true;
    mockFileTreeIndexContext = null;
  });

  describe('webFileHandleResolver fallback (web parity with desktop synthetic-handle path)', () => {
    it('resolves missing web handles via webFileHandleResolver and queues the resolved handle for the worker', async () => {
      const rootFolderId = 'root';
      const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/file.ts');
      const resolvedHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
      const webFileHandleResolver = vi
        .fn()
        .mockResolvedValue({ kind: 'handle', fileHandle: resolvedHandle, fileSize: 256 });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([deepFileKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      expect(webFileHandleResolver).toHaveBeenCalledWith(`${rootFolderId}/src/deep/file.ts`);
      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).toHaveBeenCalledWith([
        expect.objectContaining({
          compositeKey: deepFileKey,
          fileHandle: resolvedHandle,
          filePath: 'src/deep/file.ts',
          folderId: rootFolderId,
        }),
      ]);
    });

    it('queues pre-loaded content when the resolver returns kind: content (in-memory adapter parity)', async () => {
      // Mirrors the dev-fixture / future in-memory adapter path: synthetic
      // FileSystemFileHandles cannot survive structured clone to the indexer
      // worker, so the resolver returns pre-loaded UTF-8 bytes and the worker
      // hashes/counts off `request.content` (same code path as Electron).
      const rootFolderId = 'root';
      const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/file.ts');
      const content = 'export const value = 1;\n';
      const fileSize = new TextEncoder().encode(content).length;
      const webFileHandleResolver = vi
        .fn<(path: string) => Promise<WebFileForIndexingResolution>>()
        .mockResolvedValue({ kind: 'content', content, fileSize });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([deepFileKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      const dispatched = indexFilesMock.mock.calls[0]?.[0]?.[0] as FileToIndex | undefined;
      expect(dispatched).toMatchObject({
        compositeKey: deepFileKey,
        content,
        fileSize,
        filePath: 'src/deep/file.ts',
        folderId: rootFolderId,
      });
      // Critically: no fileHandle should be attached -- the worker must read
      // `request.content` directly to avoid the structured-clone failure that
      // synthetic handles trigger when posted to a Worker.
      expect(dispatched?.fileHandle).toBeUndefined();
    });

    it('writes both token count and file size to the cache when the resolved handle is indexed', async () => {
      const rootFolderId = 'root';
      const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/file.ts');
      const resolvedHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
      const webFileHandleResolver = vi
        .fn()
        .mockResolvedValue({ kind: 'handle', fileHandle: resolvedHandle, fileSize: 512 });

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
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([deepFileKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      act(() => {
        capturedOnFileIndexed?.(deepFileKey, 42, 256);
      });

      expect(updateHotCacheSpy).toHaveBeenCalledWith(rootFolderId, 'src/deep/file.ts', 42);
      expect(updateFileSizeCacheSpy).toHaveBeenCalledWith(rootFolderId, 'src/deep/file.ts', 256);
    });

    it('parks resolver failures in pending and retries after an indexVersion bump', async () => {
      const rootFolderId = 'root';
      const deepFileKey = encodeFileSelection(rootFolderId, 'src/deep/file.ts');
      const resolvedHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
      const webFileHandleResolver = vi
        .fn<(path: string) => Promise<WebFileForIndexingResolution>>()
        .mockRejectedValueOnce(new Error('NotFoundError'));

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: [],
            selectedFiles,
            webFileHandleResolver,
            onTokenResolved: vi.fn(),
          }),
        { initialProps: new Set([deepFileKey]) }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).not.toHaveBeenCalled();

      // Simulate the FileTreeIndex repopulating (e.g., user expanded a subfolder).
      // The resolver now succeeds and the pending key should be retried automatically.
      webFileHandleResolver.mockResolvedValue({
        kind: 'handle',
        fileHandle: resolvedHandle,
        fileSize: 256,
      });
      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 2,
      };
      rerender(new Set([deepFileKey]));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(2);
      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).toHaveBeenCalledWith([
        expect.objectContaining({
          compositeKey: deepFileKey,
          fileHandle: resolvedHandle,
          filePath: 'src/deep/file.ts',
          folderId: rootFolderId,
        }),
      ]);
    });

    it('does not invoke the resolver for binary files (parity with live-handle web path)', async () => {
      const rootFolderId = 'root';
      const binaryKey = encodeFileSelection(rootFolderId, 'assets/image.png');
      const webFileHandleResolver =
        vi.fn<(path: string) => Promise<WebFileForIndexingResolution>>();

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([binaryKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).not.toHaveBeenCalled();
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('does not invoke the resolver when cached file size already exceeds the indexing limit', async () => {
      const rootFolderId = 'root';
      const largeKey = encodeFileSelection(rootFolderId, 'src/deep/large.txt');
      const webFileHandleResolver =
        vi.fn<(path: string) => Promise<WebFileForIndexingResolution>>();
      const getFileSizeMock = tokenCacheContext.getFileSize as unknown as ReturnType<typeof vi.fn>;
      getFileSizeMock.mockImplementation((folderId: string, path: string) => {
        if (folderId === rootFolderId && path === 'src/deep/large.txt') {
          return 800_000;
        }
        return;
      });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([largeKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).not.toHaveBeenCalled();
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('resolves web file handles in cooperative concurrent batches via Promise.all', async () => {
      const rootFolderId = 'root';
      const fileCount = 17;
      const keys: string[] = [];
      for (let i = 0; i < fileCount; i += 1) {
        keys.push(encodeFileSelection(rootFolderId, `file-${i}.ts`));
      }

      const deferredResolves = new Map<string, DeferredValue<WebFileForIndexingResolution>>();
      const webFileHandleResolver = vi.fn((absolutePath: string) => {
        const deferred = createDeferredValue<WebFileForIndexingResolution>();
        deferredResolves.set(absolutePath, deferred);
        return deferred.promise;
      });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      const { result } = renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set(),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        void result.current.triggerIndexing(keys);
        for (let index = 0; index < 5; index += 1) {
          await Promise.resolve();
        }
      });

      // Asserts batched concurrency: the first batch should fire 8 concurrent resolver calls
      // before any single one resolves. Overflow waits for a cooperative timer yield.
      expect(webFileHandleResolver).toHaveBeenCalledTimes(8);
      expect(indexFilesMock).not.toHaveBeenCalled();

      for (let i = 0; i < 8; i += 1) {
        const handle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
        deferredResolves
          .get(`${rootFolderId}/file-${i}.ts`)
          ?.resolve({ kind: 'handle', fileHandle: handle, fileSize: 128 });
      }

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(indexFilesMock).toHaveBeenCalledTimes(1);
      expect(indexFilesMock.mock.calls[0]?.[0]).toHaveLength(8);
      expect(webFileHandleResolver).toHaveBeenCalledTimes(8);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(16);

      for (let i = 8; i < 16; i += 1) {
        const handle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
        deferredResolves
          .get(`${rootFolderId}/file-${i}.ts`)
          ?.resolve({ kind: 'handle', fileHandle: handle, fileSize: 128 });
      }

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(indexFilesMock).toHaveBeenCalledTimes(2);
      expect(indexFilesMock.mock.calls[1]?.[0]).toHaveLength(8);
    });

    it('skips oversize handle resolutions after the resolver returns (post-resolution MAX_INDEXABLE_FILE_SIZE guard)', async () => {
      // Regression coverage for the P2: files in unexpanded folders never had
      // their size cached during the lazy tree walk, so the pre-resolution
      // `cache.getFileSize` guard cannot catch them. The resolver returns the
      // authoritative size from `getFile()` metadata; the dispatcher must
      // honor the platform's MAX_INDEXABLE_FILE_SIZE contract uniformly or a
      // Select All can send >750KB files to the worker and inflate token
      // totals.
      const rootFolderId = 'root';
      const oversizeKey = encodeFileSelection(rootFolderId, 'src/deep/large.ts');
      const oversizeHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
      const webFileHandleResolver = vi
        .fn<(path: string) => Promise<WebFileForIndexingResolution>>()
        .mockResolvedValue({
          kind: 'handle',
          fileHandle: oversizeHandle,
          fileSize: 800 * 1024, // > 750KB MAX_INDEXABLE_FILE_SIZE
        });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([oversizeKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      // The resolver was invoked (size wasn't cached), but the post-resolution
      // guard must drop the file before any worker dispatch.
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('skips oversize content resolutions after the resolver returns (in-memory adapter parity)', async () => {
      // Same MAX_INDEXABLE_FILE_SIZE contract for the `kind: 'content'` branch
      // that in-memory adapters (dev-fixture, future remote adapters) take.
      // The resolver pre-loads bytes on the main thread, so we already know
      // the exact size — there's no excuse for letting an oversize payload
      // reach the worker.
      const rootFolderId = 'root';
      const oversizeKey = encodeFileSelection(rootFolderId, 'src/deep/large.ts');
      const oversizeContent = 'x'.repeat(800 * 1024);
      const webFileHandleResolver = vi
        .fn<(path: string) => Promise<WebFileForIndexingResolution>>()
        .mockResolvedValue({
          kind: 'content',
          content: oversizeContent,
          fileSize: oversizeContent.length,
        });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      renderHook(() =>
        useBackgroundTokenIndexerIntegration({
          fileTree: [],
          selectedFiles: new Set([oversizeKey]),
          webFileHandleResolver,
          onTokenResolved: vi.fn(),
        })
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).not.toHaveBeenCalled();
    });

    it('does not retry an oversize resolver result after a FileTreeIndex version bump (terminal skip)', async () => {
      // The size came directly from the file system — re-attempting after an
      // index bump would just hit the same guard and waste another resolver
      // round-trip. Confirm the key is marked terminally indexed (not parked
      // in `pendingNoHandleRef`).
      const rootFolderId = 'root';
      const oversizeKey = encodeFileSelection(rootFolderId, 'src/deep/large.ts');
      const oversizeHandle = { getFile: vi.fn() } as unknown as FileSystemFileHandle;
      const webFileHandleResolver = vi
        .fn<(path: string) => Promise<WebFileForIndexingResolution>>()
        .mockResolvedValue({
          kind: 'handle',
          fileHandle: oversizeHandle,
          fileSize: 800 * 1024,
        });

      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 1,
      };

      const { rerender } = renderHook(
        (selectedFiles: Set<string>) =>
          useBackgroundTokenIndexerIntegration({
            fileTree: [],
            selectedFiles,
            webFileHandleResolver,
            onTokenResolved: vi.fn(),
          }),
        { initialProps: new Set([oversizeKey]) }
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);

      // Bump the FileTreeIndex version to trigger pending re-evaluation.
      mockFileTreeIndexContext = {
        getHandle: vi.fn(() => undefined),
        getNode: vi.fn(() => undefined),
        stats: { totalDirectories: 0, totalFiles: 0, totalNodes: 0 },
        version: 2,
      };
      rerender(new Set([oversizeKey]));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Resolver is NOT called again -- the key was marked terminally indexed
      // by the post-resolution size guard.
      expect(webFileHandleResolver).toHaveBeenCalledTimes(1);
      expect(indexFilesMock).not.toHaveBeenCalled();
    });
  });

  it('uses backslashes when synthesizing electron paths from mixed-separator windows roots', async () => {
    const rootFolderId = 'C:\\Users/me/project';
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

    expect(electronFileReader).toHaveBeenCalledWith({
      kind: 'file',
      name: 'file.ts',
      path: 'C:\\Users/me/project\\src\\deep\\file.ts',
      platform: 'electron',
    });
  });
});
