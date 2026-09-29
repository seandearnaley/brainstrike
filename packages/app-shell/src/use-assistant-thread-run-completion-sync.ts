import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useRef } from 'react';

const logger = createLogger('AssistantThreadRunCompletionSync');

/**
 * The terminal-write signature of one resource's runs. It moves on every terminal
 * write: `terminalCount` when a run reaches `completed`, `failed` or `cancelled`,
 * `lastCompletedAt` when a resumed run reaches one again (its count is back where
 * it was). The statuses are the ones `deriveUnseenThreadIds` treats as terminal,
 * and a run start or an unrelated row update moves neither. An aggregate without
 * GROUP BY delivers exactly one row, even for a resource with no runs.
 *
 * `::int` and `::text` keep the row plain JSON on every transport (a `bigint` or a
 * `Date` may not survive the Electron bridge as the same value).
 */
export const ASSISTANT_THREAD_RUN_COMPLETIONS_SQL = `
  SELECT
    count(*) FILTER (WHERE status IN ('cancelled', 'completed', 'failed'))::int AS "terminalCount",
    max(completed_at)::text AS "lastCompletedAt"
  FROM brainstrike_assistant_thread_runs
  WHERE resource_id = $1
`;

interface UseAssistantThreadRunCompletionSyncInput {
  readonly enabled: boolean;
  readonly refreshResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  readonly repository: AssistantThreadRepository | null;
  readonly resourceId: string;
}

interface DeliveredSignature {
  readonly resourceId: string;
  readonly signature: string;
}

/**
 * Keep the loaded thread list aligned with the run rows' terminal writes
 * (BST-1844): the finished/failed badge reads `latestRun` from that list, and
 * only a list refresh updates it.
 *
 * Nothing in the renderer's own run callbacks can drive this. On desktop the host
 * owns the run and writes the terminal row AFTER the response has streamed, so a
 * refresh fired from a completion callback reads the row still `running`; on web
 * the renderer's terminal write lands after the usage tap that refreshes. The
 * title sync only masked it, because a thread's first run also writes its title.
 * PGlite's live query is the exact local mutation signal for both platforms, the
 * same precedent as `useAssistantThreadTitleSync`.
 *
 * Mounted ONCE by the thread-tab workspace, never per panel: each hook instance
 * runs its own query, and open plus retained panels would multiply it. The first
 * delivery is only recorded; a change after it refreshes the list.
 */
export function useAssistantThreadRunCompletionSync({
  enabled,
  refreshResourceThreads,
  repository,
  resourceId,
}: UseAssistantThreadRunCompletionSyncInput): void {
  const { error, loading, rows } = usePGliteLiveQuery<Record<string, unknown>>({
    cacheKey: makeLiveQueryKey('assistant-thread-run-completions', resourceId),
    clearOnDisable: true,
    enabled,
    params: [resourceId],
    query: ASSISTANT_THREAD_RUN_COMPLETIONS_SQL,
  });
  const signature = useMemo(() => JSON.stringify(rows), [rows]);
  const deliveredRef = useRef<DeliveredSignature | null>(null);

  useEffect(() => {
    if (error) {
      logger.warn('Assistant thread run completion subscription failed', { error, resourceId });
    }
  }, [error, resourceId]);

  useEffect(() => {
    // `rows` is empty until the subscription delivers (the render right after the
    // query is enabled still holds the cleared rows), and a delivered aggregate
    // never is, so an empty result is "nothing delivered yet", not a baseline.
    if (!(enabled && repository) || loading || error || rows.length === 0) {
      return;
    }
    const previous = deliveredRef.current;
    deliveredRef.current = { resourceId, signature };
    if (!previous || previous.resourceId !== resourceId || previous.signature === signature) {
      return;
    }
    refreshResourceThreads(repository, resourceId).catch((refreshError: unknown) => {
      logger.warn('Failed to refresh assistant threads after a run completed', {
        error: refreshError,
        resourceId,
      });
    });
  }, [enabled, error, loading, refreshResourceThreads, repository, resourceId, rows, signature]);
}
