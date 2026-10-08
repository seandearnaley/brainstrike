import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { useAssistantThreadHostRuns } from './assistant-thread-host-context';
import { useWebStartupReap } from './web-startup-reap';

const ACTIVE_ASSISTANT_THREAD_IDS_SQL = `
  SELECT thread_id AS "threadId"
  FROM brainstrike_assistant_thread_runs
  WHERE resource_id = $1
    AND status = 'running'
  GROUP BY thread_id
  ORDER BY thread_id ASC
`;

const EMPTY_ACTIVE_THREAD_IDS: ReadonlySet<string> = new Set<string>();

interface ActiveAssistantThreadIdRow {
  readonly threadId: unknown;
}

export interface ActiveAssistantThreadIdsState {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly threadIds: ReadonlySet<string>;
}

function projectActiveThreadIds(rows: readonly ActiveAssistantThreadIdRow[]): {
  readonly error: Error | null;
  readonly threadIds: ReadonlySet<string>;
} {
  const threadIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.threadId !== 'string' || !row.threadId.trim()) {
      return {
        error: new Error('Active assistant thread query returned an invalid thread id.'),
        threadIds: new Set(),
      };
    }
    threadIds.add(row.threadId);
  }
  return { error: null, threadIds };
}

/**
 * One durable, resource-scoped activity projection for the whole Threads panel.
 *
 * Run creation and every terminal lifecycle path already write the shared
 * PGlite `thread_runs` table. Subscribing to that table keeps concurrent,
 * background, reattached, deleted, and startup-reaped runs on the same source
 * of truth without per-row subscriptions, timers, or a parallel activity store.
 */
export function useActiveAssistantThreadIds({
  database,
  resourceId,
  schemaReady,
}: {
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly schemaReady: boolean;
}): ActiveAssistantThreadIdsState {
  const canReadRuns = database !== null && schemaReady;
  const desktopOwnsRunLifecycle = hasDurableAssistantUsageCapability();
  const webStartupReap = useWebStartupReap(database, canReadRuns && !desktopOwnsRunLifecycle);
  const startupReady = desktopOwnsRunLifecycle || webStartupReap.status === 'ready';
  const liveQuery = usePGliteLiveQuery<ActiveAssistantThreadIdRow>({
    cacheKey: makeLiveQueryKey('active-assistant-thread-ids', resourceId),
    clearOnDisable: true,
    enabled: canReadRuns && startupReady,
    params: [resourceId],
    query: ACTIVE_ASSISTANT_THREAD_IDS_SQL,
  });
  const projection = useMemo(() => projectActiveThreadIds(liveQuery.rows), [liveQuery.rows]);
  const startupError = webStartupReap.status === 'error' ? webStartupReap.error : null;
  const error = startupError ?? liveQuery.error ?? projection.error;
  // Agent-host threads have no run rows: their committed log is the source.
  const hostRuns = useAssistantThreadHostRuns();
  const threadIds = useMemo(() => {
    const historyIds = error ? EMPTY_ACTIVE_THREAD_IDS : projection.threadIds;
    const hostIds = [...hostRuns].flatMap(([threadId, run]) =>
      run.status === 'running' ? [threadId] : []
    );
    return hostIds.length === 0 ? historyIds : new Set([...historyIds, ...hostIds]);
  }, [error, hostRuns, projection.threadIds]);

  return {
    error,
    loading: liveQuery.loading || (!desktopOwnsRunLifecycle && webStartupReap.status === 'pending'),
    threadIds,
  };
}
