import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenCacheContextValue } from '../token-cache-context';
import { useBackgroundTokenIndexerIntegration } from '../use-background-token-indexer-integration';

// Mock the token cache hook so we can control readiness and capture calls.
const indexFilesMock = vi.fn();
const mockBackgroundIndexer = {
  indexFiles: indexFilesMock,
  cancelIndexing: vi.fn(),
  isIndexing: false,
  isReady: true,
  progress: null,
};

vi.mock('@brainstrike/token-cache', () => ({
  useBackgroundTokenIndexer: () => mockBackgroundIndexer,
}));

// Provide a minimal context value with the fields the integration hook reads.
const storeMock = {
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
} as unknown as TokenCacheContextValue['store'];

const tokenCacheContext: TokenCacheContextValue = {
  isReady: true,
  countingMode: 'accurate',
  getTokenCount: vi.fn(),
  getTotalTokens: vi.fn(async () => 0),
  isLoading: vi.fn(() => false),
  isAnyLoading: false,
  queueForCounting: vi.fn(),
  preloadFolder: vi.fn(),
  store: storeMock,
  clearHotCache: vi.fn(),
  invalidate: vi.fn(),
  updateHotCache: vi.fn(),
  cacheVersion: 0,
};

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
});
