/**
 * Snapshot-backed engine for the per-file / per-turn checkpoint undo surface
 * (BST-1164 T4 — the Option-A port ruling).
 *
 * The journal (`brainstrike_assistant_edit_checkpoints`) is an ATTRIBUTION
 * ledger: it names which paths a tool touched and their before/after sha256
 * hashes, but stores no content. Undo restores file state from the turn's
 * `turn-start` shadow-git snapshot instead — the same baseline Conversation
 * Rewind restores (`rewind-snapshot-engine.ts`), resolved with the same
 * turn vocabulary (`snapshot-turn-ledger.ts` brackets, the shared
 * `SnapshotTurnRegistry` for live resume legs, run-row timestamps for
 * historical resume legs).
 *
 * SEMANTIC CHANGE (deliberate, ruled 2026-08-05): undo restores a path to
 * its state at TURN START, not to just-before-that-specific-edit. For a turn
 * that edited the same file more than once the two differ; the UI copy says
 * "restore to turn start" for exactly this reason. A path the turn CREATED
 * is deleted (with empty-ancestor pruning bounded at the root), and a rename
 * is undone as restore-source + delete-destination — both fall out of
 * restoring the turn-start state of the two paths.
 *
 * CONFLICT GATE (posture unchanged from the journal engine): before touching
 * a path, its current on-disk sha256 is compared against the AFTER state of
 * the newest journal record for that path in the undo scope — a mismatch
 * means someone (user or a later turn) changed the file since the edit being
 * undone, and the undo refuses with `conflict` until forced. The residual
 * scan→restore race is the same one T3's rewind accepts and documents: the
 * snapshot-service root mutex serializes restores against snapshot captures,
 * but not against tool writes in flight.
 *
 * COVERAGE GATE (BST-1164 review; sits BEFORE the conflict gate and is never
 * bypassed by force): snapshot-absence is not evidence a path was
 * turn-created. `add -A` respects ignores, so an edit to a GITIGNORED file
 * (or one under the shadow `info/exclude` backstop) journals
 * `beforeExisted: true` while the turn-start snapshot never contains the
 * path; a wrong-case journal path on a case-insensitive filesystem
 * (`resolveWorkspaceWritePath` keeps the requested spelling) misses the
 * case-SENSITIVE git tree lookup the same way. Treating that absence as
 * "turn-created ⇒ delete" unlinked the only copy of the pre-edit content.
 * The rule now: deletion is permitted ONLY when the journal record says the
 * turn created the path (`beforeExisted === false` / `captureStatus ===
 * 'created'`; a rename's destination). Every path the record expects the
 * snapshot to contain is checked against the turn-start tree BEFORE any byte
 * moves (whole-record, so a rename can never delete its destination after
 * its source refused), the per-path intent is passed explicitly to
 * `restorePathsFromSnapshot` (whose `uncovered` refusal is the byte-moving
 * backstop for the same rule), and `listCheckpointUndoAvailability` reports
 * the same reason per entry — fail-safe unavailable.
 *
 * PATH SHAPE: journal rows record NORMALIZED workspace paths with a leading
 * slash (`/src/a.ts` — `resolveWorkspaceWritePath.workspacePath`), while the
 * shadow-git tree and the restore seam use root-relative paths (`src/a.ts`).
 * Every internal path in this module is the root-relative form via
 * {@link snapshotRelativePath} (shared from `snapshot-paths.ts` — the view's
 * attribution join needs the same translation); without it the seam's
 * absolute-path guard throws and the coverage gate would read every
 * production row as uncovered.
 *
 * UNAVAILABILITY IS DATA, NOT A CLICK-TIME SURPRISE: pre-engine entries
 * (turns with no snapshot rows) and failed-capture turns resolve to a typed
 * unavailable reason. `listCheckpointUndoAvailability` serves that per-entry
 * over IPC so the renderer renders a visibly disabled control with the
 * reason; the executors re-check and refuse with the same copy as a
 * belt-and-braces second line, never as the primary UX.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailability,
  AssistantCheckpointUndoAvailabilityMap,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { isRevertibleCaptureStatus } from '@brainstrike/assistant-contract';
import type { GitResult } from '@brainstrike/types';
import { readThreadRunAnchor, type SnapshotRunAnchor } from './changeset-snapshot-view';
import type { CheckpointRevertDeps } from './checkpoint-reindex-deps';
import {
  type EditCheckpointDatabase,
  listRunUndoRecords,
  listThreadCheckpoints,
  readCheckpointRecord,
  sha256Hex,
  stampCheckpointReverted,
} from './edit-checkpoint-journal';
import { reindexOutcome } from './rewind-snapshot-engine';
import { snapshotRelativePath } from './snapshot-paths';
import { isFailedSnapshotCaptureOid, type SnapshotRepository } from './snapshot-repository';
import type { ShadowRepoHandle, SnapshotService } from './snapshot-service';
import {
  findBracketByRunAnchor,
  findBracketByRunId,
  resolveSnapshotTurnBrackets,
  type SnapshotTurnBracket,
} from './snapshot-turn-ledger';
import { getSharedSnapshotTurnRegistry, type SnapshotTurnRegistry } from './snapshot-turn-registry';
import { loadWorkspaceRootsFromDatabase } from './workspace-roots';

/** The snapshot + reindex seams the undo engine consumes (threaded from
 * main.ts via the assistant-checkpoint IPC registration — the ONE
 * app-lifetime service, never a second construction). */
