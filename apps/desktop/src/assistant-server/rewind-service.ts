/**
 * Conversation Rewind service (BST-1115 W5 T3; file engine swapped to shadow-git
 * snapshots in BST-1164 W7 T3) — main-process only.
 *
 * Restores a thread to the state it had immediately BEFORE a chosen message.
 * The message and every later one are tombstoned (soft, one-level redo until
 * the next user message finalizes), and in `conversation-and-files` mode every
 * workspace root is restored to the target turn's `turn-start` shadow-git
 * snapshot — assistant-tool edits AND shell side effects alike. The edit
 * checkpoint journal is no longer read or written by any rewind path.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE — none of them may be relaxed for
 * convenience or for a passing test:
 *
 * 1. THE ACKNOWLEDGMENT GATE. When the pre-flight scan finds ANY conflict,
 *    `applyRewind` applies NOTHING: not the clean roots, not the conflicted
 *    ones, not the tombstone batch. One conflicting path blocks the WHOLE
 *    apply until the caller passes `acknowledgeConflicts: true`. There is
 *    deliberately no per-file override and no "apply the clean ones" path.
 *    Under the snapshot engine the gate binds THE PREVIEW: a conflict is a
 *    path whose work-tree content changed after the acknowledged preview was
 *    generated (the preview records a per-root work-tree fingerprint; see
 *    `rewind-snapshot-engine.ts`'s module header for the full design), and a
 *    files-mode apply with NO recorded preview refuses `preview-required`
 *    rather than applying blind. The residual race between the drift scan and
 *    the pre-revert snapshot is captured BY that snapshot and therefore
 *    redo-recoverable — narrower and more recoverable than the journal
 *    engine's scan→write TOCTOU, and documented, never skipped.
 * 2. THE PAIRING RULE. A root's restore and its `pre-revert` snapshot are one
 *    operation. `executeSnapshotRestore` records the pre-revert snapshot row
 *    (ledger `run_id = revertId`) BEFORE any byte of that root moves — the
 *    redo source exists before there is anything to redo — and the row count
 *    is ASSERTED after the loop: a mismatch throws, because redo over an
 *    unsnapshotted restore would be silent degradation of the destructive
 *    seam.
 * 3. SEQUENTIAL ROOTS, EXPLICIT PER-ROOT OUTCOMES. Roots restore one at a
 *    time and EVERY root the operation covers appears in `rootOutcomes` —
 *    including a root that is no longer connected (visible conflict + zero
 *    counts + `rootPath: null`) and a nested-repo path (a named
 *    `not_revertible` outcome). Absence is never how an outcome is
 *    communicated.
 *
 * ORDERING WITHIN AN APPLY: tombstones are written BEFORE the file restores.
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
import type { Changeset } from '@brainstrike/types';
import type { CheckpointRevertDeps } from './checkpoint-reindex-deps';
import type { MainQueryHandle } from './main-query-handle';
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
import {
  applySnapshotRedoPlans,
  buildSnapshotPreview,
  type CoveredRewindRoot,
  clearPreviewFingerprint,
  type DisconnectedRewindRoot,
  disconnectedRootConflicts,
  executeSnapshotRestore,
  planSnapshotRedo,
  type RewindSnapshotDeps,
  readPreviewFingerprint,
  resolveFilesCoverage,
  resolveRedoRoots,
  type SnapshotRestoreRootResult,
  savePreviewFingerprint,
  scanPreviewDrift,
} from './rewind-snapshot-engine';

/**
 * Everything a files-mode apply/redo needs: the reindex seam the journal
 * engine already used (`CheckpointRevertDeps`, wired by
 * `createCheckpointReindexDeps`) plus the snapshot seams threaded from
 * main.ts. `finalizeThreadRewinds` needs neither — see
 * {@link RewindFinalizationDeps}.
 */
export type RewindServiceDeps = CheckpointRevertDeps & RewindSnapshotDeps;

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
  // the newest run in the thread — the same identity the Changes surface
  // resolves for its run-range views.
  return { fromRunId: range.fromRunId, kind: 'run-range', threadId };
}

