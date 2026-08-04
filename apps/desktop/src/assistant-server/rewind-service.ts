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
 */
export async function redoRewind(
  db: EditCheckpointDatabase,
  args: { readonly acknowledgeConflicts?: boolean; readonly rewindId: string },
  deps: RewindServiceDeps
): Promise<AssistantRewindRedoResult> {
  const batch = await listTombstoneBatch(db, args.rewindId);
  const first = batch[0];
  if (!first) {
    return {
      conflicts: [],
      message: `rewind batch "${args.rewindId}" was not found (already redone or finalized).`,
      ok: false,
      reason: 'rewind-not-found',
    };
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
}

/**
 * Finalize every outstanding rewind in a thread — the hook the next user
 * message fires. Tombstoned messages are hard-deleted through Mastra's own
 * `deleteMessages` storage path and their sidecar rows go with them, which is
 * what ends the one-level redo window.
 *
 * The delete runs FIRST and its failure PROPAGATES: if the messages could not
 * be removed, the tombstones must stay so the messages remain hidden. Dropping
 * the sidecar rows anyway would resurrect a rewound conversation without
 * anyone being told.
 */
export async function finalizeThreadRewinds(
  db: EditCheckpointDatabase,
  threadId: string,
  deps: RewindFinalizationDeps
): Promise<AssistantRewindFinalization> {
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
}
