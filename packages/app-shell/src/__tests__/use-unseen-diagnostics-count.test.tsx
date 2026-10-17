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
vi.mock('@brainstrike/db/react', () => ({
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
    rows: [{ errorCount: 0, warningCount: 0 }],
    rowsMatchQuery: true,
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

  // The table's CHECK constraint defines the complete warn+ set. The query
  // partitions that set only for honest UI labels: fatal shares the error
  // bucket, while warn remains visibly distinct.
  it('partitions warnings from errors without excluding fatal rows', () => {
    renderHook(() => useUnseenDiagnosticsCount());

    const query = lastLiveQueryArgs().query;
    expect(query).toContain("severity IN ('error', 'fatal')");
    expect(query).toContain("severity = 'warn'");
    expect(query).toContain('AS "errorCount"');
    expect(query).toContain('AS "warningCount"');
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

    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
      rowsMatchQuery: false,
    });
    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(lastLiveQueryArgs().enabled).toBe(false);
    expect(result.current).toEqual({ error: null, errorCount: 0, warningCount: 0 });
  });

  it('coerces both string counts to numbers and reports a query error verbatim', () => {
    const error = new Error('live query subscribe failed');
    usePGliteLiveQueryMock.mockReturnValue({
      error,
      loading: false,
      refresh: vi.fn(),
      rows: [{ errorCount: '7', warningCount: '3' }],
      rowsMatchQuery: true,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current.errorCount).toBe(7);
    expect(result.current.warningCount).toBe(3);
    expect(result.current.error).toBe(error);
  });

  it('reports 0 when the query returns no rows yet', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: true,
      refresh: vi.fn(),
      rows: [],
      rowsMatchQuery: false,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current.errorCount).toBe(0);
    expect(result.current.warningCount).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('keeps the enabled transition render quiet before the aggregate row arrives', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
      rowsMatchQuery: false,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current).toEqual({ error: null, errorCount: 0, warningCount: 0 });
  });

  it.each([
    ['null', null],
    ['blank string', ''],
    ['space-padded decimal string', ' 7 '],
    ['control-whitespace-padded decimal string', '\t7\n'],
    ['boolean true', true],
    ['boolean false', false],
    ['empty array', []],
    ['array of one number', [2]],
    ['plain object', {}],
  ])('fails loud when an aggregate count is %s', (_label, invalidCount) => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [{ errorCount: invalidCount, warningCount: '2' }],
      rowsMatchQuery: true,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current).toMatchObject({ errorCount: 0, warningCount: 0 });
    expect(result.current.error).toEqual(
      new Error('Unseen diagnostics query returned invalid aggregate counts')
    );
  });

  it('surfaces malformed aggregates as unavailable instead of returning NaN counts', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [{ errorCount: 'not-a-number', warningCount: '2' }],
      rowsMatchQuery: true,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current.errorCount).toBe(0);
    expect(result.current.warningCount).toBe(0);
    expect(result.current.error).toEqual(
      new Error('Unseen diagnostics query returned invalid aggregate counts')
    );
  });
});

// BST-1792: the count gates on `rowsMatchQuery`, not `loading`. A re-subscribe
// of the same query (a PGlite leader change, say) reports `loading` while its
// rows still answer the watermark, and reading "not yet known" as zero hides
// the chip. Rows from an earlier watermark do not answer it.
describe('useUnseenDiagnosticsCount across a live-query re-subscribe', () => {
  function liveQueryReturns(
    rows: readonly unknown[],
    state: { readonly loading: boolean; readonly rowsMatchQuery: boolean }
  ): void {
    usePGliteLiveQueryMock.mockReturnValue({ error: null, refresh: vi.fn(), rows, ...state });
  }

  it('keeps the counts while the same query re-subscribes', () => {
    const settled = [{ errorCount: 3, warningCount: 2 }];
    liveQueryReturns(settled, { loading: false, rowsMatchQuery: true });
    const { rerender, result } = renderHook(() => useUnseenDiagnosticsCount());
    expect(result.current).toEqual({ error: null, errorCount: 3, warningCount: 2 });

    liveQueryReturns(settled, { loading: true, rowsMatchQuery: true });
    rerender();

    expect(result.current).toEqual({ error: null, errorCount: 3, warningCount: 2 });
  });

  it('reads rows counted under an earlier watermark as not yet known', () => {
    // The render after `markAllSeen`: the old rows are still there, and the
    // live query has not reported `loading` yet.
    liveQueryReturns([{ errorCount: 3, warningCount: 2 }], {
      loading: false,
      rowsMatchQuery: false,
    });

    const { result } = renderHook(() => useUnseenDiagnosticsCount());

    expect(result.current).toEqual({ error: null, errorCount: 0, warningCount: 0 });
  });
});
