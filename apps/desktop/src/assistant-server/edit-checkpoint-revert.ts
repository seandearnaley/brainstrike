import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';
import { isRevertibleCaptureStatus, withFileLock } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import {
  ensureContainedDirectory,
  resolveWorkspaceWritePath,
  writeContainedFileBytes,
} from '../secure-file-write';
import { beforeStateToCapture, captureBeforeState } from './edit-checkpoint-capture';
import {
  CheckpointConflictError,
  CheckpointNotFoundError,
  CheckpointNotRevertibleError,
} from './edit-checkpoint-errors';
import {
  type EditCheckpointDatabase,
  mapCheckpointRecordRow,
  recordEditCheckpoint,
  sha256Hex,
} from './edit-checkpoint-journal';
import { MAX_WRITE_WORKSPACE_FILE_BYTES, withTwoFileLocks } from './file-mutation-tools';
import { isWithinRoot } from './workspace-path';
import { resolveWorkspaceLeafMutationPath } from './workspace-path-resolution';
import { loadWorkspaceRootsFromDatabase } from './workspace-roots';

const TABLE = 'brainstrike_assistant_edit_checkpoints';
const logger = createLogger('EditCheckpointRevert');

/**
 * Wrap the injected reindex seam so a throw is logged, NON-FATAL, and never
 * propagates: the disk mutation has already succeeded under the file lock, so a
 * reindex failure must not strand the file reverted-on-disk-but-unstamped (it
 * would then fail the `afterHash` conflict check on the next attempt, breaking
 * idempotency). Reindex is a best-effort background trigger — production wires it
 * to the SAME non-fatal seams the write tools use — so `reverted_at` is always
 * stamped once the inverse mutation lands. A stale index is self-healing; a lost
 * reverted_at stamp is not.
 */
function withNonFatalReindex(deps: CheckpointRevertDeps): CheckpointRevertDeps {
  return {
    reindex: async (action: CheckpointReindexAction): Promise<void> => {
      try {
        await deps.reindex(action);
      } catch (error) {
        logger.error('Checkpoint revert reindex failed (non-fatal; file already reverted)', {
          error: error instanceof Error ? error.message : String(error),
          kind: action.kind,
        });
      }
    },
  };
}

/**
 * Reindex actions the revert executor emits after mutating the filesystem. The
 * production wiring (IPC handler) maps these to the SAME non-fatal reindex seams
 * the write tools use (`triggerEditedFileReindex` / `triggerFileDeletionInvalidation`
 * / `triggerRenamedDestinationReindex`); tests inject a spy.
 */
export type CheckpointReindexAction =
  | {
      readonly kind: 'restore';
      readonly rootId: string;
      readonly workspacePath: string;
      readonly absolutePath: string;
      readonly content: string;
      readonly size: number;
    }
  | { readonly kind: 'delete'; readonly rootId: string; readonly workspacePath: string }
  | {
      readonly kind: 'rename';
      readonly rootId: string;
      readonly rootPath: string;
      readonly fromWorkspacePath: string;
      readonly toWorkspacePath: string;
      readonly toAbsolutePath: string;
    };

export interface CheckpointRevertDeps {
  readonly reindex: (action: CheckpointReindexAction) => Promise<void>;
}

interface CheckpointFullRow {
  afterExisted: boolean;
  afterHash: string | null;
  beforeContent: string | null;
  beforeExisted: boolean;
  beforeHash: string | null;
  beforeSize: number | string | null;
  captureStatus: AssistantEditCheckpointCaptureStatus;
  fromPath: string | null;
  id: string;
  occurredAt: string;
  op: AssistantEditCheckpointOp;
  path: string;
  resourceId: string;
  revertedAt: string | null;
  rootId: string;
  runId: string;
  threadId: string;
  toolCallId: string | null;
  toolName: string;
}

