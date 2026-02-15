import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DrizzleQueryLike,
  useDrizzleLiveQuery,
  useDrizzleLiveQueryWithRefresh,
} from '../src/use-drizzle-live-query.js';

const mocks = vi.hoisted(() => ({
  usePGliteLiveQuery: vi.fn(),
}));

vi.mock('../src/use-live-query.js', () => ({
  usePGliteLiveQuery: mocks.usePGliteLiveQuery,
}));

describe('useDrizzleLiveQuery', () => {
  beforeEach(() => {
    mocks.usePGliteLiveQuery.mockReset();
    mocks.usePGliteLiveQuery.mockReturnValue({
      rows: [{ id: 1 }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it('passes extracted SQL/params and pagination options to usePGliteLiveQuery', () => {
    const query: DrizzleQueryLike = {
      toSQL: () => ({ sql: 'SELECT * FROM files WHERE id = $1', params: [123] }),
    };

    const { result } = renderHook(() =>
      useDrizzleLiveQuery<{ id: number }>(query, { enabled: true, offset: 10, limit: 5 })
    );

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      query: 'SELECT * FROM files WHERE id = $1',
      params: [123],
      enabled: true,
      offset: 10,
      limit: 5,
    });
    expect(result.current).toEqual(
      expect.objectContaining({
        rows: [{ id: 1 }],
        loading: false,
        error: null,
      })
    );
  });

  it('uses fallback query and disables execution when query is null', () => {
    renderHook(() => useDrizzleLiveQuery<{ id: number }>(null));

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      query: 'SELECT 1 WHERE false',
      enabled: false,
    });
  });

  it('uses fallback query and disables execution when toSQL throws', () => {
    const badQuery: DrizzleQueryLike = {
      toSQL: () => {
        throw new Error('invalid query');
      },
    };

    renderHook(() => useDrizzleLiveQuery<{ id: number }>(badQuery));

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      query: 'SELECT 1 WHERE false',
      enabled: false,
    });
  });

  it('honors explicit enabled=false even when query is valid', () => {
    const query: DrizzleQueryLike = {
      toSQL: () => ({ sql: 'SELECT * FROM files', params: [] }),
    };

    renderHook(() => useDrizzleLiveQuery<{ id: number }>(query, { enabled: false }));

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      query: 'SELECT * FROM files',
      params: [],
      enabled: false,
    });
  });
});

describe('useDrizzleLiveQueryWithRefresh', () => {
  it('exposes refreshCount and forceRefresh while preserving base result fields', () => {
    mocks.usePGliteLiveQuery.mockReturnValue({
      rows: [{ id: 7 }],
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    const query: DrizzleQueryLike = {
      toSQL: () => ({ sql: 'SELECT * FROM files', params: [] }),
    };

    const { result } = renderHook(() => useDrizzleLiveQueryWithRefresh<{ id: number }>(query));

    expect(result.current.rows).toEqual([{ id: 7 }]);
    expect(result.current.loading).toBe(true);
    expect(result.current.refreshCount).toBe(0);

    act(() => {
      result.current.forceRefresh();
      result.current.forceRefresh();
    });

    expect(result.current.refreshCount).toBe(2);
  });
});
