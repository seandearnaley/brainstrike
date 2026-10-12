/**
 * Snapshot-backed file engine for Conversation Rewind (BST-1164, W7 T3).
 *
 * This module is the FILE half of the rewind engine swap: everything that
 * touches the shadow-git snapshot backbone lives here, and everything about
 * tombstones/messages stays in `rewind-service.ts`, UNCHANGED. The former
 * edit-checkpoint journal plays no part (migration 147 dropped it).
 *
 * THE PREVIEW→APPLY STALENESS GATE (the conflict-detection design, explicit
 * by charter):
 *
 * Under the snapshot engine a files-mode apply restores the target turn's
 * `turn-start` snapshot over the live work-tree — it reverts EVERYTHING that
 * differs from that snapshot, including hand edits the user made after the
 * turn. Those hand edits are not "conflicts": the preview (turn-start
 * snapshot vs live work-tree) SHOWS them, so confirming the preview is
 * informed consent to revert them, and the pre-revert snapshot taken at
 * apply time makes even that reversible via redo.
 *
 * What the acknowledgment gate must therefore bind is the window BETWEEN the
 * acknowledged preview and the apply: content that changed after the preview
 * was shown is content the user never saw and never consented to overwrite.
 * The design:
 *
 *  1. `buildSnapshotPreview` fingerprints the live work-tree per root — the
 *     per-path blob-oid map from `SnapshotService.worktreeFileHashes` (same
 *     `add -A` staging and ignore semantics as a snapshot, no commit) — and
 *     `rewind-service` stores it keyed by `(threadId, messageId)` via
 *     `savePreviewFingerprint`.
 *  2. At apply time, BEFORE any snapshot is taken, `scanPreviewDrift`
 *     re-hashes the work-tree and reports every path whose oid (or
 *     presence) differs from the fingerprint as a `disk-changed` conflict.
 *     The whole apply is gated on that list exactly like the journal
 *     engine's gate: one drifted path blocks everything until
 *     `acknowledgeConflicts: true`.
 *  3. An apply with NO stored fingerprint (no preview, or a process restart
 *     since) refuses with `preview-required` — with nothing shown, there is
 *     nothing for the gate to bind, and the fail-safe answer is "open the
 *     preview again", never a blind apply. The store is bounded
 *     ({@link MAX_STORED_PREVIEW_FINGERPRINTS}, FIFO); an evicted entry
 *     degrades to the same visible `preview-required` refusal.
 *
 * The residual race — a write landing between the drift scan and the
 * pre-revert snapshot — is NOT silently lost: the pre-revert snapshot (taken
 * FIRST, before any restore, and recorded in the ledger under the rewind's
 * `revertId`) captures it, so redo restores it. That is strictly narrower
 * and strictly more recoverable than the journal engine's scan→write TOCTOU
 * window, and it is documented here rather than skipped.
 *
 * REDO CONSTRUCTION (explicit by charter): redo restores the `pre-revert`
 * snapshot. The plan is computed against a FRESH work-tree snapshot
 * (`computeRestorePlan(preRevertOid, freshOid)`) — the fresh commit is a
 * pure diff anchor, deliberately NOT recorded in the snapshot ledger (its
 * ref lineage keeps it alive until the thread is pruned). The conflict gate
 * stays meaningful by expecting the state the APPLY left behind: a redo
 * plan path whose current hash differs from the TURN-START snapshot's hash
 * was touched after the rewind applied, and is reported as a `disk-changed`
 * conflict. Passing the fresh snapshot's own hashes as the expectation
 * would compare the work-tree with itself and gate nothing. Acknowledged
 * conflicts are forced PER PATH by overriding the expectation with the
 * current hash for exactly the flagged paths — never a blanket force.
 */

import fsPromises from 'node:fs/promises';
import type {
  AssistantRewindConflict,
  AssistantRewindFileOutcome,
} from '@brainstrike/assistant-contract';
import { resolveWorkspaceWritePath } from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import type { ChangedFileEntry } from '@brainstrike/types';
import type { CheckpointReindexAction } from './checkpoint-reindex-deps';
import type { MainQueryHandle } from './main-query-handle';
import { resolveEarliestBatchTarget, resolveRewindRunRange } from './rewind-repository';
import {
  isFailedSnapshotCaptureOid,
  type SnapshotRepository,
  type WorkspaceSnapshotRow,
} from './snapshot-repository';
import type { PerFileOutcome, ShadowRepoHandle, SnapshotService } from './snapshot-service';
import { loadWorkspaceRootsFromDatabase } from './workspace-roots';