export interface CheckpointUndoDeps {
  /** Injectable for tests; defaults to {@link readThreadRunAnchor}. */
  readonly readRunAnchor?:
    | ((
        db: EditCheckpointDatabase,
        threadId: string,
        runId: string
      ) => Promise<GitResult<SnapshotRunAnchor | null>>)
    | undefined;
  /** Defaults to the process-shared registry the turn triggers write. */
  readonly registry?: SnapshotTurnRegistry | undefined;
  /** Same non-fatal reindex seam as rewind (`createCheckpointReindexDeps`). */
  readonly reindex: CheckpointRevertDeps['reindex'];
  readonly snapshotRepository: SnapshotRepository;
  readonly snapshotService: SnapshotService;
}

/** Reused "predates workspace snapshots" vocabulary (T3 carried ruling). */
export const CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON =
  'This edit predates workspace snapshots, so it cannot be restored.';

function captureFailedReason(rootId: string): string {
  return `The turn-start workspace snapshot for folder "${rootId}" failed to capture, so this edit cannot be restored.`;
}

function rootUncoveredReason(rootId: string): string {
  return `No turn-start workspace snapshot covers folder "${rootId}" for this turn, so this edit cannot be restored.`;
}

/** The COVERAGE GATE's reason (see the module doc comment). */
function pathUncoveredReason(paths: readonly string[]): string {
  const names = paths.map((candidate) => `"${candidate}"`).join(', ');
  const verb = paths.length === 1 ? 'is' : 'are';
  return `${names} ${verb} not covered by the turn-start snapshot — likely gitignored or a path-case mismatch — so this edit cannot be restored.`;
}

/**
 * Whether undoing `record` needs the turn-start snapshot to CONTAIN
 * `relativePath` (the COVERAGE GATE's per-path intent — the single source
 * both the whole-record pre-check and the seam's `expectAbsent` derive from,
 * so the two layers can never disagree). Snapshot-absence may only mean
 * "delete the live file" for a path the record says the turn created:
 * `beforeExisted === false` (⇔ `captureStatus === 'created'`), or a rename's
 * DESTINATION (its content survives via the restored source; the source
 * itself must be present or nothing may move).
 */
function requiresSnapshotPresence(
  record: AssistantEditCheckpointRecord,
  relativePath: string
): boolean {
  if (record.op === 'rename') {
    return record.fromPath !== null && relativePath === snapshotRelativePath(record.fromPath);
  }
  return record.beforeExisted;
}

type TurnStartResolution =
  | { readonly kind: 'ok'; readonly bracket: SnapshotTurnBracket }
  | { readonly kind: 'unavailable'; readonly reason: string };

