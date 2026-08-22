/**
 * The Threads panel's "needs you" projection (BST-1404): threads parked on a
 * tool-approval pause the user has not answered.
 *
 * ONE resource-scoped PGlite live query over `brainstrike_assistant_run_events`,
 * the same discipline as `use-active-assistant-thread-ids.ts` (BST-1244): no
 * second activity store, no polling, no per-row subscription. The durable
 * `tool.approval.requested` row exists precisely so this list-wide question can
 * be answered in SQL — rediscovering pauses from the Mastra suspended-workflow
 * snapshot is a per-thread round trip and cannot be run for a whole list.
 *
 * RESOLUTION IS RUN-AGNOSTIC. A pause is answered by a SEPARATE resume leg that
 * mints its OWN runId and its own `thread_runs` row, so the event that answers
 * a pause carries a different `run_id` than the pause. It is paired on
 * `metadata->>'toolCallId'`, which is globally unique per tool call and is the
 * durable identity of the thing being answered. `sequence` is per-run and
 * therefore meaningless across the two legs; no ordering guard is needed
 * because no outcome for a call can precede the pause that gated that call.
 *
 * IT DELIBERATELY DOES NOT READ `thread_runs.status`. A leg that pauses for
 * approval finishes with `finishReason: 'tool-calls'`, which every terminal
 * writer records as `status = 'completed'` — so `status = 'running'` would make
 * this projection permanently EMPTY, while the user's obligation and the
 * suspended Mastra snapshot both outlive that row. For the same reason no
 * startup run-reap gating is needed here (unlike the active-run projection):
 * the reap only corrects stale `running` rows, and this query reads none.
 */
import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';

/**
 * `tool.started` IS a resolution here, unlike in the run-timeline derivation
 * (`assistant-run-event-derivation.ts`), and the difference is deliberate: the
 * timeline asks "has this pause row reached a terminal state" — where a
 * still-executing tool is not one — while this panel asks "does the user still
 * have to answer", and a tool that has STARTED was already approved.
 *
 * Exported for the real-PGlite lane
 * (`__tests__/use-threads-awaiting-approval.integration.test.ts`), which proves
 * this SELECT's OUTCOME against seeded rows. Substring assertions over the
 * query text cannot: the very error this query was corrected FOR (a
 * `thread_runs.status = 'running'` join that makes the projection permanently
 * empty) reads as a perfectly well-formed string.
 */
export const THREADS_AWAITING_APPROVAL_SQL = `
  SELECT DISTINCT requested.thread_id AS "threadId"
  FROM brainstrike_assistant_run_events requested
  WHERE requested.resource_id = $1
    AND requested.kind = 'tool.approval.requested'
    AND requested.metadata->>'toolCallId' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM brainstrike_assistant_run_events answer
      WHERE answer.resource_id = requested.resource_id
        AND answer.thread_id = requested.thread_id
        AND answer.metadata->>'toolCallId' = requested.metadata->>'toolCallId'
        AND answer.kind IN (
          'tool.started',
          'tool.completed',
          'tool.failed',
          'tool.resume.unsupported'
        )
    )
  ORDER BY "threadId" ASC
`;

const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set<string>();

interface AwaitingApprovalRow {
  readonly threadId: unknown;
}

export interface ThreadsAwaitingApprovalState {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly threadIds: ReadonlySet<string>;
}

function projectAwaitingApprovalThreadIds(rows: readonly AwaitingApprovalRow[]): {
  readonly error: Error | null;
  readonly threadIds: ReadonlySet<string>;
} {
  const threadIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.threadId !== 'string' || !row.threadId.trim()) {
      // The whole projection fails: silently dropping the row would present a
      // partial "needs you" column as a complete one.
      return {
        error: new Error('Awaiting-approval thread query returned an invalid thread id.'),
        threadIds: new Set(),
      };
    }
    threadIds.add(row.threadId);
  }
  return { error: null, threadIds };
}

export function useThreadsAwaitingApproval({
  database,
  resourceId,
  schemaReady,
}: {
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly schemaReady: boolean;
}): ThreadsAwaitingApprovalState {
  // `brainstrike_assistant_run_events` is renderer-lazy: querying it before
  // schema bootstrap is a missing-relation error, not an empty result.
  const canReadRunEvents = database !== null && schemaReady;
  const liveQuery = usePGliteLiveQuery<AwaitingApprovalRow>({
    cacheKey: makeLiveQueryKey('threads-awaiting-approval', resourceId),
    clearOnDisable: true,
    enabled: canReadRunEvents,
    params: [resourceId],
    query: THREADS_AWAITING_APPROVAL_SQL,
  });
  const projection = useMemo(
    () => projectAwaitingApprovalThreadIds(liveQuery.rows),
    [liveQuery.rows]
  );
  const error = liveQuery.error ?? projection.error;

  return {
    error,
    loading: liveQuery.loading,
    threadIds: error ? EMPTY_THREAD_IDS : projection.threadIds,
  };
}
