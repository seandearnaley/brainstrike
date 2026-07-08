import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedChunkCountLogger, useIndexedChunkCount } from '../use-document-count';

interface MockRow {
  count: number;
}

const mockLiveQueryState = {
  error: null as Error | null,
  loading: false,
  refresh: vi.fn(),
  rows: [] as MockRow[],
};

const usePGliteLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);

const mockVectorStatusUiStore = {
  isEmbeddingActive: false,
  isImporting: false,
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: vi.fn((selector: (state: typeof mockVectorStatusUiStore) => unknown) =>
    selector(mockVectorStatusUiStore)
  ),
}));

describe('useIndexedChunkCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveQueryState.rows = [];
    mockLiveQueryState.error = null;
    mockLiveQueryState.refresh = vi.fn();
    mockVectorStatusUiStore.isImporting = false;
    mockVectorStatusUiStore.isEmbeddingActive = false;
    usePGliteLiveQueryMock.mockReturnValue(mockLiveQueryState);
  });

  it('returns undefined when no active collection', () => {
    const { result } = renderHook(() => useIndexedChunkCount(null));

    expect(result.current).toBeUndefined();
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('maps live query count for active collection', () => {
    mockLiveQueryState.rows = [{ count: 42 }];

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBe(42);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        params: ['collection-1'],
        query: expect.stringContaining('FROM collection_indexing_stats'),
      })
    );
  });

  it('returns undefined when stats are not available yet', () => {
    mockLiveQueryState.rows = [];

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBeUndefined();
  });

  it('returns undefined when live query errors', () => {
    const testError = new Error('live query failed');
    mockLiveQueryState.error = testError;

    const loggerErrorSpy = vi.spyOn(indexedChunkCountLogger, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBeUndefined();
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to fetch indexed chunk count',
      expect.objectContaining({ error: testError })
    );

    loggerErrorSpy.mockRestore();
  });

  it('recomputes when rows change', () => {
    const { result, rerender } = renderHook(({ id }) => useIndexedChunkCount(id), {
      initialProps: { id: 'collection-1' as string | null },
    });

    mockLiveQueryState.rows = [{ count: 10 }];
    rerender({ id: 'collection-1' });
    expect(result.current).toBe(10);

    mockLiveQueryState.rows = [{ count: 20 }];
    rerender({ id: 'collection-1' });
    expect(result.current).toBe(20);
  });

  it('retains last count when collection becomes null', () => {
    mockLiveQueryState.rows = [{ count: 5 }];

    const { result, rerender } = renderHook(({ id }) => useIndexedChunkCount(id), {
      initialProps: { id: 'collection-1' as string | null },
    });

    expect(result.current).toBe(5);

    rerender({ id: null });
    expect(result.current).toBe(5);
  });

  it('keeps the active collection count live while embedding is active', async () => {
    mockVectorStatusUiStore.isEmbeddingActive = true;
    mockLiveQueryState.rows = [{ count: 7 }];

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBe(7);
    expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('refreshes the active collection count when the embeddings queue drains', async () => {
    renderHook(() => useIndexedChunkCount('collection-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'collection-1', queue: 'embeddings' },
        })
      );
      await Promise.resolve();
    });

    expect(mockLiveQueryState.refresh).toHaveBeenCalledTimes(1);
  });
});