interface ThreadSnapshotContext {
  readonly brackets: readonly SnapshotTurnBracket[];
  /** Bracket resolution memo per run id (batch availability + run undo). */
  readonly byRunId: Map<string, TurnStartResolution>;
  readonly hasRows: boolean;
}

async function loadThreadSnapshotContext(
  deps: CheckpointUndoDeps,
  threadId: string
): Promise<ThreadSnapshotContext> {
  const rows = await deps.snapshotRepository.snapshotsForThread(threadId);
  return {
    brackets: resolveSnapshotTurnBrackets(rows),
    byRunId: new Map(),
    hasRows: rows.length > 0,
  };
}

/**
 * The turn bracket covering `runId`, with the same three-step resolution the
 * changeset engine uses: ledger row run ids first, then the live registry
 * (a resume leg of the open turn appears on no snapshot row), then the run
 * row's own timestamps (historical resume legs — cold path only).
 */
async function resolveBracketForRun(
  db: EditCheckpointDatabase,
  deps: CheckpointUndoDeps,
  context: ThreadSnapshotContext,
  threadId: string,
  runId: string
): Promise<TurnStartResolution> {
  const memoized = context.byRunId.get(runId);
  if (memoized) {
    return memoized;
  }
  const resolution = await resolveBracketForRunUncached(db, deps, context, threadId, runId);
  context.byRunId.set(runId, resolution);
  return resolution;
}

async function resolveBracketForRunUncached(
  db: EditCheckpointDatabase,
  deps: CheckpointUndoDeps,
  context: ThreadSnapshotContext,
  threadId: string,
  runId: string
): Promise<TurnStartResolution> {
  if (!context.hasRows || context.brackets.length === 0) {
    return { kind: 'unavailable', reason: CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON };
  }
  const direct = findBracketByRunId(context.brackets, runId);
  if (direct) {
    return { bracket: direct, kind: 'ok' };
  }
  const registry = deps.registry ?? getSharedSnapshotTurnRegistry();
  const registryState = registry.get(threadId);
  if (registryState?.runIds.has(runId)) {
    const last = context.brackets.at(-1);
    if (last) {
      return { bracket: last, kind: 'ok' };
    }
  }
  const readRunAnchor = deps.readRunAnchor ?? readThreadRunAnchor;
  const anchorResult = await readRunAnchor(db, threadId, runId);
  if (!anchorResult.ok) {
    return { kind: 'unavailable', reason: anchorResult.error };
  }
  if (anchorResult.value === null) {
    return {
      kind: 'unavailable',
      reason: `run "${runId}" was not found in thread "${threadId}", so its turn boundary is unknown and this edit cannot be restored.`,
    };
  }
  const bracket = findBracketByRunAnchor(context.brackets, anchorResult.value);
  if (!bracket) {
    return { kind: 'unavailable', reason: CHECKPOINT_UNDO_PREDATES_SNAPSHOTS_REASON };
  }
  return { bracket, kind: 'ok' };
}

/** Per-root turn-start availability inside a resolved bracket. */
function turnStartForRoot(
  resolution: TurnStartResolution,
  rootId: string
):
  | { readonly kind: 'ok'; readonly oid: string }
  | { readonly kind: 'unavailable'; readonly reason: string } {
  if (resolution.kind === 'unavailable') {
    return resolution;
  }
  const row = resolution.bracket.startByRoot.get(rootId);
  if (!row) {
    return { kind: 'unavailable', reason: rootUncoveredReason(rootId) };
  }
  if (isFailedSnapshotCaptureOid(row.commitOid)) {
    return { kind: 'unavailable', reason: captureFailedReason(rootId) };
  }
  return { kind: 'ok', oid: row.commitOid };
}

/** The snapshot-presence paths `record`'s undo depends on (root-relative). */
function requiredSnapshotPathsOf(record: AssistantEditCheckpointRecord): readonly string[] {
  const expected = expectedStatesOf(record);
  if (expected.kind === 'invalid') {
    return [];
  }
  return [...expected.states.keys()].filter((candidate) =>
    requiresSnapshotPresence(record, candidate)
  );
}

