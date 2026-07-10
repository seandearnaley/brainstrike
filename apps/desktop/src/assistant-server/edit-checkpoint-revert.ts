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
import {
  ensureContainedDirectory,
  resolveWorkspaceLeafMutationPath,
  resolveWorkspaceWritePath,
  withTwoFileLocks,
  writeContainedFileBytes,
} from './assistant-tools';
import {
  CheckpointConflictError,
  CheckpointNotFoundError,
  CheckpointNotRevertibleError,
} from './edit-checkpoint-errors';
import {
  type EditCheckpointDatabase,
  mapCheckpointRecordRow,
  sha256Hex,
} from './edit-checkpoint-journal';
import { loadWorkspaceRootsFromDatabase } from './workspace-roots';

const TABLE = 'brainstrike_assistant_edit_checkpoints';

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

function assertNoConflict(id: string, force: boolean, matches: boolean, reason: string): void {
  if (!(force || matches)) {
    throw new CheckpointConflictError(id, reason);
  }
}

async function applyRestoreWrite(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps
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

async function applyDeleteCreated(
  row: CheckpointFullRow,
  rootPath: string,
  force: boolean,
  deps: CheckpointRevertDeps
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
    await fsPromises.unlink(mutationPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
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
  deps: CheckpointRevertDeps
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
  deps: CheckpointRevertDeps
): Promise<void> {
  if (!row.fromPath) {
    throw new CheckpointNotRevertibleError(row.id, 'the rename source path was not recorded.');
  }
  const fromResolved = await resolveWorkspaceWritePath(rootPath, row.fromPath);
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
 */
export async function revertCheckpointEntry(
  db: EditCheckpointDatabase,
  args: { id: string; force?: boolean },
  deps: CheckpointRevertDeps
): Promise<AssistantCheckpointRevertResult> {
  const force = args.force ?? false;
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

    if (row.op === 'rename') {
      await applyRenameBack(row, rootPath, force, deps);
    } else if (row.op === 'write' && row.captureStatus === 'created') {
      await applyDeleteCreated(row, rootPath, force, deps);
    } else if (row.op === 'delete') {
      await applyRecreateDeleted(row, rootPath, force, deps);
    } else {
      await applyRestoreWrite(row, rootPath, force, deps);
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
    outcomes.push(await revertCheckpointEntry(db, { force: args.force, id }, deps));
  }
  return { outcomes, runId: args.runId };
}
