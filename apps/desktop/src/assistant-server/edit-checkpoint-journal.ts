import { createHash } from 'node:crypto';
import type {
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';

/**
 * Per-turn edit checkpoint journal (undo of agent file edits): record, list, and
 * retention over the `brainstrike_assistant_edit_checkpoints` table. Module
 * functions over a minimal `{ query }` handle (mirrors `task-list-repository.ts`)
 * so it never depends on the concrete main-process DB client. Revert logic lives
 * in the sibling `edit-checkpoint-revert.ts`.
 */

const TABLE = 'brainstrike_assistant_edit_checkpoints';

/** Minimal query surface both the main-process handle and test doubles satisfy. */
export interface EditCheckpointDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export const DEFAULT_CHECKPOINT_THREAD_CONTENT_BUDGET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_THREAD_MAX_ROWS = 500;

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return;
  }
  return process.env[name];
}

/**
 * Strict, no-silent-fallback parse of a positive-integer retention override. A
 * PRESENT but malformed value THROWS (a typo must not silently coerce, per the
 * no-silent-fallbacks rule); an ABSENT value uses the documented default.
 */
function resolvePositiveInt(envName: string, defaultValue: number): number {
  const raw = readEnv(envName);
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

export function resolveCheckpointContentBudgetBytes(): number {
  return resolvePositiveInt(
    'BRAINSTRIKE_CHECKPOINT_CONTENT_BUDGET_BYTES',
    DEFAULT_CHECKPOINT_THREAD_CONTENT_BUDGET_BYTES
  );
}

export function resolveCheckpointMaxRows(): number {
  return resolvePositiveInt('BRAINSTRIKE_CHECKPOINT_MAX_ROWS', DEFAULT_CHECKPOINT_THREAD_MAX_ROWS);
}

/** sha256 hex digest — the cheap integrity/conflict key for before/after bytes. */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface EditCheckpointIdentity {
  readonly resourceId: string;
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
}

export interface EditCheckpointCapture {
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  /** Full before-bytes (capped); null for a create / binary / oversized / rename. */
  readonly beforeContent: string | null;
  readonly beforeExisted: boolean;
  readonly beforeHash: string | null;
  readonly beforeSize: number | null;
  readonly captureStatus: AssistantEditCheckpointCaptureStatus;
  /** Capture time; defaults to now. Explicit only for deterministic tests. */
  readonly occurredAt?: Date;
}

export type EditCheckpointInput = EditCheckpointIdentity &
  EditCheckpointCapture &
  (
    | { readonly op: Exclude<AssistantEditCheckpointOp, 'rename'>; readonly path: string }
    | { readonly op: 'rename'; readonly path: string; readonly fromPath: string }
  );

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
 * Insert one journal entry, then enforce per-thread retention. Returns the
 * persisted record (before-content omitted).
 */
export async function recordEditCheckpoint(
  db: EditCheckpointDatabase,
  input: EditCheckpointInput
): Promise<AssistantEditCheckpointRecord> {
  const id = crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const fromPath = input.op === 'rename' ? input.fromPath : null;
  const result = await db.query<CheckpointRecordRow>(
    `INSERT INTO ${TABLE} (
       id, run_id, resource_id, thread_id, tool_call_id, tool_name, op, root_id,
       path, from_path, before_existed, before_hash, before_content, before_size,
       after_hash, after_existed, capture_status, occurred_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, NOW(), NOW()
     )
     RETURNING ${SELECT_RECORD_COLUMNS}`,
    [
      id,
      input.runId,
      input.resourceId,
      input.threadId,
      input.toolCallId ?? null,
      input.toolName,
      input.op,
      input.rootId,
      input.path,
      fromPath,
      input.beforeExisted,
      input.beforeHash,
      input.beforeContent,
      input.beforeSize,
      input.afterHash,
      input.afterExisted,
      input.captureStatus,
      occurredAt.toISOString(),
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to record edit checkpoint: insert returned no row.');
  }
  await pruneThreadCheckpoints(db, input.threadId);
  return mapCheckpointRecordRow(row);
}

/**
 * All journal entries for a thread across ALL runs, oldest-first. Used by the
 * renderer repository so past turns' cards stay revertible after reload.
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
 * Bound per-thread disk use. First the byte budget: while stored before-content
 * exceeds the budget, NULL the OLDEST non-reverted entries' before_content and
 * mark them `expired` (visible but non-revertible). Then the row cap: hard-delete
 * the oldest rows beyond the cap. Runs inside the capture path after every insert.
 */
export async function pruneThreadCheckpoints(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<void> {
  const budgetBytes = resolveCheckpointContentBudgetBytes();
  const maxRows = resolveCheckpointMaxRows();

  const totalResult = await db.query<{ total: number | string }>(
    `SELECT COALESCE(SUM(COALESCE(before_size, 0)), 0)::bigint AS total
     FROM ${TABLE}
     WHERE thread_id = $1 AND before_content IS NOT NULL`,
    [threadId]
  );
  let total = Number(totalResult.rows[0]?.total ?? 0);
  if (total > budgetBytes) {
    const candidates = await db.query<{ id: string; size: number | string }>(
      `SELECT id, COALESCE(before_size, 0)::int AS size
       FROM ${TABLE}
       WHERE thread_id = $1 AND before_content IS NOT NULL AND reverted_at IS NULL
       ORDER BY occurred_at ASC, id ASC`,
      [threadId]
    );
    const toExpire: string[] = [];
    for (const candidate of candidates.rows) {
      if (total <= budgetBytes) {
        break;
      }
      toExpire.push(candidate.id);
      total -= Number(candidate.size);
    }
    if (toExpire.length > 0) {
      await db.query(
        `UPDATE ${TABLE}
         SET before_content = NULL, capture_status = 'expired', updated_at = NOW()
         WHERE id = ANY($1)`,
        [toExpire]
      );
    }
  }

  const countResult = await db.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM ${TABLE} WHERE thread_id = $1`,
    [threadId]
  );
  const count = Number(countResult.rows[0]?.count ?? 0);
  if (count > maxRows) {
    await db.query(
      `DELETE FROM ${TABLE}
       WHERE id IN (
         SELECT id FROM ${TABLE}
         WHERE thread_id = $1
         ORDER BY occurred_at ASC, id ASC
         LIMIT $2
       )`,
      [threadId, count - maxRows]
    );
  }
}
