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
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [{ id: 1 }],
    });
  });

  it('passes extracted SQL/params and pagination options to usePGliteLiveQuery', () => {
    const query: DrizzleQueryLike = {
      toSQL: () => ({ params: [123], sql: 'SELECT * FROM files WHERE id = $1' }),
    };

    const { result } = renderHook(() =>
      useDrizzleLiveQuery<{ id: number }>(query, { enabled: true, limit: 5, offset: 10 })
    );

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      enabled: true,
      limit: 5,
      offset: 10,
      params: [123],
      query: 'SELECT * FROM files WHERE id = $1',
    });
    expect(result.current).toEqual(
      expect.objectContaining({
        error: null,
        loading: false,
        rows: [{ id: 1 }],
      })
    );
  });

  it('uses fallback query and disables execution when query is null', () => {
    renderHook(() => useDrizzleLiveQuery<{ id: number }>(null));

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      enabled: false,
      query: 'SELECT 1 WHERE false',
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
      enabled: false,
      query: 'SELECT 1 WHERE false',
    });
  });

  it('honors explicit enabled=false even when query is valid', () => {
    const query: DrizzleQueryLike = {
      toSQL: () => ({ params: [], sql: 'SELECT * FROM files' }),
    };

    renderHook(() => useDrizzleLiveQuery<{ id: number }>(query, { enabled: false }));

    expect(mocks.usePGliteLiveQuery).toHaveBeenCalledWith({
      enabled: false,
      params: [],
      query: 'SELECT * FROM files',
    });
  });
});

describe('useDrizzleLiveQueryWithRefresh', () => {
  it('exposes refreshCount and forceRefresh while preserving base result fields', () => {
    mocks.usePGliteLiveQuery.mockReturnValue({
      error: null,
      loading: true,
      refresh: vi.fn(),
      rows: [{ id: 7 }],
    });

    const query: DrizzleQueryLike = {
      toSQL: () => ({ params: [], sql: 'SELECT * FROM files' }),
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
