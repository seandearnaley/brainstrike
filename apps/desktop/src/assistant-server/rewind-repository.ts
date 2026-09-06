/**
 * Persistence for Conversation Rewind (BST-1115, W5 T3): resolving what a
 * rewind covers, and the tombstone sidecar's reads/writes.
 *
 * READ-ONLY over Mastra's tables and over `brainstrike_assistant_thread_runs`
 * — this module never writes a message, never creates a run, and never
 * bootstraps either table (the runId-provenance invariant in
 * `docs/agents/assistant-persistence.md` forbids a second producer). The only
 * table it writes is `brainstrike_assistant_message_tombstones` (migration
 * 080).
 */

import type { AssistantRewindRange } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';

const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/**
 * The TERMINAL `status` values of `brainstrike_assistant_thread_runs`.
 *
 * Mirrors `AssistantThreadRunStatus` in
 * `packages/assistant-data/src/assistant-memory-repository.ts`, which is the sole
 * writer of that column: `createThreadRun` stamps `'running'`, and
 * `completeThreadRun` takes `Exclude<AssistantThreadRunStatus, 'running'>` —
 * exactly these three. Main-process code cannot import that renderer package,
 * so the list is restated here rather than shared; keep the two in step.
 */
const TERMINAL_RUN_STATUSES = ['cancelled', 'completed', 'failed'] as const;

/**
 * True when this thread has a run that has NOT reached a terminal status.
 *
 * The guard on the destructive seam: a rewind that lands mid-run reverts files
 * the run is still writing and tombstones messages it is still appending. The
 * message-level affordance hides itself while `thread.isRunning`, but the
 * Changes-surface entry point is a sibling top-level page with no
 * assistant-runtime state to read, so this — inside the thread lock, in the
 * main process — is the refusal that actually binds BOTH entry points and
 * cannot be spoofed by a stale renderer.
 *
 * The predicate EXCLUDES the terminal values rather than matching `'running'`
 * on purpose: a status this list does not recognize counts as in flight. On a
 * destructive seam the fail-safe direction is refusing a rewind that might have
 * been allowed, never reverting files under a run that is still going.
 *
 * A row STRANDED in 'running' by a dead process (crash/quit killed both
 * status writers) would trip this forever; the startup reaper
 * (`thread-run-startup-reaper.ts`, BST-1162) marks provably-dead rows failed
 * at the next app start using boot-time evidence, so this refusal only ever
 * describes runs the current process could actually own — its fail-safe
 * posture (unknown status = in flight) is untouched.
 *
 * NO RELATION PROBE (BST-1651). This used to answer `false` — "nothing is in
 * flight" — for an absent runs table, which on a destructive seam is the
 * fail-OPEN direction, the opposite of the posture the rest of this function
 * defends. Migration 118 owns the relation and `getDatabase()` resolves only
 * after `migrate()`, so the branch guarded a state main cannot reach; an
 * unmigrated database now raises 42P01 and the gate refuses by throwing.
 */