const logger = createLogger('RewindSnapshotEngine');

/** The snapshot seams the rewind engine consumes — threaded from main.ts via
 * `changes-ipc-handlers.ts`; the ONE app-lifetime service, never a second
 * construction. */
export interface RewindSnapshotDeps {
  readonly snapshotRepository: SnapshotRepository;
  readonly snapshotService: SnapshotService;
}

/** A workspace root the files scope can restore: connected now AND covered by
 * a `turn-start` snapshot of the target turn's anchor run. */
export interface CoveredRewindRoot {
  readonly label: string | null;
  readonly rootId: string;
  /** The CONNECTED root path (workspace_roots), not the recorded one — the
   * shadow repo is keyed by rootId and follows the root when it moves. */
  readonly rootPath: string;
  readonly turnStartOid: string;
}

/** A root with `turn-start` coverage whose workspace root is no longer
 * connected. Nothing in it can restore (there is no work-tree to restore
 * into), but it must stay VISIBLE: one gate conflict + one root outcome. */
export interface DisconnectedRewindRoot {
  /** The root path recorded when the snapshot was taken. */
  readonly recordedRootPath: string;
  readonly rootId: string;
  readonly turnStartOid: string;
}

export type RewindFilesCoverage =
  | {
      readonly connected: readonly CoveredRewindRoot[];
      readonly disconnected: readonly DisconnectedRewindRoot[];
      readonly kind: 'covered';
    }
  | { readonly kind: 'snapshot-missing'; readonly message: string }
  | { readonly kind: 'turn-predates-snapshots'; readonly message: string };

/** User-facing copy for the pre-snapshot-turn refusal (carried ruling (a)):
 * one literal, shared by the preview's `filesScope` state and the apply
 * refusal so the two can never disagree. */
const REWIND_TURN_PREDATES_SNAPSHOTS_MESSAGE =
  'This turn predates workspace snapshots, so its files cannot be restored. Only the conversation can be restored.';

function snapshotMissingMessage(detail: string): string {
  return `No workspace snapshot covers this turn (${detail}), so its files cannot be restored for this range. Only the conversation can be restored.`;
}

/**
 * SENTINEL GUARD (BST-1164 review): a failed turn-start capture is recorded as
 * a ledger row whose oid is the all-zero {@link isFailedSnapshotCaptureOid}
 * sentinel — a valid oid SHAPE naming no object. Every reader of the ledger
 * must map it to the typed capture-failed refusal (the carried ruling;
 * `changeset-snapshot-view.ts` does the same in `oidOfRow`) — handing it to
 * git instead surfaces as a raw "bad object" error where the contract promises
 * a `snapshot-missing` refusal with conversation-only still available.
 */
function failedCaptureMessage(rootIds: readonly string[]): string {
  const names = [...rootIds]
    .sort()
    .map((rootId) => `"${rootId}"`)
    .join(', ');
  return snapshotMissingMessage(
    `the turn-start snapshot capture failed for workspace folder(s) ${names} when it was attempted`
  );
}

/** Root ids whose turn-start row is the failed-capture sentinel. */
function failedCaptureRootIds(byRoot: ReadonlyMap<string, WorkspaceSnapshotRow>): string[] {
  return [...byRoot.entries()]
    .filter(([, row]) => isFailedSnapshotCaptureOid(row.commitOid))
    .map(([rootId]) => rootId);
}

/**
 * Earliest `turn-start` row per root for the anchor run. Earliest, not
 * latest: the first snapshot of the run IS the turn boundary; anything later
 * under the same run id would already include the turn's own writes.
 */
function turnStartRowsByRoot(
  rows: readonly WorkspaceSnapshotRow[],
  fromRunId: string
): ReadonlyMap<string, WorkspaceSnapshotRow> {
  const byRoot = new Map<string, WorkspaceSnapshotRow>();
  for (const row of rows) {
    if (row.kind === 'turn-start' && row.runId === fromRunId && !byRoot.has(row.rootId)) {
      byRoot.set(row.rootId, row);
    }
  }
  return byRoot;
}

/**
 * Resolve which roots the files scope can restore for the turn anchored at
 * `fromRunId` (the range's first run — the run the target message
 * triggered).
 *
 * The coverage rule is exact, per the carried rulings (NO SILENT FALLBACKS):
 * - The thread has NO snapshot rows at all → `turn-predates-snapshots`
 *   (conversation-only rewind stays available; the retired journal engine is
 *   never a fallback).
 * - The thread has rows but a CONNECTED root lacks a `turn-start` row for
 *   the anchor run → `snapshot-missing` for the WHOLE range (the turn's
 *   capture failed for that root, or the root joined the workspace after
 *   the turn — either way there is no baseline, and "restore what we can"
 *   is the forbidden shape).
 * - A root WITH coverage that is no longer connected is not a refusal: it
 *   surfaces as a gate conflict + a visible root outcome (see
 *   `disconnectedRootConflicts`) so the still-connected roots stay
 *   restorable, exactly like the journal engine treated it.
 */
