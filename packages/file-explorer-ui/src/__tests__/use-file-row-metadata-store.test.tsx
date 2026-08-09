import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const FILE_A = encodeFileSelection(ROOT, 'src/a.ts');

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

describe('useFileRowMetadataStore', () => {
  let nodeSizes: Record<string, number>;
  let subtrees: Record<string, FileRowDirectorySubtree>;

  beforeEach(() => {
    mockContext = null;
    nodeSizes = {};
    subtrees = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderStore = () =>
    renderHook(() =>
      useFileRowMetadataStore({
        getDirectorySubtree: (compositeKey) => subtrees[compositeKey] ?? null,
        getNodeSize: (compositeKey) => nodeSizes[compositeKey],
      })
    );

  it('reports pending tokens when no token cache is mounted', () => {
    const { result } = renderStore();
    expect(result.current.getSnapshot(FILE_A).tokens).toBe('pending');
  });

  it('reports pending tokens while the token cache is not operational', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: false,
      sizes: {},
      tokens: { [FILE_A]: 40 },
    });
    const { result } = renderStore();
    expect(result.current.getSnapshot(FILE_A).tokens).toBe('pending');
  });

  it('reads counted tokens from the operational token cache', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: { [FILE_A]: 40 },
    });
    const { result } = renderStore();
    expect(result.current.getSnapshot(FILE_A).tokens).toBe(40);
  });

  it('prefers the tree node size and falls back to the token cache size', () => {
    mockContext = stubTokenCache({
      cacheVersion: 1,
      isOperational: true,
      sizes: { [FILE_A]: 64 },
      tokens: {},
    });
    const { result } = renderStore();
    expect(result.current.getSnapshot(FILE_A).size).toBe(64);

    nodeSizes[FILE_A] = 128;
    // A source change alone must not move the snapshot; only an invalidation does.
    expect(result.current.getSnapshot(FILE_A).size).toBe(64);
  });

  it('keeps one store instance across re-renders', () => {
    const { result, rerender } = renderStore();
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('invalidates subscribed keys when the token cache version bumps', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const listener = vi.fn();
    result.current.subscribe(FILE_A, listener);
    expect(result.current.getSnapshot(FILE_A).tokens).toBe('pending');

    state.tokens[FILE_A] = 12;
    state.cacheVersion = 2;
    mockContext = stubTokenCache(state);
    act(() => {
      rerender();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.getSnapshot(FILE_A).tokens).toBe(12);
  });

  it('invalidates when the token cache becomes operational at an unchanged version', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: false,
      sizes: {},
      tokens: { [FILE_A]: 9 },
    };
    mockContext = stubTokenCache(state);
    const { result, rerender } = renderStore();
    const listener = vi.fn();
    result.current.subscribe(FILE_A, listener);
    expect(result.current.getSnapshot(FILE_A).tokens).toBe('pending');

    state.isOperational = true;
    mockContext = stubTokenCache(state);
    act(() => {
      rerender();
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.getSnapshot(FILE_A).tokens).toBe(9);
  });

  it('invalidates on the shared file-explorer refresh event (no second channel)', () => {
    const state: StubCacheState = {
      cacheVersion: 1,
      isOperational: true,
      sizes: {},
      tokens: {},
    };
    mockContext = stubTokenCache(state);
    const { result } = renderStore();
    const listener = vi.fn();
    result.current.subscribe(FILE_A, listener);
    result.current.getSnapshot(FILE_A);

    nodeSizes[FILE_A] = 512;
    act(() => {
      window.dispatchEvent(createFileExplorerRefreshEvent(REFRESH_DETAIL));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.getSnapshot(FILE_A).size).toBe(512);
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
    result.current.subscribe(FILE_A, listener);
    result.current.getSnapshot(FILE_A);
    unmount();

    nodeSizes[FILE_A] = 512;
    act(() => {
      window.dispatchEvent(createFileExplorerRefreshEvent(REFRESH_DETAIL));
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
