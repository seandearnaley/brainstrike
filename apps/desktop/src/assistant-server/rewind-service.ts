/**
 * Conversation Rewind service (BST-1115, W5 T3) — main-process only.
 *
 * Restores a thread to the state it had immediately BEFORE a chosen message.
 * The message and every later one are tombstoned (soft, one-level redo until
 * the next user message finalizes), and in `conversation-and-files` mode every
 * agent file edit journaled by the runs at or after that message is reverted,
 * newest-first, sequentially.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE — none of them may be relaxed for
 * convenience or for a passing test:
 *
 * 1. THE ACKNOWLEDGMENT GATE. When the pre-flight scan finds ANY conflict,
 *    `applyRewind` applies NOTHING: not the clean files, not the conflicted
 *    ones, not the tombstone batch. One conflicting file blocks the WHOLE
 *    apply until the caller passes `acknowledgeConflicts: true`. There is
 *    deliberately no per-file override and no "apply the clean ones" path —
 *    a partially-applied rewind is a workspace no one, user or program, can
 *    reason about.
 *    The gate binds the SCAN, which is the only thing it can bind: a file
 *    that changes between the scan and the apply still refuses individually
 *    and is named in `fileOutcomes`. That is inherent TOCTOU, not a
 *    relaxation of this rule — the rule is that no conflict the user was
 *    SHOWN is ever applied over.
 * 2. THE PAIRING RULE. A file revert and its journal after-capture are one
 *    operation. Every successful revert writes exactly one capture row under
 *    the rewind's `revertId`, inside the same file lock, before the write.
 *    The count is ASSERTED after the loop and a mismatch throws: redo over an
 *    unjournaled revert would be silent degradation of the destructive seam.
 * 3. SEQUENTIAL, NEWEST-FIRST. The plan is executed in one ordered pass. A
 *    file edited by two runs in the range has two entries whose reverts only
 *    compose in that order. `Promise.all` here is not an optimization, it is
 *    a corruption.
 *
 * ORDERING WITHIN AN APPLY: tombstones are written BEFORE the file reverts.
 * If the process dies between the two, the thread is hidden but the files are
 * untouched — a state redo fully undoes. The reverse order would leave files
 * reverted with a live conversation and no batch to redo.
 *
 * EVERY TOMBSTONE MUTATION IS SERIALIZED PER THREAD (W5 T4b) — apply, redo and
 * finalization alike. Redo and finalization are the two ways a batch stops
 * existing, they are raised by two independent user gestures (the toast's Redo
 * button and the next send), and they are reachable at the same instant.
 * Interleaved they produce a lie: redo reads a batch, finalization hard-deletes
 * those messages and drops the sidecar rows, and redo then reverts the files
 * back and reports success with an empty `restoredMessageIds` — a workspace
 * restored to a conversation that no longer exists.
 * `withThreadRewindLock` makes the outcome deterministic instead:
 * whichever gesture reaches the lock first completes in full, and the loser
 * re-reads and refuses with a NAMED reason. Redo re-reads its batch INSIDE the
 * lock precisely so it can lose.
 */

import type { AssistantEditCheckpointRecord } from '@brainstrike/agent';
import type {
  AssistantRewindConflict,
  AssistantRewindFileOutcome,
  AssistantRewindFinalization,
  AssistantRewindMode,
  AssistantRewindPreviewResult,
  AssistantRewindRange,
  AssistantRewindRedoResult,
  AssistantRewindRefused,
  AssistantRewindResult,
  AssistantRewindRootOutcome,
} from '@brainstrike/assistant-contract';
import type { Changeset, ChangesetView } from '@brainstrike/types';
import { resolveJournalChangesetView } from './changeset-journal-view';
import {
  type EditCheckpointDatabase,
  listRunCheckpoints,
  listRunRangeCheckpoints,
} from './edit-checkpoint-journal';
import { type CheckpointRevertDeps, revertCheckpointEntry } from './edit-checkpoint-revert';
import { type RewindRevertPlan, scanRewindRange } from './rewind-conflict-scan';
import {
  deleteThreadTombstones,
  deleteTombstoneBatch,
  hasInFlightThreadRun,
  insertTombstoneBatch,
  isLatestRewindBatch,
  listThreadTombstones,
  listTombstoneBatch,
  resolveRewindRunRange,
  resolveRewindTarget,
} from './rewind-repository';