const SELECT_FULL_COLUMNS = `id AS "id",
  run_id AS "runId",
  resource_id AS "resourceId",
  thread_id AS "threadId",
  tool_call_id AS "toolCallId",
  tool_name AS "toolName",
  op AS "op",
  root_id AS "rootId",
  path AS "path",
  from_path AS "fromPath",
  before_existed AS "beforeExisted",
  before_hash AS "beforeHash",
  before_content AS "beforeContent",
  before_size AS "beforeSize",
  after_existed AS "afterExisted",
  after_hash AS "afterHash",
  capture_status AS "captureStatus",
  reverted_at AS "revertedAt",
  occurred_at AS "occurredAt"`;

function fullRowToRecord(row: CheckpointFullRow): AssistantEditCheckpointRecord {
  const size = row.beforeSize === null ? null : Number(row.beforeSize);
  return mapCheckpointRecordRow({
    afterExisted: row.afterExisted,
    afterHash: row.afterHash,
    beforeExisted: row.beforeExisted,
    beforeHash: row.beforeHash,
    beforeSize: Number.isFinite(size) ? size : null,
    captureStatus: row.captureStatus,
    fromPath: row.fromPath,
    id: row.id,
    occurredAt: row.occurredAt,
    op: row.op,
    path: row.path,
    resourceId: row.resourceId,
    revertedAt: row.revertedAt,
    rootId: row.rootId,
    runId: row.runId,
    threadId: row.threadId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
  });
}