export async function resolveFilesCoverage(
  db: MainQueryHandle,
  deps: RewindSnapshotDeps,
  threadId: string,
  fromRunId: string
): Promise<RewindFilesCoverage> {
  const rows = await deps.snapshotRepository.snapshotsForThread(threadId);
  if (rows.length === 0) {
    return { kind: 'turn-predates-snapshots', message: REWIND_TURN_PREDATES_SNAPSHOTS_MESSAGE };
  }
  const byRoot = turnStartRowsByRoot(rows, fromRunId);
  if (byRoot.size === 0) {
    return {
      kind: 'snapshot-missing',
      message: snapshotMissingMessage(
        `no turn-start snapshot was recorded for run "${fromRunId}" — its capture failed or the turn predates snapshot capture`
      ),
    };
  }
  // A recorded-but-FAILED capture (sentinel oid) is a refusal, never a
  // baseline: the sentinel names no git object, so "covered" with it would
  // throw a raw git error out of the preview instead of the typed refusal.
  const failedRoots = failedCaptureRootIds(byRoot);
  if (failedRoots.length > 0) {
    return { kind: 'snapshot-missing', message: failedCaptureMessage(failedRoots) };
  }
  const connectedRoots = await loadWorkspaceRootsFromDatabase(db);
  const uncovered = connectedRoots.filter((root) => !byRoot.has(root.rootId));
  if (uncovered.length > 0) {
    const names = uncovered
      .map((root) => `"${root.displayName ?? root.rootId}"`)
      .sort()
      .join(', ');
    return {
      kind: 'snapshot-missing',
      message: snapshotMissingMessage(
        `workspace folder(s) ${names} have no turn-start snapshot for run "${fromRunId}" — capture failed for them or they joined the workspace after this turn`
      ),
    };
  }
  const connectedById = new Map(connectedRoots.map((root) => [root.rootId, root]));
  const connected: CoveredRewindRoot[] = [];
  const disconnected: DisconnectedRewindRoot[] = [];
  for (const [rootId, row] of byRoot) {
    const live = connectedById.get(rootId);
    if (live) {
      connected.push({
        label: live.displayName ?? null,
        rootId,
        rootPath: live.path,
        turnStartOid: row.commitOid,
      });
    } else {
      disconnected.push({ recordedRootPath: row.rootPath, rootId, turnStartOid: row.commitOid });
    }
  }
  connected.sort((a, b) => a.rootId.localeCompare(b.rootId));
  disconnected.sort((a, b) => a.rootId.localeCompare(b.rootId));
  return { connected, disconnected, kind: 'covered' };
}

/** Synthetic conflict/outcome id for a path with no journal checkpoint —
 * the contract field predates the engine swap and is a stable opaque key. */
function snapshotConflictId(rootId: string, conflictPath: string): string {
  return `snapshot:${rootId}:${conflictPath}`;
}

/**
 * One VISIBLE gate conflict per disconnected-but-covered root. There is no
 * work-tree to diff, so the conflict is root-granular: the recorded root
 * path stands in for `path`, and acknowledging it lets the connected roots
 * proceed while this root reports an honest zero-restore outcome.
 */
export function disconnectedRootConflicts(
  disconnected: readonly DisconnectedRewindRoot[]
): readonly AssistantRewindConflict[] {
  return disconnected.map((root) => ({
    checkpointId: `snapshot-root:${root.rootId}`,
    code: 'root-unavailable',
    message: `workspace folder "${root.recordedRootPath}" is no longer connected; nothing in it can be restored. Re-open the folder and try again.`,
    path: root.recordedRootPath,
    rootId: root.rootId,
    rootLabel: null,
  }));
}

/** Per-root work-tree fingerprints, as recorded by a preview. */
export type PreviewFingerprint = ReadonlyMap<string, ReadonlyMap<string, string>>;

const FINGERPRINT_KEY_SEPARATOR = String.fromCharCode(0);
/** FIFO bound on stored preview fingerprints. A workspace-sized path→oid map
 * is cheap but not free; one preview is ever open at a time in practice, and
 * an evicted entry degrades to the visible `preview-required` refusal. */
