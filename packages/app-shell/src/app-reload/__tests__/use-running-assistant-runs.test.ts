import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reapMock, usePGliteDatabaseMock, usePGliteLiveQueryMock } = vi.hoisted(() => ({
  reapMock: vi.fn(),
  usePGliteDatabaseMock: vi.fn(),
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/assistant-data/assistant-thread-run-reaper', () => ({
  reapOrphanedAssistantThreadRuns: reapMock,
}));
vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

import { useRunningAssistantRuns } from '../use-running-assistant-runs';

interface LiveQueryArgs {
  readonly enabled?: boolean;
  readonly params?: readonly unknown[];
  readonly query?: string;
}

interface LiveQueryResult {
  error: Error | null;
  loading: boolean;
  rows: unknown[];
}

const settledRows = (runningCount: unknown) => [{ runningCount }];
let liveQuery: LiveQueryResult;
let database: DbHandle;

function lastLiveQueryArgs(): LiveQueryArgs {
  return usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as LiveQueryArgs;
}

/** The handle is the reap store's WeakMap key, so each test needs its own. */
function freshDatabase(): DbHandle {
  return {} as unknown as DbHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
  database = freshDatabase();
  liveQuery = { error: null, loading: false, rows: settledRows(0) };
  usePGliteDatabaseMock.mockImplementation(() => database);
  usePGliteLiveQueryMock.mockImplementation(() => ({
    ...liveQuery,
    refresh: vi.fn(),
  }));
  reapMock.mockResolvedValue({ reaped: [] });
});

describe('useRunningAssistantRuns', () => {
  it('is loading, never zero, while the database is not ready', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useRunningAssistantRuns());

    expect(result.current).toEqual({ status: 'loading' });
    expect(reapMock).not.toHaveBeenCalled();
    expect(lastLiveQueryArgs().enabled).toBe(false);
  });

  it('is loading, never zero, until the startup reap has finished', async () => {
    let finishReap: (value: { reaped: [] }) => void = () => undefined;
    reapMock.mockReturnValue(
      new Promise((resolve) => {
        finishReap = resolve;
      })
    );

    const { result } = renderHook(() => useRunningAssistantRuns());

    // The live query would report 0 rows here; a dead tab's runs are still `running`.
    expect(result.current).toEqual({ status: 'loading' });
    expect(lastLiveQueryArgs().enabled).toBe(false);

    await act(async () => {
      finishReap({ reaped: [] });
    });

    expect(result.current).toEqual({ runningCount: 0, status: 'ready' });
    expect(lastLiveQueryArgs().enabled).toBe(true);
  });

  it('reaps the orphaned rows of the database it reads, against the renderer boot time', async () => {
    renderHook(() => useRunningAssistantRuns());

    await waitFor(() => expect(reapMock).toHaveBeenCalledTimes(1));
    const [reapedDatabase, bootedAt] = reapMock.mock.calls[0] as [DbHandle, Date];
    expect(reapedDatabase).toBe(database);
    expect(bootedAt).toEqual(new Date(performance.timeOrigin));
  });

  it('surfaces a failed startup reap as an error, never as zero', async () => {
    const failure = new Error('reap exploded');
    reapMock.mockRejectedValue(failure);

    const { result } = renderHook(() => useRunningAssistantRuns());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toEqual({ error: failure, status: 'error' });
    expect(lastLiveQueryArgs().enabled).toBe(false);
  });

  it('is loading while the live query has not delivered', async () => {
    liveQuery = { error: null, loading: true, rows: [] };

    const { result } = renderHook(() => useRunningAssistantRuns());
    await waitFor(() => expect(lastLiveQueryArgs().enabled).toBe(true));

    expect(result.current).toEqual({ status: 'loading' });
  });

  it('is loading, not zero, when the live query is enabled but its stale first render has no rows', async () => {
    // usePGliteLiveQuery reports loading:false with rows:[] for one render after
    // it is enabled, before its effect flips loading. An aggregate always
    // returns one row, so an empty array can only mean "nothing delivered yet".
    liveQuery = { error: null, loading: false, rows: [] };

    const { result } = renderHook(() => useRunningAssistantRuns());
    await waitFor(() => expect(lastLiveQueryArgs().enabled).toBe(true));

    expect(result.current).toEqual({ status: 'loading' });
  });

  it.each([0, 1, 4])('reports %i running runs once everything has settled', async (count) => {
    liveQuery = { error: null, loading: false, rows: settledRows(count) };

    const { result } = renderHook(() => useRunningAssistantRuns());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ runningCount: count, status: 'ready' });
  });

  it('surfaces a live query failure as an error', async () => {
    const failure = new Error('relation does not exist');
    liveQuery = { error: failure, loading: false, rows: [] };

    const { result } = renderHook(() => useRunningAssistantRuns());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toEqual({ error: failure, status: 'error' });
  });

  it.each([
    ['a string', '3'],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['null', null],
    ['NaN', Number.NaN],
  ])('rejects a malformed count (%s) as an error', async (_label, value) => {
    liveQuery = { error: null, loading: false, rows: settledRows(value) };

    const { result } = renderHook(() => useRunningAssistantRuns());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toEqual({ error: expect.any(Error), status: 'error' });
  });

  it('counts running runs across every resource, not one', async () => {
    renderHook(() => useRunningAssistantRuns());
    await waitFor(() => expect(lastLiveQueryArgs().enabled).toBe(true));

    const { params, query } = lastLiveQueryArgs();
    expect(query).toMatch(/status\s*=\s*'running'/u);
    expect(query).not.toMatch(/resource_id/u);
    expect(params).toBeUndefined();
  });

  it('keeps its result identity while nothing changes', async () => {
    const { rerender, result } = renderHook(() => useRunningAssistantRuns());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const settled = result.current;

    rerender();

    expect(result.current).toBe(settled);
  });
});
