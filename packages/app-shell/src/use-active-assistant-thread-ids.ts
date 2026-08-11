import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';

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
  enabled,
  resourceId,
}: {
  readonly enabled: boolean;
  readonly resourceId: string;
}): ActiveAssistantThreadIdsState {
  const liveQuery = usePGliteLiveQuery<ActiveAssistantThreadIdRow>({
    cacheKey: makeLiveQueryKey('active-assistant-thread-ids', resourceId),
    clearOnDisable: true,
    enabled,
    params: [resourceId],
    query: ACTIVE_ASSISTANT_THREAD_IDS_SQL,
  });
  const projection = useMemo(() => projectActiveThreadIds(liveQuery.rows), [liveQuery.rows]);
  const error = liveQuery.error ?? projection.error;

  return {
    error,
    loading: liveQuery.loading,
    threadIds: error ? EMPTY_ACTIVE_THREAD_IDS : projection.threadIds,
  };
}