const MAX_STORED_PREVIEW_FINGERPRINTS = 8;

const previewFingerprints = new Map<string, PreviewFingerprint>();

function fingerprintKey(threadId: string, messageId: string): string {
  return `${threadId}${FINGERPRINT_KEY_SEPARATOR}${messageId}`;
}

export function savePreviewFingerprint(
  threadId: string,
  messageId: string,
  fingerprint: PreviewFingerprint
): void {
  const key = fingerprintKey(threadId, messageId);
  previewFingerprints.delete(key);
  previewFingerprints.set(key, fingerprint);
  while (previewFingerprints.size > MAX_STORED_PREVIEW_FINGERPRINTS) {
    const oldest = previewFingerprints.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    previewFingerprints.delete(oldest);
  }
}

export function readPreviewFingerprint(
  threadId: string,
  messageId: string
): PreviewFingerprint | null {
  return previewFingerprints.get(fingerprintKey(threadId, messageId)) ?? null;
}

export function clearPreviewFingerprint(threadId: string, messageId: string): void {
  previewFingerprints.delete(fingerprintKey(threadId, messageId));
}

export interface SnapshotPreviewBuild {
  readonly files: readonly ChangedFileEntry[];
  readonly fingerprint: PreviewFingerprint;
  readonly totalAdditions: number | null;
  readonly totalDeletions: number | null;
}

/**
 * The preview's file list: per covered root, the structured diff of the
 * turn-start snapshot against the LIVE work-tree — what a files-mode apply
 * WOULD change — plus the work-tree fingerprint the staleness gate binds.
 *
 * The fingerprint and the diff stage the work-tree independently, so a write
 * landing between the two can make the fingerprint fractionally newer than
 * the rendered diff; that path would then read as drift at apply time and
 * refuse toward a fresh preview — the fail-safe direction.
 *
 * Totals follow the git-backed rule (`ChangesetView` contract): summed over
 * per-file counts, excluding `null` (binary) entries rather than coercing
 * them to zero.
 */
export async function buildSnapshotPreview(
  deps: RewindSnapshotDeps,
  roots: readonly CoveredRewindRoot[]
): Promise<SnapshotPreviewBuild> {
  const files: ChangedFileEntry[] = [];
  const fingerprint = new Map<string, ReadonlyMap<string, string>>();
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const root of roots) {
    const handle = await deps.snapshotService.ensureShadowRepo({
      path: root.rootPath,
      rootId: root.rootId,
    });
    fingerprint.set(root.rootId, await deps.snapshotService.worktreeFileHashes(handle));
    const diffs = await deps.snapshotService.diffRefs(handle, root.turnStartOid, {
      worktree: true,
    });
    for (const diff of diffs) {
      totalAdditions += diff.additions ?? 0;
      totalDeletions += diff.deletions ?? 0;
      files.push({
        additions: diff.additions,
        deletions: diff.deletions,
        path: diff.path,
        repositoryRoot: null,
        revertible: true,
        rootId: root.rootId,
        status: diff.status,
        worktreePath: null,
      });
    }
  }
  return { files, fingerprint, totalAdditions, totalDeletions };
}

/**
 * The staleness gate's scan: re-hash every covered root's work-tree and name
 * each path whose blob oid (or presence) differs from the preview
 * fingerprint. Missing per-root fingerprints are the CALLER's refusal
 * (`preview-required`) — this function requires one per root and throws on a
 * gap rather than quietly scanning fewer roots.
 */
export async function scanPreviewDrift(
  deps: RewindSnapshotDeps,
  roots: readonly CoveredRewindRoot[],
  fingerprint: PreviewFingerprint
): Promise<readonly AssistantRewindConflict[]> {
  const conflicts: AssistantRewindConflict[] = [];
  for (const root of roots) {
    const recorded = fingerprint.get(root.rootId);
    if (!recorded) {
      throw new Error(
        `rewind drift scan has no preview fingerprint for root "${root.rootId}" — the caller must refuse preview-required instead of scanning`
      );
    }
    const handle = await deps.snapshotService.ensureShadowRepo({
      path: root.rootPath,
      rootId: root.rootId,
    });
    const current = await deps.snapshotService.worktreeFileHashes(handle);
    const paths = new Set([...recorded.keys(), ...current.keys()]);
    for (const candidate of [...paths].sort()) {
      if (recorded.get(candidate) !== current.get(candidate)) {
        conflicts.push({
          checkpointId: snapshotConflictId(root.rootId, candidate),
          code: 'disk-changed',
          message: `"${candidate}" changed after the rewind preview was generated; the preview no longer shows what this restore would overwrite. Re-open the preview, or acknowledge to proceed.`,
          path: candidate,
          rootId: root.rootId,
          rootLabel: root.label,
        });
      }
    }
  }
  return conflicts;
}

