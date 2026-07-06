import { TOKEN_ESTIMATOR_ID } from '@brainstrike/utils/token-counting-heuristics';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheEntry, TokenCountingMode, TokenCountResult } from '../types';
import { useTokenCache } from '../use-token-cache';

const VERSION_DEBOUNCE_MS = 50;

interface StoreMock {
  get: ReturnType<typeof vi.fn>;
  getAllForFolder: ReturnType<typeof vi.fn>;
  getTotalTokens: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

interface WorkerPoolMock {
  exec: ReturnType<typeof vi.fn>;
}

interface HasherMock {
  hashContent: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
}

const createStoreMock = (): StoreMock => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  getTotalTokens: vi.fn(async () => 0),
  getAllForFolder: vi.fn(async () => []),
});

const createHasherMock = (): HasherMock => ({
  init: vi.fn(async () => {}),
  hashContent: vi.fn(async (content: string) => `hash:${content}`),
});

const createWorkerPoolMock = (): WorkerPoolMock => ({
  exec: vi.fn(async (_method: string, args: unknown[]): Promise<TokenCountResult> => {
    const payload = args[0] as { id: string; content: string; mode: TokenCountingMode };
    return {
      id: payload.id,
      tokenCount: payload.content.length,
      contentHash: `hash:${payload.content}`,
      mode: payload.mode,
    };
  }),
});

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useTokenCache', () => {
  let store: StoreMock;
  let workerPool: WorkerPoolMock;
  let hasher: HasherMock;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStoreMock();
    workerPool = createWorkerPoolMock();
    hasher = createHasherMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const renderCacheHook = (countingMode: TokenCountingMode = 'accurate') =>
    renderHook(() =>
      useTokenCache({
        store: store as unknown as Parameters<typeof useTokenCache>[0]['store'],
        hasher: hasher as unknown as Parameters<typeof useTokenCache>[0]['hasher'],
        workerPool: workerPool as unknown as Parameters<typeof useTokenCache>[0]['workerPool'],
        countingMode,
      })
    );

  it('returns cached value from hot cache immediately', () => {
    const { result } = renderCacheHook();

    act(() => {
      result.current.updateHotCache('folder', 'file.txt', 123);
    });

    const value = result.current.getTokenCount('folder', 'file.txt');
    expect(value).toBe(123);
  });

  it('normalizes absolute paths for hot cache lookups', () => {
    const { result } = renderCacheHook();
    const absolutePath = '/Users/me/brainstrike copy 2/scripts/merge-coverage.js';

    act(() => {
      result.current.updateHotCache('brainstrike copy 2', absolutePath, 321);
    });

    expect(result.current.getTokenCount('brainstrike copy 2', absolutePath)).toBe(321);
    expect(result.current.getTokenCount('brainstrike copy 2', 'scripts/merge-coverage.js')).toBe(
      321
    );
  });

  it('returns null and triggers background count when not cached', async () => {
    const { result, rerender } = renderCacheHook();

    let value: number | null = 0;
    await act(async () => {
      value = result.current.getTokenCount('folder', 'file.txt', 'hello world');
    });
    expect(value).toBeNull();

    // Trigger another render to process deferred load queue
    await act(async () => {
      rerender();
    });

    await flushMicrotasks();

    expect(workerPool.exec).toHaveBeenCalledTimes(1);
    const call = workerPool.exec.mock.calls[0]!;
    expect(call[0]).toBe('countTokens');
    expect((call[1] as [{ id: string }])[0]?.id).toBe('folder::file.txt');
  });

  it('does not re-trigger count for pending requests', async () => {
    let resolveExec: (() => void) | null = null;
    workerPool.exec = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExec = () =>
            resolve({
              id: 'folder::file.txt',
              tokenCount: 10,
              contentHash: 'hash:content',
              mode: 'accurate',
            });
        })
    );

    const { result, rerender } = renderCacheHook();

    await act(async () => {
      expect(result.current.getTokenCount('folder', 'file.txt', 'content')).toBeNull();
      expect(result.current.getTokenCount('folder', 'file.txt', 'content')).toBeNull();
    });

    // Trigger another render to process deferred load queue
    await act(async () => {
      rerender();
    });

    await flushMicrotasks();
    expect(workerPool.exec).toHaveBeenCalledTimes(1);

    act(() => {
      resolveExec?.();
    });
    await flushMicrotasks();
  });

  it('does not duplicate deferred work for absolute-path requests', async () => {
    const absolutePath = '/Users/me/project/src/file.txt';
    const { result, rerender } = renderCacheHook();

    await act(async () => {
      expect(result.current.getTokenCount('project', absolutePath, 'content')).toBeNull();
      expect(result.current.getTokenCount('project', absolutePath, 'content')).toBeNull();
    });

    await act(async () => {
      rerender();
    });

    await flushMicrotasks();
    expect(workerPool.exec).toHaveBeenCalledTimes(1);
  });

  it('uses persistent cache when hash, counting mode, and estimator identity match', async () => {
    const cachedEntry: TokenCacheEntry = {
      folderId: 'folder',
      filePath: 'file.txt',
      contentHash: 'hash:content',
      fileSize: 10,
      mtimeMs: null,
      tokenCount: 99,
      countingMode: 'heuristic',
      modelEncoding: TOKEN_ESTIMATOR_ID,
    };

    store.get.mockResolvedValueOnce(cachedEntry);

    const { result, rerender } = renderCacheHook('heuristic');

    let value: number | null = 0;
    await act(async () => {
      value = result.current.getTokenCount('folder', 'file.txt', 'content');
    });
    expect(value).toBeNull(); // initial lookup is async

    // Trigger another render to process deferred load queue
    await act(async () => {
      rerender();
    });

    await flushMicrotasks();
    // Allow debounced version update to complete
    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(workerPool.exec).not.toHaveBeenCalled();
    expect(result.current.getTokenCount('folder', 'file.txt')).toBe(99);
  });

  it('ignores stale persistent cache entries whose estimator identity does not match', async () => {
    const cachedEntry: TokenCacheEntry = {
      folderId: 'folder',
      filePath: 'file.txt',
      contentHash: 'hash:content',
      fileSize: 10,
      mtimeMs: null,
      tokenCount: 99,
      countingMode: 'heuristic',
      modelEncoding: 'o200k_base',
    };

    store.get.mockResolvedValueOnce(cachedEntry);

    const { result, rerender } = renderCacheHook('heuristic');

    await act(async () => {
      expect(result.current.getTokenCount('folder', 'file.txt', 'content')).toBeNull();
    });

    await act(async () => {
      rerender();
    });

    await flushMicrotasks();

    expect(workerPool.exec).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(
      expect.objectContaining({
        countingMode: 'heuristic',
        modelEncoding: TOKEN_ESTIMATOR_ID,
      })
    );
  });

  it('updates hot cache after counting and calls onTokenResolved', async () => {
    const onTokenResolved = vi.fn();
    const { result, rerender } = renderHook(() =>
      useTokenCache({
        store: store as unknown as Parameters<typeof useTokenCache>[0]['store'],
        hasher: hasher as unknown as Parameters<typeof useTokenCache>[0]['hasher'],
        workerPool: workerPool as unknown as Parameters<typeof useTokenCache>[0]['workerPool'],
        countingMode: 'heuristic',
        onTokenResolved,
      })
    );

    await act(async () => {
      expect(result.current.getTokenCount('folder', 'file.txt', 'hello')).toBeNull();
    });

    // Trigger another render to process deferred load queue
    await act(async () => {
      rerender();
    });

    await flushMicrotasks();
    // Allow debounced version update to complete
    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(
      expect.objectContaining({
        countingMode: 'heuristic',
        modelEncoding: TOKEN_ESTIMATOR_ID,
      })
    );
    expect(onTokenResolved).toHaveBeenCalledWith('folder', 'file.txt', 5);
    expect(result.current.getTokenCount('folder', 'file.txt')).toBe(5);
  });

  it('normalizes absolute paths before store access and persistence', async () => {
    const absolutePath = '/Users/me/brainstrike copy 2/scripts/merge-coverage.js';
    const normalizedPath = 'scripts/merge-coverage.js';
    const { result, rerender } = renderCacheHook();

    await act(async () => {
      expect(result.current.getTokenCount('brainstrike copy 2', absolutePath, 'hello')).toBeNull();
    });

    await act(async () => {
      rerender();
    });

    await flushMicrotasks();

    expect(store.get).toHaveBeenCalledWith('brainstrike copy 2', normalizedPath);
    expect(workerPool.exec).toHaveBeenCalledWith('countTokens', [
      expect.objectContaining({ id: `brainstrike copy 2::${normalizedPath}` }),
    ]);
    expect(store.set).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'brainstrike copy 2', filePath: normalizedPath })
    );
  });

  it('skips unsafe traversal paths and does not queue background work', async () => {
    const traversalPath = '/Users/me/project/../secret.txt';
    const { result, rerender } = renderCacheHook();

    await act(async () => {
      expect(result.current.getTokenCount('project', traversalPath, 'secret')).toBeNull();
    });

    await act(async () => {
      rerender();
    });

    await flushMicrotasks();

    expect(workerPool.exec).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(result.current.isLoading('project', traversalPath)).toBe(false);
    expect(result.current.getFileSize('project', traversalPath)).toBeUndefined();
  });

  it('filters unsafe traversal paths when aggregating total tokens', async () => {
    const { result } = renderCacheHook();
    store.getTotalTokens.mockResolvedValueOnce(7);

    await expect(
      result.current.getTotalTokens('project', [
        '/Users/me/project/src/file-a.ts',
        '/Users/me/project/../secret.txt',
      ])
    ).resolves.toBe(7);

    expect(store.getTotalTokens).toHaveBeenCalledWith('project', ['src/file-a.ts']);
  });

  it('updateHotCache bumps cacheVersion once after debounce', () => {
    const { result } = renderCacheHook();

    expect(result.current.cacheVersion).toBe(0);

    act(() => {
      result.current.updateHotCache('folder', 'a.txt', 1);
    });

    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS - 1);
    });
    expect(result.current.cacheVersion).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.cacheVersion).toBe(1);
  });

  it('debounces rapid cache updates into a single version bump', () => {
    const { result } = renderCacheHook();

    act(() => {
      result.current.updateHotCache('folder', 'a.txt', 1);
      result.current.updateHotCache('folder', 'b.txt', 2);
      result.current.updateHotCache('folder', 'c.txt', 3);
    });

    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(result.current.cacheVersion).toBe(1);
  });

  it('clears scheduled debounce on unmount to avoid post-unmount updates', () => {
    const { result, unmount } = renderCacheHook();

    act(() => {
      result.current.updateHotCache('folder', 'a.txt', 1);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clearHotCache removes entries and bumps version', () => {
    const { result } = renderCacheHook();

    act(() => {
      result.current.updateHotCache('folder', 'file.txt', 42);
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.cacheVersion).toBe(1);
    expect(result.current.getTokenCount('folder', 'file.txt')).toBe(42);

    act(() => {
      result.current.clearHotCache();
    });
    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(result.current.cacheVersion).toBe(2);
    expect(result.current.getTokenCount('folder', 'file.txt')).toBeNull();
  });

  it('invalidate removes specified entries', () => {
    const { result } = renderCacheHook();

    act(() => {
      result.current.updateHotCache('folder', 'keep.txt', 1);
      result.current.updateHotCache('folder', 'drop.txt', 2);
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(result.current.getTokenCount('folder', 'drop.txt')).toBe(2);

    act(() => {
      result.current.invalidate('folder', ['drop.txt']);
    });
    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(result.current.getTokenCount('folder', 'keep.txt')).toBe(1);
    expect(result.current.getTokenCount('folder', 'drop.txt')).toBeNull();
    expect(result.current.cacheVersion).toBe(2);
  });

  it('preloadFolder populates hot cache only for matching counting mode', async () => {
    const entries: TokenCacheEntry[] = [
      {
        folderId: 'folder',
        filePath: 'a.ts',
        tokenCount: 10,
        contentHash: 'hash:a',
        fileSize: 1,
        mtimeMs: null,
        countingMode: 'heuristic',
        modelEncoding: TOKEN_ESTIMATOR_ID,
      },
      {
        folderId: 'folder',
        filePath: 'b.ts',
        tokenCount: 20,
        contentHash: 'hash:b',
        fileSize: 1,
        mtimeMs: null,
        countingMode: 'heuristic',
        modelEncoding: null,
      },
    ];
    store.getAllForFolder.mockResolvedValueOnce(entries);

    const { result } = renderCacheHook('heuristic');

    await act(async () => {
      await result.current.preloadFolder('folder');
    });

    expect(result.current.getTokenCount('folder', 'a.ts')).toBe(10);
    expect(result.current.getTokenCount('folder', 'b.ts')).toBeNull();
  });

  it('increments cacheVersion when preload populates cache', async () => {
    store.getAllForFolder.mockResolvedValueOnce([
      {
        folderId: 'folder',
        filePath: 'a.ts',
        tokenCount: 10,
        contentHash: 'hash:a',
        fileSize: 1,
        mtimeMs: null,
        countingMode: 'accurate',
        modelEncoding: 'o200k_base',
      },
    ]);

    const { result } = renderCacheHook('accurate');
    expect(result.current.cacheVersion).toBe(0);

    await act(async () => {
      await result.current.preloadFolder('folder');
    });

    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });
    expect(result.current.cacheVersion).toBe(1);
  });

  it('clears hot cache when countingMode changes', () => {
    const { result, rerender } = renderHook(
      (mode: TokenCountingMode) =>
        useTokenCache({
          store: store as unknown as Parameters<typeof useTokenCache>[0]['store'],
          hasher: hasher as unknown as Parameters<typeof useTokenCache>[0]['hasher'],
          workerPool: workerPool as unknown as Parameters<typeof useTokenCache>[0]['workerPool'],
          countingMode: mode,
        }),
      { initialProps: 'heuristic' as TokenCountingMode }
    );

    act(() => {
      result.current.updateHotCache('folder', 'file.txt', 7);
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.getTokenCount('folder', 'file.txt')).toBe(7);

    rerender('accurate');

    act(() => {
      vi.advanceTimersByTime(VERSION_DEBOUNCE_MS);
    });

    expect(result.current.getTokenCount('folder', 'file.txt')).toBeNull();
  });

  it('getTotalTokens delegates to store', async () => {
    store.getTotalTokens.mockResolvedValueOnce(123);
    const { result } = renderCacheHook();

    const total = await result.current.getTotalTokens('folder', ['a.ts', 'b.ts']);

    expect(total).toBe(123);
    expect(store.getTotalTokens).toHaveBeenCalledWith('folder', ['a.ts', 'b.ts']);
  });

  it('getTotalTokens returns 0 for empty selection', async () => {
    const { result } = renderCacheHook();
    const total = await result.current.getTotalTokens('folder', []);
    expect(total).toBe(0);
    expect(store.getTotalTokens).not.toHaveBeenCalled();
  });

  it('queueForCounting enqueues multiple files with metadata', async () => {
    const { result } = renderCacheHook();

    await act(async () => {
      result.current.queueForCounting([
        { folderId: 'folder', filePath: 'a.ts', content: 'aaa', fileSize: 3, mtimeMs: 100 },
        { folderId: 'folder', filePath: 'b.ts', content: 'bbbb', fileSize: 4, mtimeMs: 200 },
      ]);
    });

    await flushMicrotasks();

    expect(workerPool.exec).toHaveBeenCalledTimes(2);
    expect(store.set).toHaveBeenCalledTimes(2);
    const firstSetArg = store.set.mock.calls[0]![0] as TokenCacheEntry;
    expect(firstSetArg.fileSize).toBe(3);
    expect(firstSetArg.mtimeMs).toBe(100);
  });

  it('isAnyLoading reflects pending background work', async () => {
    let resolveExec: (() => void) | null = null;
    workerPool.exec = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExec = () =>
            resolve({
              id: 'folder::file.txt',
              tokenCount: 1,
              contentHash: 'hash:c',
              mode: 'accurate',
            });
        })
    );

    const { result } = renderCacheHook();

    expect(result.current.isAnyLoading).toBe(false);

    await act(async () => {
      result.current.queueForCounting([{ folderId: 'folder', filePath: 'file.txt', content: 'c' }]);
    });

    await flushMicrotasks();
    expect(result.current.isAnyLoading).toBe(true);

    await act(async () => {
      resolveExec?.();
    });
    await flushMicrotasks();
    act(() => {
      vi.runAllTimers();
    });

    expect(result.current.isAnyLoading).toBe(false);
  });
});
