import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock, usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...args: unknown[]) => args.join(':'),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

import {
  resetDiagnosticsSeenStore,
  useDiagnosticsSeenStore,
} from '../diagnostics/diagnostics-seen-store';
import { useUnseenDiagnosticsCount } from '../diagnostics/use-unseen-diagnostics-count';

interface LiveQueryArgs {
  readonly cacheKey?: string;
  readonly enabled?: boolean;
  readonly params?: readonly unknown[];
  readonly query?: string;
}

function lastLiveQueryArgs(): LiveQueryArgs {
  return usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as LiveQueryArgs;
}

beforeEach(() => {
  usePGliteDatabaseMock.mockReset();
  usePGliteLiveQueryMock.mockReset();
  usePGliteDatabaseMock.mockReturnValue({});
  usePGliteLiveQueryMock.mockReturnValue({
    error: null,
    loading: false,
    refresh: vi.fn(),
    rows: [{ count: 0 }],
  });
  resetDiagnosticsSeenStore();
});

describe('useUnseenDiagnosticsCount', () => {
  it('binds the watermark as an ISO string and counts rows strictly newer than it', () => {
    const watermarkMs = Date.parse('2026-07-24T12:00:00.000Z');
    useDiagnosticsSeenStore.setState({ lastSeenAtMs: watermarkMs });

    renderHook(() => useUnseenDiagnosticsCount());

    const args = lastLiveQueryArgs();
    expect(args.params).toEqual(['2026-07-24T12:00:00.000Z']);
    expect(args.query).toContain('occurred_at > $1');
    expect(args.query).toContain('COUNT(*)');
  });

  // The table's CHECK constraint already restricts severity to warn/error/
  // fatal, so a severity predicate here would be redundant AND would diverge
  // silently if that constraint ever changes. Pinned so nobody adds one
  // "for clarity".
  it('carries no severity predicate', () => {
    renderHook(() => useUnseenDiagnosticsCount());

    expect(lastLiveQueryArgs().query).not.toContain('severity');
  });

  // `usePGliteLiveQuery` uses `cacheKey` as the SOLE re-subscription dep when
  // one is supplied, skipping deep param comparison. So every bound param
  // must appear in the key. Dropping the watermark from the key would leave
  // the key constant across `markAllSeen`, the live query would never
  // re-subscribe, and clicking the chip would open settings while the count
  // never cleared -- a user-visible bug this assertion is here to catch.
  it('includes every bound param in the cacheKey so markAllSeen re-subscribes', () => {
    useDiagnosticsSeenStore.setState({ lastSeenAtMs: Date.parse('2026-07-24T12:00:00.000Z') });

    const { rerender } = renderHook(() => useUnseenDiagnosticsCount());
    const firstKey = lastLiveQueryArgs().cacheKey;
    expect(firstKey).toContain('2026-07-24T12:00:00.000Z');

    act(() => {
      useDiagnosticsSeenStore.getState().markAllSeen(Date.parse('2026-07-24T13:00:00.000Z'));
    });
    rerender();

    const secondKey = lastLiveQueryArgs().cacheKey;
    expect(secondKey).toContain('2026-07-24T13:00:00.000Z');
    expect(secondKey).not.toBe(firstKey);
  });

  it('keeps params referentially stable while the watermark is unchanged', () => {
    const { rerender } = renderHook(() => useUnseenDiagnosticsCount());
    const firstParams = lastLiveQueryArgs().params;

    rerender();

    expect(lastLiveQueryArgs().params).toBe(firstParams);
  });

  it('disables the query until a database handle exists', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    renderHook(() => useUnseenDiagnosticsCount());

    expect(lastLiveQueryArgs().enabled).toBe(false);
  });

  it('coerces a string COUNT to a number and reports a query error verbatim', () => {
    const error = new Error('live query subscribe failed');
    usePGliteLiveQueryMock.mockReturnValue({
      error,
      loading: false,
      refresh: vi.fn(),
      rows: [{ count: '7' }],
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current.count).toBe(7);
    expect(result.current.error).toBe(error);
  });

  it('reports 0 when the query returns no rows yet', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: true,
      refresh: vi.fn(),
      rows: [],
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current.count).toBe(0);
    expect(result.current.error).toBeNull();
  });
});