/**
 * Per-record availability of the COVERAGE GATE's paths, fail-safe: a root
 * that is not connected or a snapshot tree that cannot be read reports
 * unavailable with the reason rather than guessing `restorable: true` for an
 * undo the executor would refuse (or worse, one that would have deleted an
 * uncovered file before the gate existed).
 */
async function coverageAvailability(
  deps: CheckpointUndoDeps,
  memo: {
    readonly rootPathsById: ReadonlyMap<string, string>;
    readonly turnStartTrees: Map<string, ReadonlyMap<string, string>>;
  },
  record: AssistantEditCheckpointRecord,
  turnStartOid: string
): Promise<AssistantCheckpointUndoAvailability> {
  const requiredPaths = requiredSnapshotPathsOf(record);
  if (requiredPaths.length === 0) {
    return { restorable: true };
  }
  const rootPath = memo.rootPathsById.get(record.rootId);
  if (rootPath === undefined) {
    return {
      reason: 'its workspace folder is no longer connected. Re-open the folder and try again.',
      restorable: false,
    };
  }
  let tree: ReadonlyMap<string, string>;
  try {
    const handle = await deps.snapshotService.ensureShadowRepo({
      path: rootPath,
      rootId: record.rootId,
    });
    tree = await turnStartTreeFor(deps, memo.turnStartTrees, handle, turnStartOid);
  } catch (error) {
    return {
      reason: `the turn-start workspace snapshot could not be read (${
        error instanceof Error ? error.message : String(error)
      }), so this edit cannot be restored.`,
      restorable: false,
    };
  }
  const uncovered = requiredPaths.filter((candidate) => !tree.has(candidate));
  if (uncovered.length > 0) {
    return { reason: pathUncoveredReason(uncovered), restorable: false };
  }
  return { restorable: true };
}

/**
 * Per-entry snapshot availability for a whole thread — the renderer's data
 * for disabled-with-reason undo controls (`assistant-checkpoint:availability`
 * IPC). Already-reverted entries are classified like any other: the renderer
 * gates on `revertedAt` first, and availability answers only "could the
 * snapshot engine restore this?". PER-PATH-AWARE for records whose undo
 * needs the snapshot to contain their paths (the COVERAGE GATE): an
 * uncovered path — gitignored or a path-case mismatch — reports the same
 * typed reason the executor refuses with, fail-safe unavailable.
 */
export async function listCheckpointUndoAvailability(
  db: EditCheckpointDatabase,
  deps: CheckpointUndoDeps,
  threadId: string
): Promise<AssistantCheckpointUndoAvailabilityMap> {
  const records = await listThreadCheckpoints(db, threadId);
  const byCheckpointId: Record<string, AssistantCheckpointUndoAvailability> = {};
  if (records.length === 0) {
    return { byCheckpointId };
  }
  const context = await loadThreadSnapshotContext(deps, threadId);
  const memo = {
    rootPathsById: await resolveConnectedRootPaths(db),
    turnStartTrees: new Map<string, ReadonlyMap<string, string>>(),
  };
  for (const record of records) {
    const resolution = await resolveBracketForRun(db, deps, context, threadId, record.runId);
    const rootState = turnStartForRoot(resolution, record.rootId);
    byCheckpointId[record.id] =
      rootState.kind === 'ok'
        ? await coverageAvailability(deps, memo, record, rootState.oid)
        : { reason: rootState.reason, restorable: false };
  }
  return { byCheckpointId };
}

/** On-disk existence + sha256 — the conflict gate's one observation shape. */
async function readDiskState(
  absolutePath: string
): Promise<{ existed: boolean; hash: string | null }> {
  try {
    const buffer = await fsPromises.readFile(absolutePath);
    return { existed: true, hash: sha256Hex(buffer) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { existed: false, hash: null };
    }
    throw error;
  }
}

/** Expected on-disk state of one path, per the newest journal record of that
 * path in the undo scope. `hash: null` with `existed: true` means the record
 * carries NO verifiable content identity (legacy rename rows from before the
 * capture site hashed destinations; a dangling-symlink destination) — the
 * conflict gate treats that as a conflict, never as existence-only
 * acceptance, because accepting an unverifiable content-bearing path would
 * let an unforced undo clobber post-edit user changes (W7 review P1). */
