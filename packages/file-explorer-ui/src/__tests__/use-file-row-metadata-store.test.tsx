import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONCILE_METADATA_DEBOUNCE_MS, RECONCILE_METADATA_MAX_WAIT_MS } from '../constants';
import type { FileRowDirectorySubtree } from '../indexing/file-row-metadata-store';
import type { TokenCacheContextValue } from '../indexing/token-cache-context';
import { useFileRowMetadataStore } from '../indexing/use-file-row-metadata-store';
import {
  createFileExplorerRefreshEvent,
  type FileExplorerRefreshEventDetail,
} from '../shell/file-explorer-refresh-event';

let mockContext: TokenCacheContextValue | null = null;

vi.mock('../indexing/token-cache-context', () => ({
  useOptionalTokenCacheContext: () => mockContext,
}));

const ROOT = 'root-id';
const UNKNOWN_SUBTREE: FileRowDirectorySubtree = {
  fileKeys: [],
  incompleteReason: 'not-enumerated',
  isComplete: false,
};
const FILE_A = encodeFileSelection(ROOT, 'src/a.ts');
const FILE_B = encodeFileSelection(ROOT, 'src/b.ts');

interface StubCacheState {
  cacheVersion: number;
  isOperational: boolean;
  sizes: Record<string, number>;
  tokens: Record<string, number>;
}

function stubTokenCache(state: StubCacheState): TokenCacheContextValue {
  return {
    cacheVersion: state.cacheVersion,
    getFileSize: (folderId: string, filePath: string) =>
      state.sizes[encodeFileSelection(folderId, filePath)],
    getTokenCount: (folderId: string, filePath: string) =>
      state.tokens[encodeFileSelection(folderId, filePath)] ?? null,
    isOperational: state.isOperational,
  } as unknown as TokenCacheContextValue;
}

const REFRESH_DETAIL: FileExplorerRefreshEventDetail = {
  roots: [],
  scope: 'full',
  source: 'manual',
};

/** Let the trailing reconciliation window elapse. */
function settleReconcile(): void {
  act(() => {
    vi.advanceTimersByTime(RECONCILE_METADATA_DEBOUNCE_MS);
  });
}

