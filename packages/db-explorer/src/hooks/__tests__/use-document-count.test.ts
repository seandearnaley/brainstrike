import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedChunkCountLogger, useIndexedChunkCount } from '../use-document-count';

type MockRow = { count: number };

const mockLiveQueryState = {
  rows: [] as MockRow[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
};

const usePGliteLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

describe('useIndexedChunkCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveQueryState.rows = [];
    mockLiveQueryState.error = null;
    mockLiveQueryState.refresh = vi.fn();
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
        query: expect.stringContaining('COUNT(*)'),
        params: ['collection-1'],
        enabled: true,
      })
    );
  });

  it('returns zero when live query has no rows', () => {
    mockLiveQueryState.rows = [];

    const { result } = renderHook(() => useIndexedChunkCount('collection-1'));

    expect(result.current).toBe(0);
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
});