interface ExpectedDiskState {
  readonly existed: boolean;
  readonly hash: string | null;
}

type ExpectedStatesResolution =
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'paths'; readonly states: ReadonlyMap<string, ExpectedDiskState> };

/** The paths a record's undo touches (ROOT-RELATIVE — see the module doc
 * comment's PATH SHAPE note), keyed to their expected current state. */
function expectedStatesOf(record: AssistantEditCheckpointRecord): ExpectedStatesResolution {
  if (record.op === 'rename') {
    if (!record.fromPath) {
      return { error: 'the rename source path was not recorded.', kind: 'invalid' };
    }
    return {
      kind: 'paths',
      states: new Map<string, ExpectedDiskState>([
        // Destination exists after the rename; source is gone.
        [snapshotRelativePath(record.path), { existed: true, hash: record.afterHash }],
        [snapshotRelativePath(record.fromPath), { existed: false, hash: null }],
      ]),
    };
  }
  return {
    kind: 'paths',
    states: new Map<string, ExpectedDiskState>([
      [snapshotRelativePath(record.path), { existed: record.afterExisted, hash: record.afterHash }],
    ]),
  };
}

function diskMatches(
  current: { existed: boolean; hash: string | null },
  expected: ExpectedDiskState
): boolean {
  if (current.existed !== expected.existed) {
    return false;
  }
  if (!expected.existed) {
    // Both absent: nothing content-bearing to verify.
    return true;
  }
  if (expected.hash === null) {
    // A present path with no recorded content identity is NOT verifiable —
    // fail safe as a conflict (see {@link ExpectedDiskState}); `force`
    // remains the explicit override.
    return false;
  }
  return current.hash === expected.hash;
}

function failure(
  id: string,
  code: 'conflict' | 'not_found' | 'not_revertible',
  message: string
): AssistantCheckpointRevertResult {
  return { code, id, message, ok: false };
}

/** `handledPaths` key — (rootId, root-relative path). Keying by path ALONE
 * collapsed the same relative path across two mounted roots: the second
 * root's record found no pending paths and was stamped reverted WITHOUT
 * restoring its file — a silent cross-root skip the multi-root bar forbids
 * (W7 review P1). */
function handledPathKey(rootId: string, relativePath: string): string {
  return `${rootId}\0${relativePath}`;
}

interface UndoExecutionScope {
  readonly force: boolean;
  /** {@link handledPathKey} keys already restored to turn-start earlier in
   * this undo batch — per (rootId, path), never per bare path. */
  readonly handledPaths: Set<string>;
  readonly rootPathsById: ReadonlyMap<string, string>;
  /** Turn-start tree path→oid maps, memoized per `rootId\0oid` (the COVERAGE
   * GATE's lookup — one `ls-tree` per snapshot, not per record). */
  readonly turnStartTrees: Map<string, ReadonlyMap<string, string>>;
}

async function resolveConnectedRootPaths(
  db: EditCheckpointDatabase
): Promise<ReadonlyMap<string, string>> {
  const roots = await loadWorkspaceRootsFromDatabase(db);
  return new Map(roots.map((root) => [root.rootId, root.path]));
}

/** Memoized turn-start tree (path → blob oid) for the coverage gate. */
async function turnStartTreeFor(
  deps: CheckpointUndoDeps,
  memo: Map<string, ReadonlyMap<string, string>>,
  handle: ShadowRepoHandle,
  turnStartOid: string
): Promise<ReadonlyMap<string, string>> {
  const key = `${handle.rootId}\0${turnStartOid}`;
  const cached = memo.get(key);
  if (cached) {
    return cached;
  }
  const tree = await deps.snapshotService.snapshotFileHashes(handle, turnStartOid);
  memo.set(key, tree);
  return tree;
}