/** `tool_name` stamped on every revert-time after-capture row, so the journal
 * says plainly which rows describe a rewind rather than an agent edit. */
export const REWIND_REVERT_TOOL_NAME = 'brainstrike.rewindRevert';

const CHECKPOINTS_TABLE = 'brainstrike_assistant_edit_checkpoints';

export type RewindServiceDeps = CheckpointRevertDeps;

/** Hard-delete seam for finalization. Production wires this to the memory
 * store's `deleteMessages` override (Mastra's own storage API — never a raw
 * DELETE against `mastra_messages`, which Mastra owns). */
export interface RewindFinalizationDeps {
  readonly deleteMessages: (messageIds: readonly string[]) => Promise<void>;
}

type RunRangeChangeset = Extract<Changeset, { kind: 'run-range' }>;

/** Tail of the in-flight promise chain per serialized thread id. */
const threadRewindLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize thread-scoped tombstone mutations (redo, finalization).
 *
 * The promise-chain shape is the same as `withFileLock`
 * (packages/agent/src/tools/file-write-lock.ts) and deliberately NOT that
 * function: keying a lock named for FILES by a thread id would misdescribe
 * what is being serialized, and these two locks must never contend with each
 * other. Tasks for the same thread run strictly in submission order; different
 * threads stay concurrent. The lock is released however the task settles, so a
 * failing finalization never wedges the thread's redo.
 */
function withThreadRewindLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
  const previous = threadRewindLocks.get(threadId) ?? Promise.resolve();
  const run = previous.then(task, task);
  // The chain tail swallows rejection so the NEXT waiter is not rejected by an
  // earlier task's failure; the real result still reaches THIS caller.
  const chain = run.then(
    () => undefined,
    () => undefined
  );
  threadRewindLocks.set(threadId, chain);
  void chain.finally(() => {
    if (threadRewindLocks.get(threadId) === chain) {
      threadRewindLocks.delete(threadId);
    }
  });
  return run;
}

function rewindNotFound(rewindId: string): AssistantRewindRedoResult {
  return {
    conflicts: [],
    message: `rewind batch "${rewindId}" was not found (already redone or finalized).`,
    ok: false,
    reason: 'rewind-not-found',
  };
}

function changesetForRange(
  threadId: string,
  range: AssistantRewindRange
): RunRangeChangeset | null {
  if (range.kind !== 'runs') {
    return null;
  }
  // Open-ended on purpose: a rewind covers everything from its anchor run to
  // the newest run in the thread. `listRunRangeCheckpoints` resolves that with
  // the W3 `(started_at, id)` row-value predicate.
  return { fromRunId: range.fromRunId, kind: 'run-range', threadId };
}

async function loadRangeRecords(
  db: EditCheckpointDatabase,
  threadId: string,
  range: AssistantRewindRange
): Promise<
  | { readonly ok: true; readonly records: readonly AssistantEditCheckpointRecord[] }
  | { readonly ok: false; readonly error: string }
> {
  if (range.kind !== 'runs') {
    return { ok: true, records: [] };
  }
  const result = await listRunRangeCheckpoints(db, { fromRunId: range.fromRunId, threadId });
  if (!result.ok) {
    return { error: result.error, ok: false };
  }
  return { ok: true, records: result.value };
}