async function loadCheckpointRow(
  db: EditCheckpointDatabase,
  id: string
): Promise<CheckpointFullRow | undefined> {
  const result = await db.query<CheckpointFullRow>(
    `SELECT ${SELECT_FULL_COLUMNS} FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

async function markReverted(
  db: EditCheckpointDatabase,
  id: string
): Promise<AssistantEditCheckpointRecord> {
  const result = await db.query<CheckpointFullRow>(
    `UPDATE ${TABLE} SET reverted_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT_FULL_COLUMNS}`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    throw new CheckpointNotFoundError(id);
  }
  return fullRowToRecord(row);
}

/**
 * REVERT-TIME AFTER-CAPTURE (BST-1115 PAIRING RULE, binding).
 *
 * A revert is itself a filesystem mutation, so it must be journaled like any
 * other or the state it destroyed becomes unrecoverable. When
 * `afterCapture` is supplied, every inverse mutation records a NEW journal row
 * — INSIDE the same file lock, BEFORE the write — whose before-state is the
 * bytes about to be overwritten. Reverting those rows in turn (which is exactly
 * what `revertCheckpointRun(revertId)` does, newest-first) restores the
 * pre-revert state: that is the whole mechanism behind rewind's redo.
 *
 * Because the capture happens inside the lock and before the mutation, a
 * capture failure ABORTS the write rather than leaving an unjournaled revert
 * behind. Redo over an unjournaled revert would be silent degradation, so this
 * ordering is load-bearing, not incidental.
 *
 * The per-turn checkpoint UI's own revert path passes no `afterCapture` and is
 * unchanged by this seam.
 */
export interface RevertAfterCapture {
  /** Journal `run_id` the capture rows are grouped under (rewind's revertId). */
  readonly revertId: string;
  readonly toolName: string;
}

interface RevertCaptureSpec {
  /** File whose PRE-mutation state is snapshotted into the new row. */
  readonly absolutePath: string;
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  readonly fromPath?: string;
  readonly op: AssistantEditCheckpointOp;
  /** Workspace path the capture row is keyed at (the inverse's TARGET). */
  readonly path: string;
}

type RevertCaptureFn = (spec: RevertCaptureSpec) => Promise<void>;

const NO_CAPTURE: RevertCaptureFn = async () => {
  // The per-turn revert path journals nothing; redo is a rewind-only feature.
};

function buildRevertCapture(
  db: EditCheckpointDatabase,
  row: CheckpointFullRow,
  afterCapture: RevertAfterCapture | undefined
): RevertCaptureFn {
  if (!afterCapture) {
    return NO_CAPTURE;
  }
  return async (spec: RevertCaptureSpec): Promise<void> => {
    const before =
      spec.op === 'rename'
        ? {
            beforeContent: null,
            beforeExisted: true,
            beforeHash: null,
            beforeSize: null,
            captureStatus: 'rename' as const,
          }
        : beforeStateToCapture(
            await captureBeforeState(spec.absolutePath, MAX_WRITE_WORKSPACE_FILE_BYTES)
          );
    await recordEditCheckpoint(db, {
      ...before,
      afterExisted: spec.afterExisted,
      afterHash: spec.afterHash,
      resourceId: row.resourceId,
      rootId: row.rootId,
      runId: afterCapture.revertId,
      threadId: row.threadId,
      toolName: afterCapture.toolName,
      ...(spec.op === 'rename'
        ? { fromPath: spec.fromPath ?? '', op: 'rename' as const, path: spec.path }
        : { op: spec.op, path: spec.path }),
    });
  };
}

/**
 * The ONE definition of "what does disk currently look like here" used by the
 * executor's per-entry conflict assertion. (Its former second consumer, the
 * rewind pre-flight scan, died with the journal rewind engine — BST-1164 W7
 * T3 restores from shadow-git snapshots instead; this module's remaining
 * consumers are T4's retirement scope.)
 */
export async function readDiskState(
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

function assertNoConflict(id: string, force: boolean, matches: boolean, reason: string): void {
  if (!(force || matches)) {
    throw new CheckpointConflictError(id, reason);
  }
}

async function applyRestoreWrite(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps,
  capture: RevertCaptureFn
): Promise<void> {
  if (row.beforeContent === null) {
    throw new CheckpointNotRevertibleError(row.id, 'its before-content is no longer stored.');
  }
  const resolved = await resolveWorkspaceWritePath(rootPath, row.path);
  const content = row.beforeContent;
  await withFileLock(resolved.absolutePath, async () => {
    const current = await readDiskState(resolved.absolutePath);
    assertNoConflict(
      row.id,
      force,
      current.existed === row.afterExisted && current.hash === row.afterHash,
      'the file changed since the checkpoint was recorded.'
    );
    const buffer = Buffer.from(content, 'utf8');
    await capture({
      absolutePath: resolved.absolutePath,
      afterExisted: true,
      afterHash: sha256Hex(buffer),
      op: 'write',
      path: row.path,
    });
    await writeContainedFileBytes({ buffer, requestedPath: row.path, resolved });
    await deps.reindex({
      absolutePath: resolved.absolutePath,
      content,
      kind: 'restore',
      rootId: row.rootId,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });
  });
}

/**
 * DIRECTORY PRUNE (BST-1115, rewind apply only).
 *
 * The journal records FILE ops only. A scaffolding turn that writes
 * `app/src/components/Button.tsx` journals ONE `created` file; the `app/`,
 * `app/src/` and `app/src/components/` directories that
 * `ensureContainedDirectory` made on the way are invisible to it. Unlinking the
 * file therefore used to leave the entire scaffolded tree standing after a
 * rewind — the folder structure of a project the user asked to un-create.
 *
 * So after unlinking a created file we walk UP from its parent, removing each
 * directory that is now EMPTY, and stop at the first directory `rmdir` refuses:
 * ENOTEMPTY (something the run did not create still lives there) or any other
 * error. The walk also stops unconditionally at the workspace root — the root
 * is the boundary, never a candidate, and nothing at or above it is ever
 * removed.
 *
 * KNOWN LIMITATION, accepted for W5: an intentionally-empty directory that
 * already existed on the created file's exact path is indistinguishable from
 * one the run scaffolded, and will be pruned. Journaling directory creation is
 * the real fix and is out of scope here.
 *
 * Failures are deliberately swallowed rather than raised: the file — the thing
 * the journal actually promised to revert — is already gone, and a leftover
 * directory must not turn a successful revert into a reported failure.
 */
async function pruneEmptyAncestorDirectories(
  canonicalRootPath: string,
  startDirectory: string
): Promise<void> {
  let current = startDirectory;
  // The root itself terminates the walk. `isWithinRoot` is TRUE for the root,
  // so this inequality — not the containment check — is the boundary stop.
  while (current !== canonicalRootPath && isWithinRoot(canonicalRootPath, current)) {
    try {
      await fsPromises.rmdir(current);
    } catch {
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function applyDeleteCreated(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps,
  capture: RevertCaptureFn,
  pruneEmptyDirectories: boolean
): Promise<void> {
  const resolved = await resolveWorkspaceWritePath(rootPath, row.path);
  const mutationPath = await resolveWorkspaceLeafMutationPath(
    resolved.canonicalRootPath,
    resolved.requestedAbsolutePath,
    row.path
  );
  await withFileLock(mutationPath, async () => {
    const current = await readDiskState(resolved.absolutePath);
    assertNoConflict(
      row.id,
      force,
      current.existed && current.hash === row.afterHash,
      'the created file changed since the checkpoint was recorded.'
    );
    await capture({
      absolutePath: resolved.absolutePath,
      afterExisted: false,
      afterHash: null,
      op: 'delete',
      path: row.path,
    });
    await fsPromises.unlink(mutationPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    if (pruneEmptyDirectories) {
      await pruneEmptyAncestorDirectories(
        resolved.canonicalRootPath,
        path.dirname(resolved.absolutePath)
      );
    }
    await deps.reindex({
      kind: 'delete',
      rootId: row.rootId,
      workspacePath: resolved.workspacePath,
    });
  });
}

async function applyRecreateDeleted(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps,
  capture: RevertCaptureFn
): Promise<void> {
  if (row.beforeContent === null) {
    throw new CheckpointNotRevertibleError(row.id, 'its before-content is no longer stored.');
  }
  const resolved = await resolveWorkspaceWritePath(rootPath, row.path);
  const content = row.beforeContent;
  await withFileLock(resolved.absolutePath, async () => {
    const current = await readDiskState(resolved.absolutePath);
    assertNoConflict(row.id, force, !current.existed, 'a file now exists at the deleted path.');
    const buffer = Buffer.from(content, 'utf8');
    await capture({
      absolutePath: resolved.absolutePath,
      afterExisted: true,
      afterHash: sha256Hex(buffer),
      op: 'write',
      path: row.path,
    });
    await writeContainedFileBytes({ buffer, requestedPath: row.path, resolved });
    await deps.reindex({
      absolutePath: resolved.absolutePath,
      content,
      kind: 'restore',
      rootId: row.rootId,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });
  });
}

async function applyRenameBack(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps,
  capture: RevertCaptureFn
): Promise<void> {
  const fromPath = row.fromPath;
  if (!fromPath) {
    throw new CheckpointNotRevertibleError(row.id, 'the rename source path was not recorded.');
  }
  const fromResolved = await resolveWorkspaceWritePath(rootPath, fromPath);
  const toResolved = await resolveWorkspaceWritePath(rootPath, row.path);
  const toMutationPath = await resolveWorkspaceLeafMutationPath(
    toResolved.canonicalRootPath,
    toResolved.requestedAbsolutePath,
    row.path
  );
  await withTwoFileLocks(toMutationPath, fromResolved.absolutePath, async () => {
    const [origin, target] = await Promise.all([
      readDiskState(toResolved.absolutePath),
      readDiskState(fromResolved.absolutePath),
    ]);
    assertNoConflict(
      row.id,
      force,
      origin.existed && !target.existed,
      'the renamed file or its original path changed since the checkpoint.'
    );
    await ensureContainedDirectory(
      fromResolved.canonicalRootPath,
      path.dirname(fromResolved.absolutePath)
    );
    // The inverse of `fromPath -> path` is `path -> fromPath`, so the capture
    // row's own identity is that inverse: keyed at `fromPath`, coming FROM
    // `path`. Reverting it re-applies the original rename.
    await capture({
      absolutePath: fromResolved.absolutePath,
      afterExisted: true,
      afterHash: null,
      fromPath: row.path,
      op: 'rename',
      path: fromPath,
    });
    await fsPromises.rename(toMutationPath, fromResolved.absolutePath);
    await deps.reindex({
      fromWorkspacePath: fromResolved.workspacePath,
      kind: 'rename',
      rootId: row.rootId,
      rootPath,
      toAbsolutePath: fromResolved.absolutePath,
      toWorkspacePath: toResolved.workspacePath,
    });
  });
}

/**
 * Revert one journal entry. Loads the row, refuses non-revertible / already-
 * reverted (idempotent) states, resolves the root, detects on-disk conflicts
 * (hash compare — `force` overrides), applies the per-op inverse under the file
 * lock, runs the matching reindex seam, and stamps `reverted_at`.
 *
 * `pruneEmptyDirectories` is OPT-IN and defaults to false — see
 * {@link pruneEmptyAncestorDirectories}. Rewind's apply path passes true; the
 * per-turn checkpoint revert and rewind's REDO both leave it off, redo because
 * it restores the PRE-rewind state, in which those directories existed.
 */
export async function revertCheckpointEntry(
  db: EditCheckpointDatabase,
  args: {
    id: string;
    force?: boolean;
    afterCapture?: RevertAfterCapture;
    pruneEmptyDirectories?: boolean;
  },
  deps: CheckpointRevertDeps
): Promise<AssistantCheckpointRevertResult> {
  const force = args.force ?? false;
  const pruneEmptyDirectories = args.pruneEmptyDirectories ?? false;
  const safeDeps = withNonFatalReindex(deps);
  try {
    const row = await loadCheckpointRow(db, args.id);
    if (!row) {
      throw new CheckpointNotFoundError(args.id);
    }
    if (row.revertedAt !== null) {
      // Idempotent: a second revert of the same entry is a no-op success.
      return { entry: fullRowToRecord(row), ok: true };
    }
    if (!isRevertibleCaptureStatus(row.captureStatus)) {
      throw new CheckpointNotRevertibleError(
        row.id,
        `capture status "${row.captureStatus}" has no restorable before-state.`
      );
    }
    const rootPath = await resolveRootPathForRow(db, row);
    const capture = buildRevertCapture(db, row, args.afterCapture);

    if (row.op === 'rename') {
      await applyRenameBack(row, rootPath, force, safeDeps, capture);
    } else if (row.op === 'write' && row.captureStatus === 'created') {
      await applyDeleteCreated(row, rootPath, force, safeDeps, capture, pruneEmptyDirectories);
    } else if (row.op === 'delete') {
      await applyRecreateDeleted(row, rootPath, force, safeDeps, capture);
    } else {
      await applyRestoreWrite(row, rootPath, force, safeDeps, capture);
    }

    const entry = await markReverted(db, row.id);
    return { entry, ok: true };
  } catch (error) {
    return errorToResult(args.id, error);
  }
}

async function resolveRootPathForRow(
  db: EditCheckpointDatabase,
  row: CheckpointFullRow
): Promise<string> {
  const roots = await loadWorkspaceRootsFromDatabase(db);
  const root = roots.find((candidate) => candidate.rootId === row.rootId);
  if (!root) {
    throw new CheckpointNotRevertibleError(
      row.id,
      'its workspace folder is no longer connected. Re-open the folder and try again.'
    );
  }
  return root.path;
}

function errorToResult(id: string, error: unknown): AssistantCheckpointRevertResult {
  if (
    error instanceof CheckpointConflictError ||
    error instanceof CheckpointNotRevertibleError ||
    error instanceof CheckpointNotFoundError
  ) {
    return { code: error.code, id, message: error.message, ok: false };
  }
  throw error;
}

/**
 * Revert every non-reverted entry for a run in reverse apply order
 * (`occurred_at DESC, id DESC`) so a multi-edit turn returns to its pre-turn
 * state. Partial success is honest: a per-entry conflict never aborts the rest.
 */
export async function revertCheckpointRun(
  db: EditCheckpointDatabase,
  args: { runId: string; force?: boolean },
  deps: CheckpointRevertDeps
): Promise<AssistantCheckpointRevertRunResult> {
  const idsResult = await db.query<{ id: string }>(
    `SELECT id FROM ${TABLE}
     WHERE run_id = $1 AND reverted_at IS NULL
     ORDER BY occurred_at DESC, id DESC`,
    [args.runId]
  );
  const outcomes: AssistantCheckpointRevertResult[] = [];
  for (const { id } of idsResult.rows) {
    outcomes.push(await revertCheckpointEntry(db, { force: args.force ?? false, id }, deps));
  }
  return { outcomes, runId: args.runId };
}