function fileOutcomeFromPerFile(
  rootId: string,
  outcome: PerFileOutcome
): AssistantRewindFileOutcome {
  if (outcome.outcome === 'restored' || outcome.outcome === 'deleted') {
    return {
      checkpointId: snapshotConflictId(rootId, outcome.path),
      code: 'reverted',
      message: null,
      path: outcome.path,
      rootId,
    };
  }
  if (outcome.outcome === 'conflict') {
    return {
      checkpointId: snapshotConflictId(rootId, outcome.path),
      code: 'conflict',
      message: outcome.message,
      path: outcome.path,
      rootId,
    };
  }
  if (outcome.outcome === 'skipped-nested-repo') {
    return {
      checkpointId: snapshotConflictId(rootId, outcome.path),
      code: 'not_revertible',
      message: `"${outcome.path}" is a nested git repository; snapshots record it as a pointer and never restore or delete it.`,
      path: outcome.path,
      rootId,
    };
  }
  return {
    checkpointId: snapshotConflictId(rootId, outcome.path),
    code: 'not_revertible',
    message: outcome.message,
    path: outcome.path,
    rootId,
  };
}

/**
 * Feed the SAME reindex seam the journal engine fed (`CheckpointRevertDeps`
 * via `createCheckpointReindexDeps`), now from restore-plan outcomes: every
 * restored path re-indexes, every deleted path invalidates. Failures are
 * logged and NON-FATAL — the disk mutation already happened, and a stale
 * index is self-healing while a failed rewind report over a succeeded
 * restore is not.
 */
export async function reindexOutcome(
  reindex: (action: CheckpointReindexAction) => Promise<void>,
  rootPath: string,
  rootId: string,
  outcome: PerFileOutcome
): Promise<void> {
  try {
    if (outcome.outcome === 'deleted') {
      const resolved = await resolveWorkspaceWritePath(rootPath, outcome.path);
      await reindex({ kind: 'delete', rootId, workspacePath: resolved.workspacePath });
      return;
    }
    if (outcome.outcome !== 'restored') {
      return;
    }
    const resolved = await resolveWorkspaceWritePath(rootPath, outcome.path);
    const stats = await fsPromises.lstat(resolved.absolutePath);
    if (stats.isSymbolicLink()) {
      // The workspace index tracks file content; a restored symlink has none
      // of its own to index.
      return;
    }
    const buffer = await fsPromises.readFile(resolved.absolutePath);
    if (buffer.includes(0)) {
      // Binary restores have no text to index; the index never held content
      // rows for them and background reconciliation covers any staleness.
      return;
    }
    await reindex({
      absolutePath: resolved.absolutePath,
      content: buffer.toString('utf8'),
      kind: 'restore',
      rootId,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });
  } catch (error) {
    logger.error('Rewind restore reindex failed (non-fatal; file already restored)', {
      error: error instanceof Error ? error.message : String(error),
      path: outcome.path,
      rootId,
    });
  }
}

export interface SnapshotRestoreRootResult {
  readonly fileOutcomes: readonly AssistantRewindFileOutcome[];
  readonly planActionCount: number;
  /** True once this root's `pre-revert` ledger row was recorded — the redo
   * source. The pairing rule's scope: bytes only ever move AFTER this flips
   * true, so a root that failed while still false was never mutated and
   * rightly has no pre-revert row. `rewind-service` asserts the recorded row
   * count against the flagged count. */
  readonly preRevertRecorded: boolean;
  readonly root: CoveredRewindRoot;
}

interface SnapshotRestoreArgs {
  readonly reindex: (action: CheckpointReindexAction) => Promise<void>;
  readonly revertId: string;
  readonly roots: readonly CoveredRewindRoot[];
  readonly threadId: string;
}

/** The honest per-root outcome for a restore that THREW (W7 review P1):
 * named, `not_revertible`, and explicit about whether redo has a source. It
 * must reach the aggregated result — an escaping throw after the tombstone
 * batch committed left the messages hidden with no applied result and no
 * `rewindId` for the renderer's redo affordance. */