function fileOutcome(
  record: AssistantEditCheckpointRecord,
  outcome: Awaited<ReturnType<typeof revertCheckpointEntry>>
): AssistantRewindFileOutcome {
  if (outcome.ok) {
    return {
      checkpointId: record.id,
      code: 'reverted',
      message: null,
      path: record.path,
      rootId: record.rootId,
    };
  }
  return {
    checkpointId: record.id,
    code: outcome.code === 'conflict' ? 'conflict' : outcome.code,
    message: outcome.message,
    path: record.path,
    rootId: record.rootId,
  };
}

/**
 * Per-root roll-up covering EVERY root the plan touches, including a root that
 * contributed only conflicts and a root that is no longer connected
 * (`rootPath: null`). The MULTI-ROOT BAR forbids a silently skipped root:
 * absence from this list is never how a root's outcome is communicated, so
 * this iterates the PLAN's roots rather than the successful outcomes.
 */
function buildRootOutcomes(
  plan: RewindRevertPlan,
  outcomes: readonly AssistantRewindFileOutcome[]
): readonly AssistantRewindRootOutcome[] {
  const conflictsByRoot = new Map<string, number>();
  for (const conflict of plan.conflicts) {
    conflictsByRoot.set(conflict.rootId, (conflictsByRoot.get(conflict.rootId) ?? 0) + 1);
  }
  return Array.from(plan.roots.entries()).map(([rootId, info]) => {
    const rootOutcomes = outcomes.filter((outcome) => outcome.rootId === rootId);
    const attempted = plan.records.filter((record) => record.rootId === rootId).length;
    const reverted = rootOutcomes.filter((outcome) => outcome.code === 'reverted').length;
    return {
      attempted,
      conflicts: conflictsByRoot.get(rootId) ?? 0,
      failed: rootOutcomes.length - reverted,
      reverted,
      rootId,
      rootLabel: info.label,
      rootPath: info.path,
    };
  });
}

