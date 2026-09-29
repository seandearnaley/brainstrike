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
 * therefore meaningless across the two legs, so ordering is NOT expressed as a
 * comparison — it is expressed as ONE same-run exclusion, below.
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
 * ...with EXACTLY ONE exception, and it is load-bearing. Mastra's approval gate
 * runs INSIDE `toolCallStep`, i.e. AFTER the model's `tool-call` part has
 * already streamed. That part maps to `status: 'start'`
 * (`packages/agent/src/mastra/tool-event-mapper.ts`) and so to a `tool.started`
 * run event carrying the SAME `toolCallId`, on the PAUSING leg, BEFORE the
 * pause row. Observed order on the live loop, pinned in
 * `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`:
 * `['tool.started', 'tool.approval.requested']`. Matching `tool.started` on
 * `toolCallId` alone would therefore let every pause answer ITSELF and the
 * "needs you" glyph would never light for anyone.
 *
 * The guard is `occurred_at`-shaped: an answer must have occurred AFTER the
 * pause it answers. `sequence` cannot serve (it is per-run, so it is
 * meaningless across the two legs), but `occurred_at` IS comparable across
 * them, because every run-event stamp comes from ONE producer: the agent
 * stream's `makeRunEventChunk`
 * (`packages/agent/src/mastra/stream-run-event-chunks.ts`,
 * `timestamp ?? new Date().toISOString()`). The repository only normalizes
 * what it is handed (`assistant-memory-repository.ts` `appendThreadRunEvent`)
 * and the column carries NO `DEFAULT NOW()`, so there is no second clock — the
 * pausing leg and the resume leg are stamped by the same process. The bound
 * worth knowing: that is wall clock, not monotonic, so a backwards NTP step
 * between legs could in principle invert them. Legs are separated by human
 * deliberation, so a sub-second correction cannot; nothing here is safe against
 * a large manual clock change, and that is accepted rather than defended.
 *
 * Resolution is milliseconds (`toISOString`). A tie fails the comparison and so
 * counts as NOT an answer — the safe direction, since it keeps an obligation
 * lit rather than silently dropping one. That is also the COMMON case rather
 * than a corner: a pre-pause `tool.started` and the pause it precedes are
 * emitted back-to-back and frequently share a millisecond, and "not an answer"
 * is exactly what that start must be. A real answer follows human deliberation,
 * so it can never tie. The three terminal kinds could not be emitted by the
 * pausing leg anyway, so the guard only ever binds on `tool.started`.
 *
 * IT USED TO BE `run_id`-SHAPED — `AND NOT (answer.kind = 'tool.started' AND
 * answer.run_id = requested.run_id)` — on the reasoning that the runs already
 * carry the ordering: a call's pre-pause start shares its pause's run, and only
 * the post-approve start is on a different one. That premise is FALSE whenever
 * a step has TWO gated calls. Mastra's `foreach(toolCallStep)` is sequential,
 * so it pauses on A alone while B's `tool-call` part has already streamed:
 * leg 1 emits `tool.started` for BOTH A and B, and B does not reach its own
 * gate — and its own pause row — until leg 2. B's pre-pause start is therefore
 * on a DIFFERENT run than B's pause, the same-run exclusion never fires for it,
 * and B's own pre-pause start answered B's pause. The glyph went dark while the
 * user was genuinely still being asked about B. That producer shape is pinned
 * against the live loop in
 * `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`
 * ("PAUSES ONE CALL AT A TIME") and its projection outcome in this hook's
 * integration lane. The defect predates BST-1440: with the older producer it
 * merely surfaced later, once `tool.completed` cleared the first pause.
 *
 * The resume-leg re-yield is what makes this projection clear on ANSWER rather
 * than on completion (BST-1440), and it is produced by `makeResumedStartChunks`
 * in `packages/agent/src/mastra/agent-streaming.ts` — Mastra never replays a
 * resumed step's `tool-call` part, so that seam synthesises the start and hands
 * it to the same tool-lifecycle chunk maker the mainline uses. Until it did,
 * `tool.started` never appeared on a resume leg at all and the glyph stayed
 * lit, for a call the user had already approved, until `tool.completed` landed.
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
        AND answer.occurred_at > requested.occurred_at
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
