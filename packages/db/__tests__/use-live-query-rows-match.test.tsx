// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePGliteLiveQuery } from '../src/use-live-query.js';

// `rowsMatchQuery` tells a consumer whether the rows it holds answer the query
// it is asking now (BST-1792). The provider is mocked, as in
// `use-live-query.test.tsx`; the drain registry is null on purpose.
vi.mock('../src/use-db.js', () => ({
  useLiveQueryDrainRegistry: vi.fn(() => null),
  usePGliteDatabase: vi.fn(),
}));

import { usePGliteDatabase } from '../src/use-db.js';

describe('usePGliteLiveQuery rowsMatchQuery (BST-1792)', () => {
  const liveHandle = (rows: readonly unknown[]) => ({
    initialResults: { rows },
    refresh: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  });
  let mockQuery: ReturnType<typeof vi.fn>;
  let leaderChangeListener: (() => void) | null;

  beforeEach(() => {
    mockQuery = vi.fn();
    leaderChangeListener = null;
    (usePGliteDatabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      raw: {
        live: { incrementalQuery: mockQuery, query: mockQuery },
        onLeaderChange(listener: () => void) {
          leaderChangeListener = listener;
          return () => undefined;
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // A leader change re-subscribes the same query. It reports `loading` but keeps
  // the SAME rows array until the new subscription delivers, and those rows
  // still answer the query.
  it('holds the previous rows through a leader-change re-subscribe', async () => {
    const firstRows = [{ id: 1 }];
    let deliverSecond: (handle: ReturnType<typeof liveHandle>) => void = () => undefined;
    mockQuery.mockReturnValueOnce(liveHandle(firstRows)).mockReturnValueOnce(
      new Promise((resolve) => {
        deliverSecond = resolve;
      })
    );
    const { result } = renderHook(() => usePGliteLiveQuery({ query: 'SELECT * FROM test' }));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const settledRows = result.current.rows;
    expect(settledRows).toEqual(firstRows);
    expect(result.current.rowsMatchQuery).toBe(true);

    act(() => {
      leaderChangeListener?.();
    });
    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.rows).toBe(settledRows);
    expect(result.current.rowsMatchQuery).toBe(true);

    await act(async () => {
      deliverSecond(liveHandle([{ id: 2 }]));
    });
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.rows).toEqual([{ id: 2 }]);
    expect(result.current.rowsMatchQuery).toBe(true);
  });

  it('is false on every render after the params change, until the new query delivers', async () => {
    let deliverSecond: (handle: ReturnType<typeof liveHandle>) => void = () => undefined;
    mockQuery.mockReturnValueOnce(liveHandle([{ count: 3 }])).mockReturnValueOnce(
      new Promise((resolve) => {
        deliverSecond = resolve;
      })
    );
    const renders: Array<{ readonly cacheKey: string; readonly matches: boolean }> = [];
    const { rerender, result } = renderHook(
      ({ cacheKey }: { cacheKey: string }) => {
        const live = usePGliteLiveQuery({ cacheKey, params: [cacheKey], query: 'SELECT $1' });
        renders.push({ cacheKey, matches: live.rowsMatchQuery });
        return live;
      },
      { initialProps: { cacheKey: 'watermark-a' } }
    );
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });

    rerender({ cacheKey: 'watermark-b' });
    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
    // The rows are still watermark-a's, including on the render before the
    // effect reports `loading`.
    expect(renders.filter((render) => render.cacheKey === 'watermark-b')).not.toContainEqual({
      cacheKey: 'watermark-b',
      matches: true,
    });
    expect(result.current.rows).toEqual([{ count: 3 }]);

    await act(async () => {
      deliverSecond(liveHandle([{ count: 0 }]));
    });
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });
    expect(result.current.rows).toEqual([{ count: 0 }]);
  });

  it('is false for rows from a previous database handle', async () => {
    let deliverSecond: (handle: ReturnType<typeof liveHandle>) => void = () => undefined;
    mockQuery.mockReturnValueOnce(liveHandle([{ count: 3 }]));
    const { rerender, result } = renderHook(() => usePGliteLiveQuery({ query: 'SELECT 1' }));
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });

    const nextQuery = vi.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        deliverSecond = resolve;
      })
    );
    (usePGliteDatabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      raw: { live: { incrementalQuery: nextQuery, query: nextQuery } },
    });
    rerender();
    await vi.waitFor(() => {
      expect(nextQuery).toHaveBeenCalledTimes(1);
    });
    expect(result.current.rowsMatchQuery).toBe(false);

    await act(async () => {
      deliverSecond(liveHandle([{ count: 0 }]));
    });
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });
  });

  // Nothing observes changes while the query is disabled, so the rows it kept
  // do not answer the re-enabled query until a new subscription delivers.
  it('is false while disabled and after re-enabling, until the new subscription delivers', async () => {
    let deliverSecond: (handle: ReturnType<typeof liveHandle>) => void = () => undefined;
    mockQuery.mockReturnValueOnce(liveHandle([{ count: 3 }])).mockReturnValueOnce(
      new Promise((resolve) => {
        deliverSecond = resolve;
      })
    );
    const renders: Array<{ readonly enabled: boolean; readonly matches: boolean }> = [];
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        const live = usePGliteLiveQuery({ enabled, query: 'SELECT 1' });
        renders.push({ enabled, matches: live.rowsMatchQuery });
        return live;
      },
      { initialProps: { enabled: true } }
    );
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });

    rerender({ enabled: false });
    // Including the render before the disabling effect runs.
    expect(renders.filter((render) => !render.enabled)).not.toContainEqual({
      enabled: false,
      matches: true,
    });

    rerender({ enabled: true });
    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
    expect(result.current.rows).toEqual([{ count: 3 }]);
    expect(result.current.rowsMatchQuery).toBe(false);

    await act(async () => {
      deliverSecond(liveHandle([{ count: 4 }]));
    });
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });
  });

  it('is false after a same-query re-subscribe fails', async () => {
    mockQuery
      .mockReturnValueOnce(liveHandle([{ count: 3 }]))
      .mockRejectedValueOnce(new Error('subscribe failed'));
    const { result } = renderHook(() => usePGliteLiveQuery({ query: 'SELECT 1' }));
    await vi.waitFor(() => {
      expect(result.current.rowsMatchQuery).toBe(true);
    });

    act(() => {
      leaderChangeListener?.();
    });
    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('subscribe failed');
    });
    expect(result.current.rowsMatchQuery).toBe(false);
  });
});