function rootRestoreFailureOutcome(
  root: CoveredRewindRoot,
  error: unknown,
  preRevertRecorded: boolean
): AssistantRewindFileOutcome {
  const reason = error instanceof Error ? error.message : String(error);
  const recovery = preRevertRecorded
    ? 'Its pre-revert snapshot was recorded, so redo can still undo any partial restore.'
    : 'No file in this folder was changed.';
  return {
    checkpointId: snapshotConflictId(root.rootId, root.rootPath),
    code: 'not_revertible',
    message: `the snapshot restore for workspace folder "${root.rootPath}" failed before completion: ${reason}. ${recovery}`,
    path: root.rootPath,
    rootId: root.rootId,
  };
}

/** One root's restore (steps 1–4 of {@link executeSnapshotRestore}); throws
 * are the CALLER's per-root containment. */
async function restoreOneRoot(
  deps: RewindSnapshotDeps,
  args: SnapshotRestoreArgs,
  root: CoveredRewindRoot,
  onPreRevertRecorded: () => void
): Promise<SnapshotRestoreRootResult> {
  const handle = await deps.snapshotService.ensureShadowRepo({
    path: root.rootPath,
    rootId: root.rootId,
  });
  const { commitOid: preRevertOid } = await deps.snapshotService.snapshot(handle, {
    kind: 'pre-revert',
    runId: args.revertId,
    threadId: args.threadId,
  });
  await deps.snapshotRepository.insertSnapshot({
    commitOid: preRevertOid,
    kind: 'pre-revert',
    rootId: root.rootId,
    rootPath: handle.rootPath,
    runId: args.revertId,
    threadId: args.threadId,
  });
  onPreRevertRecorded();
  const plan = await deps.snapshotService.computeRestorePlan(
    handle,
    root.turnStartOid,
    preRevertOid
  );
  const expected = await deps.snapshotService.snapshotFileHashes(handle, preRevertOid);
  const outcomes = await deps.snapshotService.applyRestorePlan(handle, plan, {
    expectedPreRevertHashes: expected,
  });
  for (const outcome of outcomes) {
    await reindexOutcome(args.reindex, handle.rootPath, root.rootId, outcome);
  }
  return {
    fileOutcomes: outcomes.map((outcome) => fileOutcomeFromPerFile(root.rootId, outcome)),
    planActionCount: plan.actions.length,
    preRevertRecorded: true,
    root,
  };
}

/**
 * Files-mode restore, per root, SEQUENTIAL (never Promise.all — ordering and
 * per-path honesty beat latency on a destructive seam). Per root:
 *
 *  1. `pre-revert` snapshot FIRST, recorded in the ledger under
 *     `runId = revertId` BEFORE any byte moves — the pairing rule satisfied
 *     by construction: the redo source exists before there is anything to
 *     redo, and `rewind-service` re-asserts the row count afterwards.
 *  2. `computeRestorePlan(turnStartOid, preRevertOid)` — what changed
 *     between the turn boundary and right now.
 *  3. `applyRestorePlan` with the pre-revert snapshot's own hashes as the
 *     expectation: everything matches by construction except a write racing
 *     in after step 1, which surfaces as a per-path `conflict` outcome (and
 *     is captured by the step-1 snapshot, so redo can restore it).
 *  4. Reindex side effects per outcome, same seam as before the swap.
 *
 * PER-ROOT CONTAINMENT (W7 review P1): a throw from any step — shadow-git
 * error, a root becoming unavailable mid-loop — is caught HERE and becomes
 * that root's honest `not_revertible` outcome; the remaining roots still
 * restore. It must never escape: the caller has already committed the
 * tombstone batch, so an escaping throw strands hidden messages with no
 * structured result, no `rewindId` for redo, and earlier roots already
 * restored behind an error message.
 */
export async function executeSnapshotRestore(
  deps: RewindSnapshotDeps,
  args: SnapshotRestoreArgs
): Promise<readonly SnapshotRestoreRootResult[]> {
  const results: SnapshotRestoreRootResult[] = [];
  for (const root of args.roots) {
    let preRevertRecorded = false;
    try {
      results.push(
        await restoreOneRoot(deps, args, root, () => {
          preRevertRecorded = true;
        })
      );
    } catch (error) {
      logger.error('Rewind snapshot restore failed for a root; recorded as a per-root outcome', {
        error: error instanceof Error ? error.message : String(error),
        preRevertRecorded,
        revertId: args.revertId,
        rootId: root.rootId,
        threadId: args.threadId,
      });
      results.push({
        fileOutcomes: [rootRestoreFailureOutcome(root, error, preRevertRecorded)],
        planActionCount: 0,
        preRevertRecorded,
        root,
      });
    }
  }
  return results;
}

/** One root's redo inputs: the recorded pre-revert snapshot plus the same
 * turn-start baseline the apply restored (the gate's expectation source). */