/**
 * Per-root roll-up covering EVERY root the operation touched: each restored
 * root with its honest counts, and each covered-but-disconnected root with
 * zero counts, its gate conflict, and `rootPath: null`. The MULTI-ROOT BAR
 * forbids a silently skipped root: absence from this list is never how a
 * root's outcome is communicated.
 */
function buildRootOutcomes(
  results: readonly SnapshotRestoreRootResult[],
  gateConflicts: readonly AssistantRewindConflict[],
  disconnected: readonly DisconnectedRewindRoot[]
): readonly AssistantRewindRootOutcome[] {
  const conflictsByRoot = new Map<string, number>();
  for (const conflict of gateConflicts) {
    conflictsByRoot.set(conflict.rootId, (conflictsByRoot.get(conflict.rootId) ?? 0) + 1);
  }
  const outcomes: AssistantRewindRootOutcome[] = results.map((result) => {
    const reverted = result.fileOutcomes.filter((outcome) => outcome.code === 'reverted').length;
    return {
      attempted: result.planActionCount,
      conflicts: conflictsByRoot.get(result.root.rootId) ?? 0,
      failed: result.fileOutcomes.length - reverted,
      reverted,
      rootId: result.root.rootId,
      rootLabel: result.root.label,
      rootPath: result.root.rootPath,
    };
  });
  for (const root of disconnected) {
    outcomes.push({
      attempted: 0,
      conflicts: conflictsByRoot.get(root.rootId) ?? 0,
      failed: 0,
      reverted: 0,
      rootId: root.rootId,
      rootLabel: null,
      rootPath: null,
    });
  }
  return outcomes.sort((a, b) => a.rootId.localeCompare(b.rootId));
}

function outcomeSummary(outcome: AssistantRewindFileOutcome): string {
  return outcome.message ? `${outcome.path}: ${outcome.message}` : outcome.path;
}

/**
 * PAIRING RULE ENFORCEMENT (rule 2). Every root whose restore reached the
 * byte-moving step must have recorded exactly one `pre-revert` snapshot row
 * under `revertId` — the redo source (`preRevertRecorded` flips true at the
 * ledger insert, strictly BEFORE any byte of that root moves; a root whose
 * restore FAILED while still false was never mutated and rightly has no
 * row). A mismatch means a root was mutated without a snapshot to undo it,
 * which makes redo silently lossy — so it throws rather than returning a
 * result that looks fine.
 *
 * `rewindId` is carried in the thrown message (never dropped) even though the
 * tombstone batch and the files are already committed by the time this fires:
 * `changes-ipc-handlers.ts`'s `failed()` forwards `Error#message` verbatim as
 * the renderer's `outcome.error`, so this is the ONE channel that reaches the
 * user, and it is also the id needed to find the batch again for recovery.
 */
async function assertPreRevertPairing(
  deps: RewindSnapshotDeps,
  threadId: string,
  rewindId: string,
  revertId: string,
  results: readonly SnapshotRestoreRootResult[]
): Promise<void> {
  const expected = results.filter((result) => result.preRevertRecorded).length;
  const rows = await deps.snapshotRepository.snapshotsForThread(threadId);
  const recorded = rows.filter((row) => row.kind === 'pre-revert' && row.runId === revertId).length;
  if (recorded !== expected) {
    throw new Error(
      `rewind-pairing-violation: rewind "${rewindId}" revert batch "${revertId}" restored ${expected} root(s) but recorded ${recorded} pre-revert snapshot(s); redo would be lossy.`
    );
  }
}

/**
 * Preview a rewind.
 *
 * The `view` is the snapshot engine's own resolution — per covered root, the
 * turn-start snapshot diffed against the live work-tree, exactly what a
 * files-mode apply would change, shell side effects included.
 *
 * `filesScope` reports whether `conversation-and-files` is available at all
 * (the two carried rulings: a pre-snapshot turn and a failed/incomplete
 * capture both refuse the files scope VISIBLY while conversation-only stays
 * offered).
 *
 * Generating a preview RECORDS the per-root work-tree fingerprint that
 * `applyRewind`'s staleness gate binds — see rule 1 in the module header.
 * `conflicts` here is advisory (a disconnected covered root is named up
 * front); the apply-time scan is the authority for the gate.
 */