/**
 * Undo one journal record against a resolved turn-start snapshot. Restores
 * every not-yet-handled path of the record to its turn-start state, reindexes
 * the side effects, and stamps `reverted_at`. Paths another (newer) record in
 * the same batch already restored are skipped as already at turn-start — the
 * record is then stamped without touching disk (its edit was subsumed).
 *
 * Gate order: COVERAGE GATE first (whole-record, never bypassed by `force` —
 * an uncovered path can never restore, forced or not, and checking before
 * any byte moves keeps a multi-path rename atomic), then the conflict gate,
 * then the restore.
 */
async function undoRecordAgainstTurnStart(
  db: EditCheckpointDatabase,
  deps: CheckpointUndoDeps,
  record: AssistantEditCheckpointRecord,
  turnStartOid: string,
  scope: UndoExecutionScope
): Promise<AssistantCheckpointRevertResult> {
  const expected = expectedStatesOf(record);
  if (expected.kind === 'invalid') {
    return failure(record.id, 'not_revertible', expected.error);
  }
  const rootPath = scope.rootPathsById.get(record.rootId);
  if (rootPath === undefined) {
    return failure(
      record.id,
      'not_revertible',
      'its workspace folder is no longer connected. Re-open the folder and try again.'
    );
  }
  const pendingPaths = [...expected.states.keys()].filter(
    (candidate) => !scope.handledPaths.has(handledPathKey(record.rootId, candidate))
  );
  if (pendingPaths.length > 0) {
    const handle = await deps.snapshotService.ensureShadowRepo({
      path: rootPath,
      rootId: record.rootId,
    });
    const requiredPaths = pendingPaths.filter((candidate) =>
      requiresSnapshotPresence(record, candidate)
    );
    if (requiredPaths.length > 0) {
      const tree = await turnStartTreeFor(deps, scope.turnStartTrees, handle, turnStartOid);
      const uncovered = requiredPaths.filter((candidate) => !tree.has(candidate));
      if (uncovered.length > 0) {
        return failure(record.id, 'not_revertible', pathUncoveredReason(uncovered));
      }
    }
    if (!scope.force) {
      const conflicted = await findConflictedPath(rootPath, pendingPaths, expected.states);
      if (conflicted !== null) {
        return failure(
          record.id,
          'conflict',
          'the file changed since the checkpoint was recorded.'
        );
      }
    }
    const failedMessage = await restorePendingPaths(
      deps,
      record,
      handle,
      turnStartOid,
      pendingPaths,
      scope
    );
    if (failedMessage !== null) {
      return failure(record.id, 'not_revertible', failedMessage);
    }
  }
  const entry = await stampCheckpointReverted(db, record.id);
  if (!entry) {
    return failure(record.id, 'not_found', `edit checkpoint "${record.id}" was not found.`);
  }
  return { entry, ok: true };
}

/** First pending path whose on-disk state departs from its expectation. */
async function findConflictedPath(
  rootPath: string,
  pendingPaths: readonly string[],
  expectations: ReadonlyMap<string, ExpectedDiskState>
): Promise<string | null> {
  for (const pendingPath of pendingPaths) {
    const expectation = expectations.get(pendingPath);
    if (!expectation) {
      continue;
    }
    const current = await readDiskState(path.join(rootPath, pendingPath));
    if (!diskMatches(current, expectation)) {
      return pendingPath;
    }
  }
  return null;
}

/** Restore + reindex the pending paths; returns the first failure message.
 * Each path carries the record's explicit snapshot-absence intent (see
 * {@link requiresSnapshotPresence} — the seam's `uncovered` refusal is the
 * byte-moving backstop of the COVERAGE GATE the caller already ran). */
async function restorePendingPaths(
  deps: CheckpointUndoDeps,
  record: AssistantEditCheckpointRecord,
  handle: ShadowRepoHandle,
  turnStartOid: string,
  pendingPaths: readonly string[],
  scope: UndoExecutionScope
): Promise<string | null> {
  const outcomes = await deps.snapshotService.restorePathsFromSnapshot(
    handle,
    turnStartOid,
    pendingPaths.map((candidate) => ({
      expectAbsent: !requiresSnapshotPresence(record, candidate),
      path: candidate,
    }))
  );
  let failedMessage: string | null = null;
  for (const outcome of outcomes) {
    if (outcome.outcome === 'failed' || outcome.outcome === 'uncovered') {
      // First failure wins the message; the successes below still reindex —
      // their bytes already moved, and hiding that would corrupt the index.
      failedMessage = failedMessage ?? `"${outcome.path}": ${outcome.message}`;
      continue;
    }
    await reindexOutcome(deps.reindex, handle.rootPath, record.rootId, outcome);
    scope.handledPaths.add(handledPathKey(record.rootId, outcome.path));
  }
  return failedMessage;
}