export interface RedoRoot {
  readonly label: string | null;
  readonly preRevertOid: string;
  readonly rootId: string;
  readonly rootPath: string;
  readonly turnStartOid: string;
}

export type RedoRootsResolution =
  | {
      readonly connected: readonly RedoRoot[];
      readonly disconnected: readonly DisconnectedRewindRoot[];
      readonly kind: 'ok';
    }
  | { readonly kind: 'snapshot-missing'; readonly message: string };

/**
 * Resolve everything a files-mode redo needs from durable state alone —
 * redo must survive a process restart, so nothing here reads the in-memory
 * fingerprint store:
 *
 *  1. The batch's `pre-revert` rows (`kind = 'pre-revert'`,
 *     `run_id = revertId` — the pairing `executeSnapshotRestore` recorded).
 *     None ⇒ `snapshot-missing`: a batch from before the snapshot engine
 *     has no redo source; the batch stays and the messages stay hidden.
 *  2. The rewind's ORIGINAL target — the batch's oldest message — and its
 *     run range, to re-derive the turn-start baseline the gate compares
 *     against (see `planSnapshotRedo`'s expectation rule).
 *  3. Current root connectivity: a pre-revert root that is no longer
 *     connected cannot restore and is returned separately for the caller's
 *     visible conflict + `redo-incomplete` honesty path.
 */
export async function resolveRedoRoots(
  db: MainQueryHandle,
  deps: RewindSnapshotDeps,
  threadId: string,
  revertId: string,
  batchMessageIds: readonly string[]
): Promise<RedoRootsResolution> {
  const rows = await deps.snapshotRepository.snapshotsForThread(threadId);
  const preRevertByRoot = new Map<string, WorkspaceSnapshotRow>();
  for (const row of rows) {
    if (row.kind === 'pre-revert' && row.runId === revertId && !preRevertByRoot.has(row.rootId)) {
      preRevertByRoot.set(row.rootId, row);
    }
  }
  if (preRevertByRoot.size === 0) {
    return {
      kind: 'snapshot-missing',
      message:
        'no pre-revert snapshots are recorded for this rewind (it may predate the snapshot engine); its files cannot be restored. The messages stay hidden and the batch was left in place.',
    };
  }
  const target = await resolveEarliestBatchTarget(db, threadId, batchMessageIds);
  if (!target) {
    return {
      kind: 'snapshot-missing',
      message:
        'the original target message of this rewind batch could not be resolved, so its turn boundary is unknown; its files cannot be restored. The batch was left in place.',
    };
  }
  const range = await resolveRewindRunRange(db, target);
  if (range.kind !== 'runs') {
    return {
      kind: 'snapshot-missing',
      message:
        'the run range of this rewind batch could not be re-derived, so its turn-start baseline is unknown; its files cannot be restored. The batch was left in place.',
    };
  }
  const turnStarts = turnStartRowsByRoot(rows, range.fromRunId);
  const connectedRoots = new Map(
    (await loadWorkspaceRootsFromDatabase(db)).map((root) => [root.rootId, root])
  );
  const connected: RedoRoot[] = [];
  const disconnected: DisconnectedRewindRoot[] = [];
  for (const [rootId, row] of preRevertByRoot) {
    const turnStart = turnStarts.get(rootId);
    if (!turnStart) {
      return {
        kind: 'snapshot-missing',
        message: `no turn-start snapshot for root "${rootId}" backs this rewind, so what it restored cannot be re-derived; its files cannot be restored. The batch was left in place.`,
      };
    }
    // Same sentinel guard as `resolveFilesCoverage`: a failed-capture row is a
    // typed refusal, never an oid the redo plan may hand to git.
    if (isFailedSnapshotCaptureOid(turnStart.commitOid)) {
      return {
        kind: 'snapshot-missing',
        message: `the turn-start snapshot capture for root "${rootId}" failed when it was attempted, so what this rewind restored cannot be re-derived; its files cannot be restored. The batch was left in place.`,
      };
    }
    const live = connectedRoots.get(rootId);
    if (live) {
      connected.push({
        label: live.displayName ?? null,
        preRevertOid: row.commitOid,
        rootId,
        rootPath: live.path,
        turnStartOid: turnStart.commitOid,
      });
    } else {
      disconnected.push({
        recordedRootPath: row.rootPath,
        rootId,
        turnStartOid: turnStart.commitOid,
      });
    }
  }
  connected.sort((a, b) => a.rootId.localeCompare(b.rootId));
  disconnected.sort((a, b) => a.rootId.localeCompare(b.rootId));
  return { connected, disconnected, kind: 'ok' };
}