export async function hasInFlightThreadRun(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${RUNS_TABLE}
       WHERE thread_id = $1 AND status <> ALL($2::text[])
     ) AS present`,
    [threadId, [...TERMINAL_RUN_STATUSES]]
  );
  return result.rows[0]?.present === true;
}

export interface RewindTarget {
  /** Full-precision `::text` timestamp — never routed through a JS `Date`. */
  readonly createdAt: string;
  readonly messageId: string;
  readonly threadId: string;
  /** Messages the rewind hides, oldest-first, INCLUDING the target itself. */
  readonly tombstoneMessageIds: readonly string[];
}

interface MessageAnchorRow {
  createdAt: string;
  id: string;
}

/**
 * Resolve everything a rewind to `messageId` covers on the conversation side.
 * Returns `null` when the message does not exist IN THIS THREAD (a message id
 * belonging to another thread counts as missing — never a cross-thread leak,
 * mirroring `listRunRangeCheckpoints`'s anchor posture). Migration 117 owns
 * `mastra_messages`, so its absence is no longer a case this coerces to
 * `null` (BST-1651) — an unmigrated database raises 42P01.
 *
 * Timestamps are read with an explicit `::text` cast so the microsecond
 * fraction Postgres stores survives; feeding a driver-truncated millisecond
 * `Date` back in as a bound could exclude the very anchor row it came from.
 */
export async function resolveRewindTarget(
  db: EditCheckpointDatabase,
  threadId: string,
  messageId: string
): Promise<RewindTarget | null> {
  const targetResult = await db.query<MessageAnchorRow>(
    `SELECT id AS "id", "createdAt"::text AS "createdAt"
     FROM ${MASTRA_MEMORY_TABLES.messages}
     WHERE id = $1 AND thread_id = $2`,
    [messageId, threadId]
  );
  const target = targetResult.rows[0];
  if (!target) {
    return null;
  }

  const tombstonesResult = await db.query<{ id: string }>(
    `SELECT id AS "id"
     FROM ${MASTRA_MEMORY_TABLES.messages}
     WHERE thread_id = $1 AND ("createdAt", id) >= ($2::timestamptz, $3)
     ORDER BY "createdAt" ASC, id ASC`,
    [threadId, target.createdAt, target.id]
  );

  return {
    createdAt: target.createdAt,
    messageId: target.id,
    threadId,
    tombstoneMessageIds: tombstonesResult.rows.map((row) => row.id),
  };
}

/**
 * Which runs a rewind's file revert covers.
 *
 * THE STORED TURN LINK DECIDES FIRST (BST-1163): a run row carrying
 * `turn_message_id` is in range exactly when its turn's user message is
 * at-or-after the target in the message total order — turn membership, not
 * timestamps. Every new run row carries the link (stamped at
 * `createThreadRun` from the transport's per-leg turn anchor), so the
 * timestamp rule below is the FALLBACK for pre-link rows and for a link
 * whose message was hard-deleted by a finalized rewind.
 *
 * THE FALLBACK ANCHOR IS THE TARGET MESSAGE, COMPARED AGAINST `completed_at`.
 * A run is in range when it had NOT yet finished at the moment the target
 * message was sent. Both halves of that sentence are load-bearing:
 *
 *  - `completed_at` rather than `started_at`, because a run row is created by
 *    the RENDERER the moment the user hits send
 *    (`createAssistantThreadRunPromise`) while Mastra persists the user message
 *    during the request — the run a message TRIGGERED can be stamped a few
 *    milliseconds EARLIER than the message itself. A `started_at` comparison
 *    against the target would drop that run, which is the single most important
 *    one in the range. It always ends LATER, so `completed_at` orders it
 *    unambiguously.
 *  - the TARGET rather than the message before it. Anchoring on the PRECEDING
 *    message (the original W5 T3 rule) assumed a turn's runs all start before
 *    that turn's assistant message is durable. They do not: a turn is not one
 *    run. Every tool-approval / askUser resume mints a NEW run row through the
 *    same `prepareRequestData` -> `createThreadRun` seam, while the assistant
 *    message row is persisted at the START of the turn and upserted in place as
 *    the turn streams on. So the previous turn's later runs — usually the ones
 *    that did the file work — start after the previous message and were swept
 *    into the range. Recovered from the 2026-08-05 live smoke: a run that
 *    started 81 seconds BEFORE the message being rewound to, and had already
 *    completed 28 seconds before it, was reverted; because its capture was a
 *    `created` row, the revert DELETED the user's file. See the regression in
 *    `rewind-service.integration.test.ts`.
 *
 * The comparison is STRICT (`>`), so a tie resolves toward reverting LESS. An
 * under-revert leaves visible file changes the user can still act on; an
 * over-revert destroys work they meant to keep. Those are not symmetric.
 *
 * A NULL `completed_at` counts as in range — it is the fail-safe read of "this
 * run never reported finishing" — but it is not reachable from `applyRewind`:
 * `hasInFlightThreadRun` refuses the whole rewind while any run in the thread
 * is non-terminal, and `completeThreadRun` stamps status and `completed_at`
 * together. A preview over a thread with an unfinished run still describes the
 * wider range honestly rather than hiding it.
 *
 * `none` now carries exactly one reason. BST-1651 retired the companion
 * `runs-table-absent`: it described a profile whose renderer bootstrap had not
 * run, and migration 118 creates the relation for every profile, so the only
 * database that could produce it is one that was never migrated — which raises
 * 42P01 rather than reporting a reason.
 */
export async function resolveRewindRunRange(
  db: EditCheckpointDatabase,
  target: RewindTarget
): Promise<AssistantRewindRange> {
  // TURN GROUPING (BST-1163): a run carrying `turn_message_id` is in range
  // exactly when its TURN's user message is at-or-after the target in the
  // message total order — the same `("createdAt", id)` order
  // `resolveRewindTarget` tombstones in, so the conversation and file halves
  // of a rewind agree on the boundary. Timestamps never enter it, which is
  // what closes the straggler class the `completed_at` rule cannot express
  // (an earlier turn's leg whose terminal write landed after the target
  // message — swept into the revert and deleting pre-target work).
  //
  // A NULL link — a row minted before BST-1163, or one whose linked message
  // is gone (finalized rewind hard-deleted it) — keeps the original
  // `completed_at` fallback in the CASE arm below: "had not finished when the
  // target message was sent". Never a silent drop from the range. The COLUMN
  // is not probed for: migration 118 carries
  // `ADD COLUMN IF NOT EXISTS turn_message_id`, so an upgraded install has it
  // before any main-process read can land (BST-1651 retired the
  // information_schema probe that predated that ALTER).
  const result = await db.query<{ id: string }>(
    `SELECT r.id AS "id"
     FROM ${RUNS_TABLE} r
     LEFT JOIN ${MASTRA_MEMORY_TABLES.messages} m
       ON m.id = r.turn_message_id AND m.thread_id = r.thread_id
     WHERE r.thread_id = $1
       AND (
         CASE WHEN m.id IS NOT NULL
           THEN (m."createdAt", m.id) >= ($2::timestamptz, $3)
           ELSE (r.completed_at IS NULL OR r.completed_at > $2::timestamptz)
         END
       )
     ORDER BY r.started_at ASC, r.id ASC`,
    [target.threadId, target.createdAt, target.messageId]
  );
  const runIds = result.rows.map((row) => row.id);
  const fromRunId = runIds[0];
  if (!fromRunId) {
    return { kind: 'none', reason: 'no-runs-after-message' };
  }
  return { fromRunId, kind: 'runs', runIds };
}

/**
 * Resolve the message a rewind must target so that its range STARTS at `runId`
 * — the inverse of {@link resolveRewindRunRange}, and the only way the Changes
 * surface's header action (Amendment 1 A1.3) can reach the rewind API, which
 * is keyed by message and never by run.
 *
 * Same race, read the other way round: the renderer creates the run row on
 * send while Mastra persists the user message during the request, so the
 * message that TRIGGERED a run is the EARLIEST one whose `createdAt` is
 * strictly after that run's `started_at`. For a run that OPENS a turn,
 * `resolveRewindRunRange` re-derives the range from that message and lands back
 * on this run (the run is still in flight when its own message is persisted, so
 * its `completed_at` is later).
 *
 * THE STORED TURN LINK ANSWERS FIRST (BST-1163): a run row carrying
 * `turn_message_id` resolves to its OWN turn's message exactly — including
 * mid-turn resume runs, which the timestamp rule below maps to the NEXT
 * turn's message (a turn is not one run; timestamps alone cannot separate a
 * resume of turn N from the opening run of turn N+1). The timestamp rule
 * remains as the FALLBACK for pre-link rows and for a link whose message a
 * finalized rewind hard-deleted; for those, the residual mid-turn
 * under-coverage still applies — the safe direction, and the modal shows the
 * resolved range (below), so the user is never shown one range and given
 * another.
 *
 * `null` when the run is not in this thread, when Mastra's message table does
 * not exist yet, or when no message follows the run's start — a run whose
 * messages were never persisted has no message to rewind to, and inventing one
 * would be a silent fallback. Callers surface that as a visible refusal.
 *
 * The resolved id is ADVISORY in exactly one direction: the preview it feeds
 * re-runs the full range resolution and reports the range it actually found,
 * so a boundary tie can never silently widen or narrow what the user confirms
 * against — the modal shows the resolved range, not the requested one.
 */
export async function resolveRewindMessageForRun(
  db: EditCheckpointDatabase,
  threadId: string,
  runId: string
): Promise<string | null> {
  // THE STORED LINK FIRST (BST-1163): a run row carrying `turn_message_id`
  // answers exactly, closing the documented mid-turn under-coverage — a
  // resume run resolves to ITS OWN turn's message rather than the next
  // turn's. The join verifies the message still exists in this thread; a
  // link whose message was hard-deleted (finalized rewind) falls back to the
  // timestamp rule below rather than answering a message the rewind API
  // would refuse.
  const linkedResult = await db.query<{ id: string }>(
    `SELECT r.turn_message_id AS "id"
     FROM ${RUNS_TABLE} r
     JOIN ${MASTRA_MEMORY_TABLES.messages} m
       ON m.id = r.turn_message_id AND m.thread_id = r.thread_id
     WHERE r.id = $1 AND r.thread_id = $2 AND r.turn_message_id IS NOT NULL`,
    [runId, threadId]
  );
  const linkedMessageId = linkedResult.rows[0]?.id;
  if (linkedMessageId !== undefined) {
    return linkedMessageId;
  }
  const runResult = await db.query<{ startedAt: string }>(
    `SELECT started_at::text AS "startedAt" FROM ${RUNS_TABLE} WHERE id = $1 AND thread_id = $2`,
    [runId, threadId]
  );
  const startedAt = runResult.rows[0]?.startedAt;
  if (startedAt === undefined) {
    return null;
  }
  // USER messages only (PR #2291 review): resolving to an assistant snapshot
  // row would hand the range resolver a boundary that sorts AFTER the same
  // turn's user-message anchor, making the conversation and file halves
  // disagree about that turn. Rewind targets are user messages everywhere
  // else in the flow.
  const messageResult = await db.query<{ id: string }>(
    `SELECT id AS "id"
     FROM ${MASTRA_MEMORY_TABLES.messages}
     WHERE thread_id = $1 AND "createdAt" > $2::timestamptz AND role = 'user'
     ORDER BY "createdAt" ASC, id ASC
     LIMIT 1`,
    [threadId, startedAt]
  );
  return messageResult.rows[0]?.id ?? null;
}

/**
 * Resolve the ORIGINAL target of a tombstone batch: its oldest message (by
 * `createdAt, id`, the same total order `resolveRewindTarget` tombstones in)
 * IS the message the rewind was applied to. The snapshot redo path
 * (BST-1164 W7 T3) needs this to re-derive the turn boundary — the batch
 * carries no message-id ordering of its own, and storing one would duplicate
 * what Mastra's table already knows. `null` when the messages are gone,
 * which under the thread rewind lock can only mean the batch raced a
 * finalization and no longer exists either — callers re-check the batch.
 */
export async function resolveEarliestBatchTarget(
  db: EditCheckpointDatabase,
  threadId: string,
  messageIds: readonly string[]
): Promise<RewindTarget | null> {
  if (messageIds.length === 0) {
    return null;
  }
  const result = await db.query<{ id: string }>(
    `SELECT id AS "id"
     FROM ${MASTRA_MEMORY_TABLES.messages}
     WHERE thread_id = $1 AND id = ANY($2::text[])
     ORDER BY "createdAt" ASC, id ASC
     LIMIT 1`,
    [threadId, [...messageIds]]
  );
  const earliest = result.rows[0]?.id;
  if (earliest === undefined) {
    return null;
  }
  return await resolveRewindTarget(db, threadId, earliest);
}

export interface TombstoneRow {
  readonly messageId: string;
  readonly revertId: string | null;
  readonly rewindId: string;
  readonly threadId: string;
}

/**
 * Write one rewind's tombstone batch.
 *
 * `ON CONFLICT (message_id) DO NOTHING` is the AT-MOST-ONCE invariant from
 * migration 080, not defensive noise: a later rewind that re-covers an
 * already-tombstoned message must leave the ORIGINAL batch's row alone, or
 * undoing the newer rewind would resurrect messages the older one hid. A plain
 * insert throws on the second rewind (T1 tested exactly that).
 *
 * `RETURNING` is the only honest way to learn what was inserted — PGlite never
 * populates `affectedRows` (house gotcha), and the returned set is exactly the
 * rows this batch owns.
 */
export async function insertTombstoneBatch(
  db: EditCheckpointDatabase,
  batch: {
    readonly messageIds: readonly string[];
    readonly revertId: string | null;
    readonly rewindId: string;
    readonly threadId: string;
  }
): Promise<readonly string[]> {
  if (batch.messageIds.length === 0) {
    return [];
  }
  const result = await db.query<{ messageId: string }>(
    `INSERT INTO ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} (message_id, thread_id, rewind_id, revert_id)
     SELECT unnest($1::text[]), $2, $3, $4
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id AS "messageId"`,
    [batch.messageIds, batch.threadId, batch.rewindId, batch.revertId]
  );
  return result.rows.map((row) => row.messageId);
}

export async function listTombstoneBatch(
  db: EditCheckpointDatabase,
  rewindId: string
): Promise<readonly TombstoneRow[]> {
  const result = await db.query<TombstoneRow>(
    `SELECT message_id AS "messageId", thread_id AS "threadId",
            rewind_id AS "rewindId", revert_id AS "revertId"
     FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
     WHERE rewind_id = $1
     ORDER BY message_id ASC`,
    [rewindId]
  );
  return result.rows;
}

/**
 * True when `rewindId` is the NEWEST batch in its thread. Redo is one level
 * deep by design, so redoing an older batch while a newer one is still
 * outstanding would un-hide messages the newer rewind means to hide. That is
 * refused, not silently reordered.
 */
export async function isLatestRewindBatch(
  db: EditCheckpointDatabase,
  threadId: string,
  rewindId: string
): Promise<boolean> {
  const result = await db.query<{ rewindId: string }>(
    `SELECT rewind_id AS "rewindId"
     FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
     WHERE thread_id = $1
     ORDER BY tombstoned_at DESC, message_id DESC
     LIMIT 1`,
    [threadId]
  );
  return result.rows[0]?.rewindId === rewindId;
}

export async function deleteTombstoneBatch(
  db: EditCheckpointDatabase,
  rewindId: string
): Promise<readonly string[]> {
  const result = await db.query<{ messageId: string }>(
    `DELETE FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
     WHERE rewind_id = $1
     RETURNING message_id AS "messageId"`,
    [rewindId]
  );
  return result.rows.map((row) => row.messageId);
}

export async function listThreadTombstones(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<readonly TombstoneRow[]> {
  const result = await db.query<TombstoneRow>(
    `SELECT message_id AS "messageId", thread_id AS "threadId",
            rewind_id AS "rewindId", revert_id AS "revertId"
     FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
     WHERE thread_id = $1
     ORDER BY tombstoned_at ASC, message_id ASC`,
    [threadId]
  );
  return result.rows;
}

export async function deleteThreadTombstones(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<readonly string[]> {
  const result = await db.query<{ messageId: string }>(
    `DELETE FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE}
     WHERE thread_id = $1
     RETURNING message_id AS "messageId"`,
    [threadId]
  );
  return result.rows.map((row) => row.messageId);
}
