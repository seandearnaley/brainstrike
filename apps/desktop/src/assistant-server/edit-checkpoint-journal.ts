import { createHash } from 'node:crypto';
import type {
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';

/**
 * Per-turn edit checkpoint ATTRIBUTION ledger (BST-1164 T4): reads and the
 * reverted stamp over the `brainstrike_assistant_edit_checkpoints` table, for
 * the snapshot undo engine (`checkpoint-snapshot-undo.ts`). Nothing writes new
 * rows any more. Module functions over a minimal `{ query }` handle so it
 * never depends on the concrete main-process DB client. The ledger stores WHO
 * touched WHAT (op, paths, hashes, timestamps), never file content.
 */

const TABLE = 'brainstrike_assistant_edit_checkpoints';

/** Minimal query surface both the main-process handle and test doubles satisfy. */
export interface EditCheckpointDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

/** sha256 hex digest — the cheap integrity/conflict key for before/after bytes. */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Raw shape of a `SELECT_RECORD_COLUMNS` row. Columns are aliased to camelCase
 * in SQL (house style — avoids the snake_case naming-convention lint), but
 * `beforeSize`/timestamps still arrive as string|number and are normalized in
 * {@link mapCheckpointRecordRow}.
 */
interface CheckpointRecordRow {
  afterExisted: boolean;
  afterHash: string | null;
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

const SELECT_RECORD_COLUMNS = `id AS "id",
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
  before_size AS "beforeSize",
  after_existed AS "afterExisted",
  after_hash AS "afterHash",
  capture_status AS "captureStatus",
  reverted_at AS "revertedAt",
  occurred_at AS "occurredAt"`;

function toIso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapCheckpointRecordRow(row: CheckpointRecordRow): AssistantEditCheckpointRecord {
  return {
    afterExisted: row.afterExisted,
    afterHash: row.afterHash,
    beforeExisted: row.beforeExisted,
    beforeHash: row.beforeHash,
    beforeSize: toNullableNumber(row.beforeSize),
    captureStatus: row.captureStatus,
    fromPath: row.fromPath,
    id: row.id,
    occurredAt: toIso(row.occurredAt) ?? new Date(0).toISOString(),
    op: row.op,
    path: row.path,
    resourceId: row.resourceId,
    revertedAt: toIso(row.revertedAt),
    rootId: row.rootId,
    runId: row.runId,
    threadId: row.threadId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
  };
}

/**
 * All journal entries for a thread across ALL runs, oldest-first: the undo
 * availability read.
 */
export async function listThreadCheckpoints(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<AssistantEditCheckpointRecord[]> {
  const result = await db.query<CheckpointRecordRow>(
    `SELECT ${SELECT_RECORD_COLUMNS} FROM ${TABLE}
     WHERE thread_id = $1
     ORDER BY occurred_at ASC, id ASC`,
    [threadId]
  );
  return result.rows.map(mapCheckpointRecordRow);
}

/**
 * One journal record by id — the attribution DTO (never `before_content`;
 * that column is legacy-only since the T4 demotion). The snapshot undo
 * engine's row loader.
 */
export async function readCheckpointRecord(
  db: EditCheckpointDatabase,
  id: string
): Promise<AssistantEditCheckpointRecord | null> {
  const result = await db.query<CheckpointRecordRow>(
    `SELECT ${SELECT_RECORD_COLUMNS} FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? mapCheckpointRecordRow(row) : null;
}

/**
 * Every non-reverted journal record of one run, NEWEST-first (`occurred_at
 * DESC, id DESC`) — the turn-level undo's worklist. Newest-first is
 * load-bearing for the undo engine's per-path dedupe: the first record to
 * mention a path is the newest edit of that path in the run.
 */
export async function listRunUndoRecords(
  db: EditCheckpointDatabase,
  runId: string
): Promise<AssistantEditCheckpointRecord[]> {
  const result = await db.query<CheckpointRecordRow>(
    `SELECT ${SELECT_RECORD_COLUMNS} FROM ${TABLE}
     WHERE run_id = $1 AND reverted_at IS NULL
     ORDER BY occurred_at DESC, id DESC`,
    [runId]
  );
  return result.rows.map(mapCheckpointRecordRow);
}

/**
 * Stamp one record reverted (idempotent at the caller: an already-stamped row
 * just re-stamps). Returns the updated attribution record, or null when the
 * id vanished.
 */
export async function stampCheckpointReverted(
  db: EditCheckpointDatabase,
  id: string
): Promise<AssistantEditCheckpointRecord | null> {
  const result = await db.query<CheckpointRecordRow>(
    `UPDATE ${TABLE} SET reverted_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT_RECORD_COLUMNS}`,
    [id]
  );
  const row = result.rows[0];
  return row ? mapCheckpointRecordRow(row) : null;
}