/**
 * Undo ONE edit: restore its path(s) to the turn-start snapshot state.
 * Idempotent over `reverted_at`; refuses (typed, never thrown) on unknown
 * ids, non-revertible legacy captures, snapshot unavailability, disconnected
 * roots, and unforced conflicts.
 */
export async function undoCheckpointEntry(
  db: EditCheckpointDatabase,
  args: { readonly id: string; readonly force?: boolean },
  deps: CheckpointUndoDeps
): Promise<AssistantCheckpointRevertResult> {
  const record = await readCheckpointRecord(db, args.id);
  if (!record) {
    return failure(args.id, 'not_found', `edit checkpoint "${args.id}" was not found.`);
  }
  if (record.revertedAt !== null) {
    // Idempotent: a second undo of the same entry is a no-op success.
    return { entry: record, ok: true };
  }
  if (!isRevertibleCaptureStatus(record.captureStatus)) {
    return failure(
      record.id,
      'not_revertible',
      `capture status "${record.captureStatus}" has no restorable state.`
    );
  }
  const context = await loadThreadSnapshotContext(deps, record.threadId);
  const resolution = await resolveBracketForRun(db, deps, context, record.threadId, record.runId);
  const rootState = turnStartForRoot(resolution, record.rootId);
  if (rootState.kind === 'unavailable') {
    return failure(record.id, 'not_revertible', rootState.reason);
  }
  const scope: UndoExecutionScope = {
    force: args.force ?? false,
    handledPaths: new Set(),
    rootPathsById: await resolveConnectedRootPaths(db),
    turnStartTrees: new Map(),
  };
  return await undoRecordAgainstTurnStart(db, deps, record, rootState.oid, scope);
}

/**
 * Undo every non-reverted edit of one run, newest-first, restoring each
 * touched path to the run's turn-start state exactly once. Partial success
 * is honest: a per-entry conflict or refusal never aborts the rest, and the
 * conflict gate compares each path against its NEWEST record's after-state
 * (older records of an already-restored path stamp without re-touching disk).
 */
export async function undoCheckpointRun(
  db: EditCheckpointDatabase,
  args: { readonly runId: string; readonly force?: boolean },
  deps: CheckpointUndoDeps
): Promise<AssistantCheckpointRevertRunResult> {
  const records = await listRunUndoRecords(db, args.runId);
  const outcomes: AssistantCheckpointRevertResult[] = [];
  if (records.length === 0) {
    return { outcomes, runId: args.runId };
  }
  const threadId = records[0]?.threadId;
  if (threadId === undefined) {
    return { outcomes, runId: args.runId };
  }
  const context = await loadThreadSnapshotContext(deps, threadId);
  const scope: UndoExecutionScope = {
    force: args.force ?? false,
    handledPaths: new Set(),
    rootPathsById: await resolveConnectedRootPaths(db),
    turnStartTrees: new Map(),
  };
  for (const record of records) {
    if (!isRevertibleCaptureStatus(record.captureStatus)) {
      outcomes.push(
        failure(
          record.id,
          'not_revertible',
          `capture status "${record.captureStatus}" has no restorable state.`
        )
      );
      continue;
    }
    const resolution = await resolveBracketForRun(db, deps, context, threadId, record.runId);
    const rootState = turnStartForRoot(resolution, record.rootId);
    if (rootState.kind === 'unavailable') {
      outcomes.push(failure(record.id, 'not_revertible', rootState.reason));
      continue;
    }
    outcomes.push(await undoRecordAgainstTurnStart(db, deps, record, rootState.oid, scope));
  }
  return { outcomes, runId: args.runId };
}
