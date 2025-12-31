import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Pool } from 'workerpool';
import type { TokenCacheEntry, TokenCountingMode, TokenCountResult } from '../types';
import { useTokenCache } from '../use-token-cache';

const VERSION_DEBOUNCE_MS = 50;

type StoreMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  getTotalTokens: ReturnType<typeof vi.fn>;
  getAllForFolder: ReturnType<typeof vi.fn>;
};

type WorkerPoolMock = {
  exec: ReturnType<typeof vi.fn>;
};

type HasherMock = {
  init: ReturnType<typeof vi.fn>;
  hashContent: ReturnType<typeof vi.fn>;
};

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
        workerPool: workerPool as unknown as Pool,
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

  it('uses persistent cache when hash matches and counting mode matches', async () => {
    const cachedEntry: TokenCacheEntry = {
      folderId: 'folder',
      filePath: 'file.txt',
      contentHash: 'hash:content',
      fileSize: 10,
      mtimeMs: null,
      tokenCount: 99,
      countingMode: 'accurate',
      modelEncoding: 'o200k_base',
    };

    store.get.mockResolvedValueOnce(cachedEntry);

    const { result, rerender } = renderCacheHook('accurate');

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

  it('updates hot cache after counting and calls onTokenResolved', async () => {
    const onTokenResolved = vi.fn();
    const { result, rerender } = renderHook(() =>
      useTokenCache({
        store: store as unknown as Parameters<typeof useTokenCache>[0]['store'],
        hasher: hasher as unknown as Parameters<typeof useTokenCache>[0]['hasher'],
        workerPool: workerPool as unknown as Pool,
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
    expect(onTokenResolved).toHaveBeenCalledWith('folder', 'file.txt', 5);
    expect(result.current.getTokenCount('folder', 'file.txt')).toBe(5);
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
        countingMode: 'accurate',
        modelEncoding: 'o200k_base',
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

    const { result } = renderCacheHook('accurate');

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
          workerPool: workerPool as unknown as Pool,
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
    expect(store.getTotalTokens).toHaveBeenCalledWith('folder', []);
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
