import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedChunkCountLogger, useIndexedChunkCount } from '../use-document-count';

interface MockRow {
  count: number;
}

const mockLiveQueryState = {
  rows: [] as MockRow[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
};

const useBrainstrikeLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);
const useFileChunkRepositoryMock = vi.fn();
const useOptionalPGliteDatabaseMock = vi.fn<() => unknown>(() => ({}));

const mockVectorStatusUiStore = {
  isImporting: false,
  isEmbeddingActive: false,
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
  useFileChunkRepository: () => useFileChunkRepositoryMock(),
  useOptionalPGliteDatabase: () => useOptionalPGliteDatabaseMock(),
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
    useBrainstrikeLiveQueryMock.mockReturnValue(mockLiveQueryState);
    useFileChunkRepositoryMock.mockReturnValue(null);
    useOptionalPGliteDatabaseMock.mockReturnValue({});
  });

  it('returns undefined when no active collection', () => {
    const { result } = renderHook(() => useIndexedChunkCount(null));

    expect(result.current).toBeUndefined();
    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
  });

  it('maps live query count for active collection', () => {
    mockLiveQueryState.rows = [{ count: 42 }];

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBe(42);
    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('FROM collection_indexing_stats'),
        params: ['collection-1'],
        enabled: true,
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
    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it('refreshes the active collection count when the embeddings queue drains', async () => {
    renderHook(() => useIndexedChunkCount('collection-1'));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { queue: 'embeddings', embeddingSetId: 'collection-1' },
        })
      );
      await Promise.resolve();
    });

    expect(mockLiveQueryState.refresh).toHaveBeenCalledTimes(1);
  });

  it('loads indexed chunk count from repository snapshots when PGlite live queries are unavailable', async () => {
    const getCoverageForSet = vi.fn().mockResolvedValue({
      chunksWithEmbeddingsForSet: 12,
      totalChunks: 30,
    });
    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileChunkRepositoryMock.mockReturnValue({ getCoverageForSet });

    const { result } = renderHook(() => useIndexedChunkCount('collection-turso'));

    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(getCoverageForSet).toHaveBeenCalledWith('collection-turso');
    await waitFor(() => expect(result.current).toBe(12));
  });
});
