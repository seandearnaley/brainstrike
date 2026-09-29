import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { makeLiveQueryKey, usePGliteDatabase, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useAppReloadState } from '@brainstrike/ui';
import { useMemo } from 'react';
import { useWebStartupReap } from '../web-startup-reap';

/**
 * EVERY resource, unlike the Threads panel's projection: a reload stops each
 * in-flight run in this page, whichever resource owns it. An aggregate always
 * returns exactly one row, so an empty result can only mean "not delivered yet".
 */
const RUNNING_ASSISTANT_RUN_COUNT_SQL = `
  SELECT COUNT(*)::int AS "runningCount"
  FROM brainstrike_assistant_thread_runs
  WHERE status = 'running'
`;

export type RunningAssistantRunsState =
  | { readonly status: 'loading' }
  | { readonly error: Error; readonly status: 'error' }
  | { readonly runningCount: number; readonly status: 'ready' };

const LOADING: RunningAssistantRunsState = { status: 'loading' };

interface RunningAssistantRunCountRow {
  readonly runningCount: unknown;
}

function projectRunCount(row: RunningAssistantRunCountRow | undefined): RunningAssistantRunsState {
  const count = row?.runningCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    return {
      error: new Error('Running assistant run query returned an invalid count.'),
      status: 'error',
    };
  }
  return { runningCount: count, status: 'ready' };
}

/**
 * How many assistant runs are still in flight in this page, for the web reload
 * gate. Only `ready` may be read as a count: a database that is not open, a
 * startup reap that has not finished (rows a dead tab left `running` are still
 * there) and a live query that has not delivered are all UNKNOWN, never zero.
 *
 * It observes nothing until BOTH hold, and is `loading` (fails closed) until then:
 * - A reload is required. Every `requestAppReload` caller is failed-chunk UI, which
 *   appears only after the chunk-load listener marked a reload required, so a
 *   session that never fails a chunk pays for no reap subscription and no live query.
 * - The thread store has loaded the workspace resource: the same readiness gate as
 *   `useActiveAssistantThreadIds`. The startup reap is shared per database and never
 *   retries, so starting it before that gate could poison both readers for the
 *   session on an early failure.
 */
export function useRunningAssistantRuns(): RunningAssistantRunsState {
  const database = usePGliteDatabase();
  const { required } = useAppReloadState();
  // Same test as the Threads panel's `schemaReady`, selected as a boolean so other
  // thread-list changes do not re-render the gate.
  const threadsLoaded = useAssistantThreadStore((state) =>
    Object.hasOwn(state.threadsByResourceId, WORKSPACE_MEMORY_RESOURCE_ID)
  );
  const observing = required && database !== null && threadsLoaded;
  const reap = useWebStartupReap(database, observing);
  const liveQuery = usePGliteLiveQuery<RunningAssistantRunCountRow>({
    cacheKey: makeLiveQueryKey('running-assistant-run-count'),
    clearOnDisable: true,
    enabled: observing && reap.status === 'ready',
    query: RUNNING_ASSISTANT_RUN_COUNT_SQL,
  });
  const { error, loading, rows } = liveQuery;

  return useMemo((): RunningAssistantRunsState => {
    if (!observing) {
      return LOADING;
    }
    if (reap.status === 'error' && reap.error) {
      return { error: reap.error, status: 'error' };
    }
    if (reap.status !== 'ready') {
      return LOADING;
    }
    if (error) {
      return { error, status: 'error' };
    }
    if (loading || rows.length === 0) {
      return LOADING;
    }
    return projectRunCount(rows[0]);
  }, [error, loading, observing, reap.error, reap.status, rows]);
}
