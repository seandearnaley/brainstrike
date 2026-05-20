import { addLogListener, type LogRecord } from '@brainstrike/utils/logger';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { usePersistentTokenCache } from '../indexing/use-persistent-token-cache';
import type { TokenCountingState } from '../indexing/use-token-counting';

let mockContext: TokenCacheContextValue | null = null;

vi.mock('../indexing/token-cache-context', () => ({
  useOptionalTokenCacheContext: () => mockContext,
}));

const decodeFileSelection = (compositeKey: string): { folderId: string; path: string } => {
  const [folderId = '', path = ''] = compositeKey.split('::');
  return { folderId, path };
};

const createTokenCounting = () =>
  ({
    mode: 'heuristic',
    reason: null,
    loading: false,
    countTokens: vi.fn(async (content: string) => content.length),
  }) as TokenCountingState;

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('usePersistentTokenCache', () => {
  let tokenCounting: TokenCountingState;
  let fileContents: Record<string, string>;
  let onTokenResolved: () => void;
  let logEntries: LogRecord[];
  let removeLogListener: (() => void) | null;

  beforeEach(() => {
    tokenCounting = createTokenCounting();
    fileContents = {};
    onTokenResolved = vi.fn();
    mockContext = null;
    logEntries = [];
    removeLogListener = addLogListener((entry) => {
      logEntries.push(entry);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockContext = null;
    removeLogListener?.();
    removeLogListener = null;
  });

  const renderCacheHook = () =>
    renderHook(() =>
      usePersistentTokenCache({
        fileContents,
        tokenCounting,
        decodeFileSelection,
        onTokenResolved,
      })
    );

  describe('with persistent cache available', () => {
    beforeEach(() => {
      mockContext = {
        isReady: true, // Deprecated - kept for backwards compatibility
        isOperational: true, // Worker + hasher ready
        isPersisted: true, // DB-backed storage available
        persistenceMode: 'persistent',
        isWorkerReady: true,
        countingMode: 'accurate',
        countTextTokens: vi.fn(async () => 0),
        cacheVersion: 3,
        getTokenCount: vi.fn(() => 42),
        getFileSize: vi.fn(() => 1024),
        getTotalTokens: vi.fn(async () => 0),
        isLoading: vi.fn(() => false),
        isAnyLoading: false,
        queueForCounting: vi.fn(),
        preloadFolder: vi.fn(async () => {}),
        clearHotCache: vi.fn(),
        invalidate: vi.fn(),
        updateHotCache: vi.fn(),
        updateFileSizeCache: vi.fn(),
        store: {} as TokenCacheContextValue['store'],
      };
    });

    it('returns token count from persistent hot cache', () => {
      fileContents['folder::file.txt'] = 'hello';
      const { result } = renderCacheHook();

      const value = result.current.getTokenCount('folder::file.txt');
      expect(value).toBe(42);
      expect(mockContext?.getTokenCount).toHaveBeenCalledWith('folder', 'file.txt', 'hello');
    });

    it('normalizes restored absolute paths before reading persistent token counts', () => {
      fileContents['/repo::/repo/src/file.txt'] = 'hello';
      const { result } = renderCacheHook();

      const value = result.current.getTokenCount('/repo::/repo/src/file.txt');
      expect(value).toBe(42);
      expect(mockContext?.getTokenCount).toHaveBeenCalledWith('/repo', 'src/file.txt', 'hello');
    });

    it('normalizes restored absolute paths before reading persistent file sizes', () => {
      const { result } = renderCacheHook();

      const value = result.current.getFileSize('/repo::/repo/src/file.txt');
      expect(value).toBe(1024);
      expect(mockContext?.getFileSize).toHaveBeenCalledWith('/repo', 'src/file.txt');
    });

    it('returns undefined when persistent cache reports loading', () => {
      (mockContext!.getTokenCount as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      const { result } = renderCacheHook();

      const value = result.current.getTokenCount('folder::file.txt');
      expect(value).toBeUndefined();
      expect(tokenCounting.countTokens).not.toHaveBeenCalled();
    });

    it('forwards content when triggering persistent counting', () => {
      (mockContext!.getTokenCount as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      fileContents['folder::file.txt'] = 'content-here';

      const { result } = renderCacheHook();
      result.current.getTokenCount('folder::file.txt');

      expect(mockContext?.getTokenCount).toHaveBeenCalledWith('folder', 'file.txt', 'content-here');
    });

    it('exposes cacheVersion from context', () => {
      const { result } = renderCacheHook();
      expect(result.current.cacheVersion).toBe(3);
      expect(result.current.isAnyLoading).toBe(false);
    });

    it('aggregates cached selection stats from the persistent store without file contents', async () => {
      const storeGetBatch = vi.fn(async (folderId: string, filePaths: string[]) => {
        if (folderId !== 'folder') {
          return new Map();
        }
        return new Map(
          filePaths.map((filePath, index) => [
            filePath,
            {
              folderId,
              filePath,
              tokenCount: (index + 1) * 100,
            },
          ])
        );
      });

      mockContext = {
        ...mockContext!,
        store: {
          getBatch: storeGetBatch,
        } as unknown as TokenCacheContextValue['store'],
      };

      const { result } = renderCacheHook();
      const aggregateStats = await result.current.getCachedSelectionStats(
        new Set(['folder::src/a.ts', 'folder::src/b.ts'])
      );

      expect(storeGetBatch).toHaveBeenCalledWith('folder', ['src/a.ts', 'src/b.ts']);
      expect(aggregateStats).toEqual({
        cachedFileCount: 2,
        tokenCounts: new Map([
          ['folder::src/a.ts', 100],
          ['folder::src/b.ts', 200],
        ]),
        totalTokens: 300,
      });
    });

    it('normalizes restored absolute paths before persistent batch lookups', async () => {
      const storeGetBatch = vi.fn(async (folderId: string, filePaths: string[]) => {
        if (folderId !== '/repo') {
          return new Map();
        }
        return new Map(
          filePaths.map((filePath) => [
            filePath,
            {
              folderId,
              filePath,
              tokenCount: 100,
            },
          ])
        );
      });

      mockContext = {
        ...mockContext!,
        store: {
          getBatch: storeGetBatch,
        } as unknown as TokenCacheContextValue['store'],
      };

      const { result } = renderCacheHook();
      const aggregateStats = await result.current.getCachedSelectionStats(
        new Set(['/repo::/repo/src/a.ts', '/repo::/repo/src/b.ts'])
      );

      expect(storeGetBatch).toHaveBeenCalledWith('/repo', ['src/a.ts', 'src/b.ts']);
      expect(aggregateStats).toEqual({
        cachedFileCount: 2,
        tokenCounts: new Map([
          ['/repo::/repo/src/a.ts', 100],
          ['/repo::/repo/src/b.ts', 100],
        ]),
        totalTokens: 200,
      });
    });

    it('does not fall back to strict in-memory counting while the shared cache is still booting', () => {
      mockContext = {
        ...mockContext!,
        isOperational: false,
        isAnyLoading: true,
      };

      fileContents['folder::file.txt'] = 'hello';
      const { result } = renderCacheHook();

      expect(result.current.getTokenCount('folder::file.txt')).toBeUndefined();
      expect(mockContext?.getTokenCount).not.toHaveBeenCalled();
      expect(tokenCounting.countTokens).not.toHaveBeenCalled();
    });
  });

  describe('fallback to in-memory cache', () => {
    it('uses in-memory cache when persistent context is null', async () => {
      fileContents['folder::file.txt'] = 'hello';
      const { result, rerender } = renderCacheHook();

      expect(result.current.getTokenCount('folder::file.txt')).toBeUndefined();
      expect(tokenCounting.countTokens).toHaveBeenCalledTimes(1);

      await flushMicrotasks();
      rerender();

      expect(result.current.getTokenCount('folder::file.txt')).toBe(5);
      expect(onTokenResolved).toHaveBeenCalledTimes(1);
    });

    it('does not double-count while pending', async () => {
      let resolveCount: ((value: number) => void) | null = null;
      tokenCounting.countTokens = vi.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveCount = resolve;
          })
      );

      fileContents['folder::file.txt'] = 'hello';
      const { result, rerender } = renderCacheHook();

      result.current.getTokenCount('folder::file.txt');
      result.current.getTokenCount('folder::file.txt');

      expect(tokenCounting.countTokens).toHaveBeenCalledTimes(1);

      rerender();
      expect(result.current.isAnyLoading).toBe(true);

      act(() => {
        resolveCount?.(3);
      });
      await flushMicrotasks();
      rerender();

      expect(result.current.isAnyLoading).toBe(false);
      expect(result.current.getTokenCount('folder::file.txt')).toBe(3);
    });

    it('does not silently cache heuristic counts when counting fails', async () => {
      tokenCounting.countTokens = vi.fn(async () => {
        throw new Error('boom');
      });

      fileContents['folder::err.txt'] = 'abcdef';
      const { result } = renderCacheHook();

      expect(result.current.getTokenCount('folder::err.txt')).toBeUndefined();
      await flushMicrotasks();

      expect(result.current.getTokenCount('folder::err.txt')).toBeUndefined();
      expect(tokenCounting.countTokens).toHaveBeenCalledTimes(1);
      expect(onTokenResolved).toHaveBeenCalled();
      expect(
        logEntries.some(
          (entry) =>
            entry.scope === 'PersistentTokenCache' &&
            entry.message === 'Strict token counting failed'
        )
      ).toBe(true);
    });

    it('retries failed token counts after the cooldown expires', async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        tokenCounting.countTokens = vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('transient');
          }
          return 7;
        });

        fileContents['folder::retry.txt'] = 'abcdefg';
        const { result, rerender } = renderCacheHook();

        expect(result.current.getTokenCount('folder::retry.txt')).toBeUndefined();
        await flushMicrotasks();

        expect(result.current.getTokenCount('folder::retry.txt')).toBeUndefined();
        expect(tokenCounting.countTokens).toHaveBeenCalledTimes(1);

        await act(async () => {
          vi.advanceTimersByTime(5001);
          await Promise.resolve();
        });

        expect(result.current.getTokenCount('folder::retry.txt')).toBeUndefined();
        await flushMicrotasks();
        rerender();

        expect(tokenCounting.countTokens).toHaveBeenCalledTimes(2);
        expect(result.current.getTokenCount('folder::retry.txt')).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips counting for inaccessible content', () => {
      fileContents['folder::blocked.txt'] = 'File not accessible - permission denied';
      const { result } = renderCacheHook();

      expect(result.current.getTokenCount('folder::blocked.txt')).toBeUndefined();
      expect(tokenCounting.countTokens).not.toHaveBeenCalled();
    });

    it('skips counting for binary files', () => {
      fileContents['folder::bin.dat'] = 'Binary file preview is not available';
      const { result } = renderCacheHook();

      expect(result.current.getTokenCount('folder::bin.dat')).toBeUndefined();
      expect(tokenCounting.countTokens).not.toHaveBeenCalled();
    });
  });
});