export async function rewindToMessage(
  db: MainQueryHandle,
  args: { readonly messageId: string; readonly threadId: string },
  deps: RewindSnapshotDeps
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
  const base = {
    messageId: args.messageId,
    ok: true as const,
    range,
    threadId: args.threadId,
    tombstoneMessageIds: target.tombstoneMessageIds,
  };
  if (range.kind !== 'runs' || changeset === null) {
    // No runs after the message ⇒ nothing for the files scope to restore.
    // The scope stays "available" (choosing it applies an empty restore),
    // which is the pre-swap behavior for an empty range.
    return { ...base, changeset: null, conflicts: [], filesScope: { available: true }, view: null };
  }
  const coverage = await resolveFilesCoverage(db, deps, args.threadId, range.fromRunId);
  if (coverage.kind !== 'covered') {
    // A stale fingerprint from an earlier preview of this target must not
    // outlive the coverage that produced it.
    clearPreviewFingerprint(args.threadId, args.messageId);
    return {
      ...base,
      changeset,
      conflicts: [],
      filesScope: { available: false, message: coverage.message, reason: coverage.kind },
      view: null,
    };
  }
  const build = await buildSnapshotPreview(deps, coverage.connected);
  savePreviewFingerprint(args.threadId, args.messageId, build.fingerprint);
  return {
    ...base,
    changeset,
    conflicts: disconnectedRootConflicts(coverage.disconnected),
    filesScope: { available: true },
    view: {
      changeset,
      files: build.files,
      totalAdditions: build.totalAdditions,
      totalDeletions: build.totalDeletions,
    },
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
 * A files-mode apply with no recorded preview fingerprint (no preview was
 * generated for this exact target, or the process restarted / the bounded
 * store evicted it). The acknowledgment gate binds what a preview SHOWED;
 * with nothing shown there is nothing to bind, and the fail-safe answer on a
 * destructive seam is a fresh preview — never a blind apply.
 */
function refusePreviewRequired(threadId: string, messageId: string): AssistantRewindRefused {
  return {
    conflicts: [],
    message: `no rewind preview is recorded for message "${messageId}" in thread "${threadId}"; nothing was applied. Open the rewind preview and confirm from there.`,
    ok: false,
    reason: 'preview-required',
  };
}

/**
 * `insertTombstoneBatch`'s `ON CONFLICT DO NOTHING` (rewind-repository.ts)
 * returned zero rows: every message this rewind would hide is already
 * tombstoned by an earlier, still-outstanding batch. Proceeding to restore
 * files under a fresh `revertId` here would leave that restore owned by a
 * `rewindId` with no sidecar tombstone row — `redoRewind`'s `listTombstoneBatch`
 * probe would find nothing and return `rewind-not-found`, so the restore would
 * be permanently un-redoable the moment it landed. Refused before a single
 * file is touched instead.
 */
function refuseAlreadyTombstoned(threadId: string): AssistantRewindRefused {
  return {
    conflicts: [],
    message: `every message this rewind would hide in thread "${threadId}" is already tombstoned by an earlier, still-outstanding rewind; nothing was applied. Redo or finalize that rewind before rewinding this range again.`,
    ok: false,
    reason: 'already-tombstoned',
  };
}

/**
 * The redo could not restore every file (a path failed or conflicted during
 * the actual restore, or a covered root is no longer connected). Unlike
 * apply, redo's whole point is un-tombstoning messages IN STEP with restoring
 * their files, so a partial file failure must not delete the tombstone batch:
 * doing so would un-hide the messages while leaving some files un-restored,
 * with no batch left to retry against. The batch stays; the caller can retry
 * once the named files stop conflicting (already-restored paths diff empty on
 * the retry and are idempotent no-ops).
 */
function refuseRedoIncomplete(
  rewindId: string,
  failed: readonly AssistantRewindFileOutcome[],
  disconnected: readonly DisconnectedRewindRoot[]
): AssistantRewindRefused {
  const parts = [
    ...failed.map((outcome) => outcomeSummary(outcome)),
    ...disconnected.map(
      (root) => `workspace folder "${root.recordedRootPath}" is no longer connected`
    ),
  ];
  return {
    conflicts: [],
    message: `redo "${rewindId}" could not restore everything: ${parts.join('; ')}. The messages stay hidden and the batch was left in place; resolve the named paths and retry redo.`,
    ok: false,
    reason: 'redo-incomplete',
  };
}

/**
 * Apply a rewind.
 *
 * `mode` is REQUIRED and explicit (Amendment 1): there is no default that
 * silently reverts files. `conversation-only` writes the tombstone batch with
 * `revert_id = NULL`, touches no file, takes no snapshot, and the
 * acknowledgment gate does not apply to it because nothing reaches disk.
 *
 * REFUSES OUTRIGHT WHILE A RUN IS IN FLIGHT (`run-in-flight`), in both modes
 * and before anything is scanned or written — see `applyRewindLocked`. Both
 * entry points reach this; only one of them has any renderer-side run state to
 * gate on, which is why the binding check lives here.
 *
 * Holds the thread lock for the same reason redo and finalization do: this is
 * the THIRD writer of the tombstone table, and a finalization landing between
 * this batch's insert and its file restores would leave a rewind whose files
 * are reverted but whose batch no longer exists to redo.
 */
export async function applyRewind(
  db: MainQueryHandle,
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

/** The files-mode restore body — split from {@link applyRewindLocked} to keep
 * each function under the lint complexity ceiling. Runs strictly AFTER the
 * gate refusals; see rule 1 in the module header for the order. */
async function applyFilesRestore(
  db: MainQueryHandle,
  args: {
    readonly conflicts: readonly AssistantRewindConflict[];
    readonly connected: readonly CoveredRewindRoot[];
    readonly disconnected: readonly DisconnectedRewindRoot[];
    readonly messageId: string;
    readonly mode: AssistantRewindMode;
    readonly range: AssistantRewindRange;
    readonly rewindId: string;
    readonly threadId: string;
    readonly tombstoneMessageIds: readonly string[];
  },
  deps: RewindServiceDeps
): Promise<AssistantRewindResult> {
  const revertId = crypto.randomUUID();
  const tombstoned = await insertTombstoneBatch(db, {
    messageIds: args.tombstoneMessageIds,
    revertId,
    rewindId: args.rewindId,
    threadId: args.threadId,
  });
  // Every target message was already tombstoned by an earlier, still-open
  // batch (`ON CONFLICT DO NOTHING` inserted nothing): refuse before touching
  // a single file rather than restoring under a `rewindId` no sidecar row
  // will ever back — see `refuseAlreadyTombstoned`.
  if (tombstoned.length === 0) {
    return refuseAlreadyTombstoned(args.threadId);
  }
  const results = await executeSnapshotRestore(deps, {
    reindex: deps.reindex,
    revertId,
    roots: args.connected,
    threadId: args.threadId,
  });
  await assertPreRevertPairing(deps, args.threadId, args.rewindId, revertId, results);
  clearPreviewFingerprint(args.threadId, args.messageId);
  return {
    fileOutcomes: results.flatMap((result) => result.fileOutcomes),
    mode: args.mode,
    ok: true,
    range: args.range,
    revertId,
    rewindId: args.rewindId,
    rootOutcomes: buildRootOutcomes(results, args.conflicts, args.disconnected),
    tombstonedMessageIds: tombstoned,
  };
}

async function applyRewindLocked(
  db: MainQueryHandle,
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

  if (range.kind !== 'runs') {
    // No runs after the message ⇒ an empty files restore. The batch still
    // carries a revertId (pre-swap behavior): the mode the user chose is
    // recorded, there is simply nothing to snapshot or restore.
    return await applyFilesRestore(
      db,
      {
        conflicts: [],
        connected: [],
        disconnected: [],
        messageId: args.messageId,
        mode: args.mode,
        range,
        rewindId,
        threadId: args.threadId,
        tombstoneMessageIds: target.tombstoneMessageIds,
      },
      deps
    );
  }

  const coverage = await resolveFilesCoverage(db, deps, args.threadId, range.fromRunId);
  if (coverage.kind !== 'covered') {
    // The two carried rulings: a pre-snapshot turn and a missing/failed
    // capture both refuse the FILES scope with the reason — the journal
    // restore engine is deleted, not a fallback, and "restore what we can"
    // is the forbidden shape.
    return { conflicts: [], message: coverage.message, ok: false, reason: coverage.kind };
  }
  const fingerprint = readPreviewFingerprint(args.threadId, args.messageId);
  const fingerprintCoversRoots =
    fingerprint !== null &&
    fingerprint.size === coverage.connected.length &&
    coverage.connected.every((root) => fingerprint.has(root.rootId));
  if (!(fingerprint && fingerprintCoversRoots)) {
    return refusePreviewRequired(args.threadId, args.messageId);
  }
  // THE GATE (rule 1). The drift scan runs BEFORE any snapshot is taken:
  // nothing above this line has written anything, and nothing below it runs
  // until every named path has been shown and acknowledged.
  const drift = await scanPreviewDrift(deps, coverage.connected, fingerprint);
  const conflicts = [...disconnectedRootConflicts(coverage.disconnected), ...drift];
  if (conflicts.length > 0 && args.acknowledgeConflicts !== true) {
    return refuseConflicts(conflicts);
  }
  return await applyFilesRestore(
    db,
    {
      conflicts,
      connected: coverage.connected,
      disconnected: coverage.disconnected,
      messageId: args.messageId,
      mode: args.mode,
      range,
      rewindId,
      threadId: args.threadId,
      tombstoneMessageIds: target.tombstoneMessageIds,
    },
    deps
  );
}

/**
 * Undo the newest rewind: restore the files it reverted (coupled mode) from
 * its recorded `pre-revert` snapshots and un-tombstone its batch.
 *
 * Redo is ONE LEVEL and only until finalization. Redoing anything other than
 * the thread's newest batch is refused rather than silently reordered — an
 * older batch's messages must stay hidden while a newer rewind still covers
 * them.
 *
 * The same acknowledgment gate applies: if restoring the files would conflict
 * (the user edited them after the rewind — a redo-plan path whose current
 * hash differs from the turn-start baseline the apply restored; see
 * `planSnapshotRedo`), the WHOLE redo refuses, including the un-tombstone. A
 * conversation that reappeared without its files would be a lie about what
 * was restored. That gate binds the PRE-SCAN; a path that still fails during
 * the actual restore (TOCTOU) refuses with `redo-incomplete` and leaves the
 * tombstone batch in place rather than deleting it out from under a partial
 * restore — see `refuseRedoIncomplete`.
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
  db: MainQueryHandle,
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
      const resolution = await resolveRedoRoots(
        db,
        deps,
        first.threadId,
        revertId,
        batch.map((row) => row.messageId)
      );
      if (resolution.kind !== 'ok') {
        // A files batch whose redo sources are missing (e.g. it predates the
        // snapshot engine). The batch STAYS — deleting it would un-hide the
        // messages over files that were never put back.
        return { conflicts: [], message: resolution.message, ok: false, reason: resolution.kind };
      }
      const plans = await planSnapshotRedo(deps, first.threadId, resolution.connected);
      const conflicts = [
        ...disconnectedRootConflicts(resolution.disconnected),
        ...plans.flatMap((plan) => plan.conflicts),
      ];
      if (conflicts.length > 0 && args.acknowledgeConflicts !== true) {
        return refuseConflicts(conflicts);
      }
      const results = await applySnapshotRedoPlans(deps, plans, deps.reindex);
      fileOutcomes = results.flatMap((result) => result.fileOutcomes);
      rootOutcomes = buildRootOutcomes(results, conflicts, resolution.disconnected);
      // A path that still failed during the actual restore (TOCTOU between
      // the phase-A scan and the write), or a disconnected root nothing could
      // restore into: deleting the tombstone batch below would un-hide the
      // messages while leaving that state un-restored and no batch left to
      // retry against — refuse instead and leave the batch in place.
      const failed = fileOutcomes.filter((outcome) => outcome.code !== 'reverted');
      if (failed.length > 0 || resolution.disconnected.length > 0) {
        return refuseRedoIncomplete(args.rewindId, failed, resolution.disconnected);
      }
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
  db: MainQueryHandle,
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