describe('useFileRowMetadataStore', () => {
  let nodeSizes: Record<string, number>;
  let subtrees: Record<string, FileRowDirectorySubtree>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockContext = null;
    nodeSizes = {};
    subtrees = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const renderStore = () =>
    renderHook(() =>
      useFileRowMetadataStore({
        getDirectorySubtree: (compositeKey) => subtrees[compositeKey] ?? UNKNOWN_SUBTREE,
        getNodeSize: (compositeKey) => nodeSizes[compositeKey],
      })
    );

  it('reports pending tokens when no token cache is mounted', () => {
    const { result } = renderStore();
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe('pending');
  });

  it('reports pending tokens while the token cache is not operational', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: false,
      sizes: {},
      tokens: { [FILE_A]: 40 },
    });
    const { result } = renderStore();
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe('pending');
  });

  it('reads counted tokens from the operational token cache', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: { [FILE_A]: 40 },
    });
    const { result } = renderStore();
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe(40);
  });

  it('prefers the tree node size and falls back to the token cache size', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: { [FILE_A]: 64 },
      tokens: {},
    });
    const { result } = renderStore();
    expect(result.current.store.getSnapshot(FILE_A).size).toBe(64);

    nodeSizes[FILE_A] = 128;
    // A source change alone must not move the snapshot; only an invalidation does.
    expect(result.current.store.getSnapshot(FILE_A).size).toBe(64);
  });

  it('keeps one store and one stable handler across re-renders', () => {
    const { result, rerender } = renderStore();
    const first = result.current;
    rerender();
    expect(result.current.store).toBe(first.store);
    expect(result.current.onTokenResolved).toBe(first.onTokenResolved);
  });

  it('invalidates ONLY the resolved key when a count arrives', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result } = renderStore();
    const resolvedListener = vi.fn();
    const untouchedListener = vi.fn();
    result.current.store.subscribe(FILE_A, resolvedListener);
    result.current.store.subscribe(FILE_B, untouchedListener);
    const untouchedSnapshot = result.current.store.getSnapshot(FILE_B);
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe('pending');

    state.tokens[FILE_A] = 21;
    act(() => {
      result.current.onTokenResolved(FILE_A);
    });

    expect(resolvedListener).toHaveBeenCalledTimes(1);
    expect(untouchedListener).not.toHaveBeenCalled();
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe(21);
    expect(result.current.store.getSnapshot(FILE_B)).toBe(untouchedSnapshot);
  });

  it('coalesces a burst of cache-version bumps into ONE reconciliation', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const invalidateAllSpy = vi.spyOn(result.current.store, 'invalidateAll');
    settleReconcile();
    invalidateAllSpy.mockClear();

    // Five version bumps inside one window — the shape of an index run, where
    // the 50ms-debounced cacheVersion fires ~20x/s.
    for (let bump = 0; bump < 5; bump += 1) {
      state.cacheVersion += 1;
      mockContext = stubTokenCache(state);
      act(() => {
        rerender();
        vi.advanceTimersByTime(RECONCILE_METADATA_DEBOUNCE_MS / 10);
      });
    }
    expect(invalidateAllSpy).not.toHaveBeenCalled();

    settleReconcile();
    expect(invalidateAllSpy).toHaveBeenCalledTimes(1);
  });

  it('reconciles by the max wait while cache-version bumps keep streaming', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const invalidateAllSpy = vi.spyOn(result.current.store, 'invalidateAll');
    settleReconcile();
    invalidateAllSpy.mockClear();

    const churnIntervalMs = RECONCILE_METADATA_DEBOUNCE_MS / 5;
    for (
      let elapsedMs = 0;
      elapsedMs < RECONCILE_METADATA_MAX_WAIT_MS;
      elapsedMs += churnIntervalMs
    ) {
      state.cacheVersion += 1;
      mockContext = stubTokenCache(state);
      act(() => {
        rerender();
        vi.advanceTimersByTime(churnIntervalMs);
      });
    }

    act(() => {
      vi.advanceTimersByTime(churnIntervalMs);
    });
    expect(invalidateAllSpy).toHaveBeenCalledTimes(1);
  });

  it('still surfaces bulk cache warms that name no key', () => {
    // preloadFolder / warm-cache hydration write the hot cache without an
    // onTokenResolved, so the reconciliation pass is what makes them visible.
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const listener = vi.fn();
    result.current.store.subscribe(FILE_A, listener);
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe('pending');

    state.tokens[FILE_A] = 77;
    state.cacheVersion = 2;
    mockContext = stubTokenCache(state);
    act(() => {
      rerender();
    });
    settleReconcile();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe(77);
  });

  it('invalidates immediately when the token cache becomes operational', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: false,
      sizes: {},
      tokens: { [FILE_A]: 9 },
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const listener = vi.fn();
    result.current.store.subscribe(FILE_A, listener);
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe('pending');

    state.isOperational = true;
    mockContext = stubTokenCache(state);
    act(() => {
      rerender();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.store.getSnapshot(FILE_A).tokens).toBe(9);
  });

  it('invalidates on the shared file-explorer refresh event (no second channel)', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    });
    const { result } = renderStore();
    const listener = vi.fn();
    result.current.store.subscribe(FILE_A, listener);
    result.current.store.getSnapshot(FILE_A);

    nodeSizes[FILE_A] = 512;
    act(() => {
      window.dispatchEvent(createFileExplorerRefreshEvent(REFRESH_DETAIL));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.store.getSnapshot(FILE_A).size).toBe(512);
  });

  it('does not invalidate Explorer metadata for an omitted-only working-tree marker', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    });
    const { result } = renderStore();
    const invalidateAllSpy = vi.spyOn(result.current.store, 'invalidateAll');
    invalidateAllSpy.mockClear();
    const omittedRoot = {
      changes: [],
      filteredChangeBoundaries: ['packages/app/dist'],
      rootId: ROOT,
      rootPath: '/workspace/root',
    } as const;

    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [omittedRoot],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });

    expect(invalidateAllSpy).not.toHaveBeenCalled();
  });

  it('stops reacting to refresh events after unmount', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    });
    const { result, unmount } = renderStore();
    const listener = vi.fn();
    result.current.store.subscribe(FILE_A, listener);
    result.current.store.getSnapshot(FILE_A);
    unmount();

    nodeSizes[FILE_A] = 512;
    act(() => {
      window.dispatchEvent(createFileExplorerRefreshEvent(REFRESH_DETAIL));
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('drops a scheduled reconciliation on unmount', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result, unmount } = renderStore();
    const invalidateAllSpy = vi.spyOn(result.current.store, 'invalidateAll');
    settleReconcile();
    invalidateAllSpy.mockClear();

    state.cacheVersion = 2;
    mockContext = stubTokenCache(state);
    unmount();
    settleReconcile();

    expect(invalidateAllSpy).not.toHaveBeenCalled();
  });
});
