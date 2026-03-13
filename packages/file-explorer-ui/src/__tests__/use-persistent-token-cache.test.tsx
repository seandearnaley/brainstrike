import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenCacheContextValue } from '../token-cache-context';
import { usePersistentTokenCache } from '../use-persistent-token-cache';
import type { TokenCountingState } from '../use-token-counting';

let mockContext: TokenCacheContextValue | null = null;

vi.mock('../token-cache-context', () => ({
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

  beforeEach(() => {
    tokenCounting = createTokenCounting();
    fileContents = {};
    onTokenResolved = vi.fn();
    mockContext = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockContext = null;
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