export interface RedoRootPlan {
  readonly conflicts: readonly AssistantRewindConflict[];
  readonly currentHashes: ReadonlyMap<string, string>;
  readonly handle: ShadowRepoHandle;
  readonly plan: Awaited<ReturnType<SnapshotService['computeRestorePlan']>>;
  readonly root: RedoRoot;
  readonly turnStartHashes: ReadonlyMap<string, string>;
}

/**
 * Redo phase A — scan every root BEFORE anything applies, so the gate can
 * list every conflict in one pass (the acknowledgment-gate shape is frozen).
 * See the module doc comment for why the expectation is the TURN-START
 * hashes: a plan path whose current hash differs from what the apply left
 * behind was touched after the rewind, and that is the user work the gate
 * exists to name. The fresh snapshot is a diff anchor only — never recorded
 * in the ledger.
 */
export async function planSnapshotRedo(
  deps: RewindSnapshotDeps,
  threadId: string,
  roots: readonly RedoRoot[]
): Promise<readonly RedoRootPlan[]> {
  const plans: RedoRootPlan[] = [];
  for (const root of roots) {
    const handle = await deps.snapshotService.ensureShadowRepo({
      path: root.rootPath,
      rootId: root.rootId,
    });
    const { commitOid: freshOid } = await deps.snapshotService.snapshot(handle, {
      kind: 'pre-revert',
      threadId,
    });
    const currentHashes = await deps.snapshotService.snapshotFileHashes(handle, freshOid);
    const plan = await deps.snapshotService.computeRestorePlan(handle, root.preRevertOid, freshOid);
    const turnStartHashes = await deps.snapshotService.snapshotFileHashes(
      handle,
      root.turnStartOid
    );
    const conflicts: AssistantRewindConflict[] = [];
    for (const action of plan.actions) {
      if (action.kind === 'nested-repo') {
        continue;
      }
      if (currentHashes.get(action.path) !== turnStartHashes.get(action.path)) {
        conflicts.push({
          checkpointId: snapshotConflictId(root.rootId, action.path),
          code: 'disk-changed',
          message: `"${action.path}" changed after the rewind was applied; undoing the rewind would overwrite that change.`,
          path: action.path,
          rootId: root.rootId,
          rootLabel: root.label,
        });
      }
    }
    plans.push({ conflicts, currentHashes, handle, plan, root, turnStartHashes });
  }
  return plans;
}

/**
 * Redo phase B — apply each scanned plan sequentially. The expectation map
 * is the turn-start hashes with the ACKNOWLEDGED conflict paths overridden
 * to their current hashes: force is per-path and only for what the scan
 * flagged, mirroring the journal engine's per-record force. A path that
 * drifts between phase A and this apply matches neither expectation and
 * surfaces as a `conflict` outcome (the caller's `redo-incomplete` honesty
 * path).
 */
export async function applySnapshotRedoPlans(
  deps: RewindSnapshotDeps,
  plans: readonly RedoRootPlan[],
  reindex: (action: CheckpointReindexAction) => Promise<void>
): Promise<readonly SnapshotRestoreRootResult[]> {
  const results: SnapshotRestoreRootResult[] = [];
  for (const rootPlan of plans) {
    const expected = new Map(rootPlan.turnStartHashes);
    for (const conflict of rootPlan.conflicts) {
      const current = rootPlan.currentHashes.get(conflict.path);
      if (current === undefined) {
        expected.delete(conflict.path);
      } else {
        expected.set(conflict.path, current);
      }
    }
    const outcomes = await deps.snapshotService.applyRestorePlan(rootPlan.handle, rootPlan.plan, {
      expectedPreRevertHashes: expected,
    });
    for (const outcome of outcomes) {
      await reindexOutcome(reindex, rootPlan.handle.rootPath, rootPlan.root.rootId, outcome);
    }
    results.push({
      fileOutcomes: outcomes.map((outcome) =>
        fileOutcomeFromPerFile(rootPlan.root.rootId, outcome)
      ),
      planActionCount: rootPlan.plan.actions.length,
      // Redo RESTORES FROM the recorded pre-revert snapshot — the row's
      // existence is this plan's precondition (`resolveRedoRoots`), not
      // something redo records.
      preRevertRecorded: true,
      root: {
        label: rootPlan.root.label,
        rootId: rootPlan.root.rootId,
        rootPath: rootPlan.root.rootPath,
        turnStartOid: rootPlan.root.turnStartOid,
      },
    });
  }
  return results;
}