async function countCaptureRows(db: EditCheckpointDatabase, revertId: string): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM ${CHECKPOINTS_TABLE} WHERE run_id = $1`,
    [revertId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Execute a revert plan in ONE sequential newest-first pass.
 *
 * `force` is applied per-record and ONLY to records the scan actually flagged.
 * Blanket-forcing every record once the user acknowledges one conflict would
 * silently clobber an unrelated file changed between the scan and the apply —
 * the acknowledgment is for the paths the user was SHOWN, not a global
 * override.
 */
async function executePlan(
  db: EditCheckpointDatabase,
  plan: RewindRevertPlan,
  deps: RewindServiceDeps,
  afterCapture: { readonly revertId: string; readonly toolName: string } | null
): Promise<readonly AssistantRewindFileOutcome[]> {
  const forced = new Set(plan.conflicts.map((conflict) => conflict.checkpointId));
  const outcomes: AssistantRewindFileOutcome[] = [];
  for (const record of plan.records) {
    const outcome = await revertCheckpointEntry(
      db,
      {
        force: forced.has(record.id),
        id: record.id,
        ...(afterCapture ? { afterCapture } : {}),
      },
      deps
    );
    outcomes.push(fileOutcome(record, outcome));
  }
  return outcomes;
}

/**
 * PAIRING RULE ENFORCEMENT. Every successful revert must have written exactly
 * one after-capture row under `revertId`. A mismatch means a file was mutated
 * without a journal row to undo it, which makes redo silently lossy — so it
 * throws rather than returning a result that looks fine.
 */
async function assertAfterCapturePairing(
  db: EditCheckpointDatabase,
  revertId: string,
  outcomes: readonly AssistantRewindFileOutcome[]
): Promise<void> {
  const reverted = outcomes.filter((outcome) => outcome.code === 'reverted').length;
  const captured = await countCaptureRows(db, revertId);
  if (captured !== reverted) {
    throw new Error(
      `rewind-pairing-violation: revert batch "${revertId}" reverted ${reverted} file(s) but journaled ${captured} after-capture row(s); redo would be lossy.`
    );
  }
}

/**
 * Preview a rewind. The `view` is the EXISTING run-range `ChangesetView` — the
 * same resolution the Changes surface renders, never a second computation, so
 * the confirm modal and the Review panel cannot disagree.
 *
 * `conflicts` here is advisory: disk can change between preview and apply, and
 * `applyRewind` re-scans. The scan is the authority for the gate, not this.
 */
export async function rewindToMessage(
  db: EditCheckpointDatabase,
  args: { readonly messageId: string; readonly threadId: string }
): Promise<AssistantRewindPreviewResult> {
  const target = await resolveRewindTarget(db, args.threadId, args.messageId);
  if (!target) {
    return {
      conflicts: [],
      message: `message "${args.messageId}" was not found in thread "${args.threadId}".`,
      ok: false,
      reason: 'message-not-found',
    };
  }
  const range = await resolveRewindRunRange(db, target);
  const changeset = changesetForRange(args.threadId, range);
  const recordsResult = await loadRangeRecords(db, args.threadId, range);
  if (!recordsResult.ok) {
    return {
      conflicts: [],
      message: recordsResult.error,
      ok: false,
      reason: 'range-unresolvable',
    };
  }
  const plan = await scanRewindRange(db, recordsResult.records);

  let view: ChangesetView | null = null;
  if (changeset) {
    const viewResult = await resolveJournalChangesetView(db, changeset);
    if (!viewResult.ok) {
      return { conflicts: [], message: viewResult.error, ok: false, reason: 'range-unresolvable' };
    }
    view = viewResult.value;
  }

  return {
    changeset,
    conflicts: plan.conflicts,
    messageId: args.messageId,
    ok: true,
    range,
    threadId: args.threadId,
    tombstoneMessageIds: target.tombstoneMessageIds,
    view,
  };
}

function refuseInFlightRun(threadId: string): AssistantRewindRefused {
  return {
    conflicts: [],
    message: `thread "${threadId}" has a run in flight and nothing was applied; wait for it to finish or stop it, then restore.`,
    ok: false,
    reason: 'run-in-flight',
  };
}

function refuseConflicts(conflicts: readonly AssistantRewindConflict[]): AssistantRewindRefused {
  const paths = conflicts.map((conflict) => conflict.path).join(', ');
  return {
    conflicts,
    message: `${conflicts.length} file(s) cannot be restored cleanly and nothing was applied: ${paths}. Re-issue with acknowledgeConflicts to proceed.`,
    ok: false,
    reason: 'conflicts-unacknowledged',
  };
}

/**
 * Apply a rewind.
 *
 * `mode` is REQUIRED and explicit (Amendment 1): there is no default that
 * silently reverts files. `conversation-only` writes the tombstone batch with
 * `revert_id = NULL`, touches no file, writes no journal row, and the
 * acknowledgment gate does not apply to it because nothing reaches disk.
 *
 * REFUSES OUTRIGHT WHILE A RUN IS IN FLIGHT (`run-in-flight`), in both modes
 * and before anything is scanned or written — see `applyRewindLocked`. Both
 * entry points reach this; only one of them has any renderer-side run state to
 * gate on, which is why the binding check lives here.
 *
 * Holds the thread lock for the same reason redo and finalization do: this is
 * the THIRD writer of the tombstone table, and a finalization landing between
 * this batch's insert and its file reverts would leave a rewind whose files are
 * reverted but whose batch no longer exists to redo.
 */
export async function applyRewind(
  db: EditCheckpointDatabase,
  args: {
    readonly acknowledgeConflicts?: boolean;
    readonly messageId: string;
    readonly mode: AssistantRewindMode;
    readonly threadId: string;
  },
  deps: RewindServiceDeps
): Promise<AssistantRewindResult> {
  return await withThreadRewindLock(args.threadId, () => applyRewindLocked(db, args, deps));
}

async function applyRewindLocked(
  db: EditCheckpointDatabase,
  args: {
    readonly acknowledgeConflicts?: boolean;
    readonly messageId: string;
    readonly mode: AssistantRewindMode;
    readonly threadId: string;
  },
  deps: RewindServiceDeps
): Promise<AssistantRewindResult> {
  // THE IN-FLIGHT GATE, and it is FIRST: a live run is a property of the
  // thread, not of the arguments, so it refuses before anything else is even
  // resolved and in BOTH modes — `conversation-only` writes no file but would
  // still tombstone messages the run is mid-way through appending.
  // This is the authoritative half of the guard. `MessageRewindAction` hides
  // itself while `thread.isRunning`, but that state exists only inside the
  // assistant panel's React tree; the Changes-surface header action is a
  // sibling page that cannot read it. Refusing here covers both entry points
  // and is not spoofable by a stale renderer.
  if (await hasInFlightThreadRun(db, args.threadId)) {
    return refuseInFlightRun(args.threadId);
  }
  const target = await resolveRewindTarget(db, args.threadId, args.messageId);
  if (!target) {
    return {
      conflicts: [],
      message: `message "${args.messageId}" was not found in thread "${args.threadId}".`,
      ok: false,
      reason: 'message-not-found',
    };
  }
  const range = await resolveRewindRunRange(db, target);
  const rewindId = crypto.randomUUID();

  if (args.mode === 'conversation-only') {
    const tombstoned = await insertTombstoneBatch(db, {
      messageIds: target.tombstoneMessageIds,
      revertId: null,
      rewindId,
      threadId: args.threadId,
    });
    return {
      fileOutcomes: [],
      mode: args.mode,
      ok: true,
      range,
      revertId: null,
      rewindId,
      rootOutcomes: [],
      tombstonedMessageIds: tombstoned,
    };
  }

  const recordsResult = await loadRangeRecords(db, args.threadId, range);
  if (!recordsResult.ok) {
    return { conflicts: [], message: recordsResult.error, ok: false, reason: 'range-unresolvable' };
  }
  const plan = await scanRewindRange(db, recordsResult.records);
  // THE GATE. Nothing above this line has written anything; nothing below it
  // runs until the caller has been shown every named path and acknowledged.
  if (plan.conflicts.length > 0 && args.acknowledgeConflicts !== true) {
    return refuseConflicts(plan.conflicts);
  }

  const revertId = crypto.randomUUID();
  const tombstoned = await insertTombstoneBatch(db, {
    messageIds: target.tombstoneMessageIds,
    revertId,
    rewindId,
    threadId: args.threadId,
  });
  const fileOutcomes = await executePlan(db, plan, deps, {
    revertId,
    toolName: REWIND_REVERT_TOOL_NAME,
  });
  await assertAfterCapturePairing(db, revertId, fileOutcomes);

  return {
    fileOutcomes,
    mode: args.mode,
    ok: true,
    range,
    revertId,
    rewindId,
    rootOutcomes: buildRootOutcomes(plan, fileOutcomes),
    tombstonedMessageIds: tombstoned,
  };
}

/**
 * Undo the newest rewind: restore the files it reverted (coupled mode) and
 * un-tombstone its batch.
 *
 * Redo is ONE LEVEL and only until finalization. Redoing anything other than
 * the thread's newest batch is refused rather than silently reordered — an
 * older batch's messages must stay hidden while a newer rewind still covers
 * them.
 *
 * The same acknowledgment gate applies: if restoring the files would conflict
 * (the user edited them after the rewind), the WHOLE redo refuses, including
 * the un-tombstone. A conversation that reappeared without its files would be
 * a lie about what was restored.
 *
 * RACING FINALIZATION. The first read below only resolves which thread to
 * serialize on; the batch is read AGAIN inside the lock and that second read
 * is the authoritative one. A finalization that reached the lock first has
 * hard-deleted the messages, so the batch is genuinely gone and this returns
 * the typed `rewind-not-found` refusal — before touching a single file. The
 * unserialized version of this function could revert the files and then report
 * success over an empty restore set, which is exactly the silent no-op the
 * one-level-redo contract must not have.
 */
export async function redoRewind(
  db: EditCheckpointDatabase,
  args: { readonly acknowledgeConflicts?: boolean; readonly rewindId: string },
  deps: RewindServiceDeps
): Promise<AssistantRewindRedoResult> {
  const probe = await listTombstoneBatch(db, args.rewindId);
  const probed = probe[0];
  if (!probed) {
    return rewindNotFound(args.rewindId);
  }
  return await withThreadRewindLock(probed.threadId, async () => {
    const batch = await listTombstoneBatch(db, args.rewindId);
    const first = batch[0];
    if (!first) {
      return rewindNotFound(args.rewindId);
    }
    if (!(await isLatestRewindBatch(db, first.threadId, args.rewindId))) {
      return {
        conflicts: [],
        message: `rewind batch "${args.rewindId}" is not the newest rewind in thread "${first.threadId}"; redo one level at a time.`,
        ok: false,
        reason: 'not-latest-rewind',
      };
    }

    const revertId = first.revertId;
    let fileOutcomes: readonly AssistantRewindFileOutcome[] = [];
    let rootOutcomes: readonly AssistantRewindRootOutcome[] = [];
    if (revertId !== null) {
      const captures = await listRunCheckpoints(db, revertId, first.threadId);
      const plan = await scanRewindRange(db, captures);
      if (plan.conflicts.length > 0 && args.acknowledgeConflicts !== true) {
        return refuseConflicts(plan.conflicts);
      }
      // No after-capture on a redo: redo is one level deep, so there is no
      // second-order undo to journal for.
      fileOutcomes = await executePlan(db, plan, deps, null);
      rootOutcomes = buildRootOutcomes(plan, fileOutcomes);
    }

    const restoredMessageIds = await deleteTombstoneBatch(db, args.rewindId);
    return {
      fileOutcomes,
      ok: true,
      restoredMessageIds,
      revertId,
      rewindId: args.rewindId,
      rootOutcomes,
    };
  });
}

/**
 * Finalize every outstanding rewind in a thread — the hook the next USER
 * message fires (wired in the renderer at the run-creation seam; see
 * `use-rewind-finalization.ts` and `docs/agents/assistant-runtime.md`).
 * Tombstoned messages are hard-deleted through Mastra's own `deleteMessages`
 * storage path and their sidecar rows go with them, which is what ends the
 * one-level redo window.
 *
 * The delete runs FIRST and its failure PROPAGATES: if the messages could not
 * be removed, the tombstones must stay so the messages remain hidden. Dropping
 * the sidecar rows anyway would resurrect a rewound conversation without
 * anyone being told. That propagation is INSIDE this function only — the
 * caller reports it and never lets it hold up the send that triggered it (the
 * user's message is not hostage to a cleanup they did not ask for, and a
 * thread whose tombstones survive is still correctly hidden, so the next send
 * simply tries again).
 *
 * IDEMPOTENT by construction: `finalized: false` with empty sets is the honest
 * answer for a thread with nothing outstanding, so a double fire — two sends
 * in flight, a retry after a transport error — costs one query and changes
 * nothing. Serialized per thread against redo (see `withThreadRewindLock`), so
 * "nothing outstanding" can never mean "a redo is halfway through undoing it".
 */
export async function finalizeThreadRewinds(
  db: EditCheckpointDatabase,
  threadId: string,
  deps: RewindFinalizationDeps
): Promise<AssistantRewindFinalization> {
  return await withThreadRewindLock(threadId, async () => {
    const tombstones = await listThreadTombstones(db, threadId);
    if (tombstones.length === 0) {
      return { deletedMessageIds: [], finalized: false, rewindIds: [] };
    }
    const messageIds = tombstones.map((row) => row.messageId);
    await deps.deleteMessages(messageIds);
    const deletedMessageIds = await deleteThreadTombstones(db, threadId);
    return {
      deletedMessageIds,
      finalized: true,
      rewindIds: Array.from(new Set(tombstones.map((row) => row.rewindId))),
    };
  });
}
