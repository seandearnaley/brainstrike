import { createHash } from 'node:crypto';
import type {
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';
import type { GitResult } from '@brainstrike/types';

/**
 * Per-turn edit checkpoint ATTRIBUTION ledger (BST-1164 T4): record, list, and
 * retention over the `brainstrike_assistant_edit_checkpoints` table. Module
 * functions over a minimal `{ query }` handle (mirrors `task-list-repository.ts`)
 * so it never depends on the concrete main-process DB client. Undo logic lives
 * in the sibling `checkpoint-snapshot-undo.ts` and restores from shadow-git
 * snapshots — this ledger stores WHO touched WHAT (op, paths, hashes,
 * timestamps), never file content.
 */

const TABLE = 'brainstrike_assistant_edit_checkpoints';

/**
 * Renderer-lazy bootstrap-only DDL (`assistant-memory-repository`), never a
 * numbered migration — see `docs/agents/assistant-persistence.md`. A fresh
 * profile that has never run the assistant will not have this table yet.
 */
const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/** Minimal query surface both the main-process handle and test doubles satisfy. */
export interface EditCheckpointDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

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
 * Insert one attribution row, then enforce per-thread row retention. The DTO
 * never carries content — the ledger stores none.
 */
export async function recordEditCheckpoint(
  db: EditCheckpointDatabase,
  input: EditCheckpointInput
): Promise<AssistantEditCheckpointRecord> {
  const id = crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const fromPath = input.op === 'rename' ? input.fromPath : null;
  // `before_content` is deliberately NOT in the column list (BST-1164 T4):
  // the schema column remains (no destructive migration in v1) but the
  // attribution ledger never populates it — restores come from workspace
  // snapshots, not stored bytes.
  const result = await db.query<CheckpointRecordRow>(
    `INSERT INTO ${TABLE} (
       id, run_id, resource_id, thread_id, tool_call_id, tool_name, op, root_id,
       path, from_path, before_existed, before_hash, before_size,
       after_hash, after_existed, capture_status, occurred_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, NOW(), NOW()
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

export interface RunRangeCheckpointsParams {
  readonly fromRunId: string;
  readonly threadId: string;
  readonly toRunId?: string;
}

/**
 * `id`/`started_at` shape read from the runs table to resolve a range anchor.
 * `startedAt` is read back with an explicit `::text` cast (never left to the
 * driver's `timestamptz`→`Date` coercion): PGlite/pg parse `timestamptz` into
 * a JS `Date`, which is millisecond-resolution and silently truncates the
 * sub-millisecond fraction Postgres actually stores. Feeding a truncated
 * `Date` back into the range query as a bound could then exclude the very
 * anchor row it came from — an honest range would look empty instead of
 * erroring. The `::text` cast preserves full microsecond precision, and the
 * range query below casts it straight back to `timestamptz` without ever
 * routing it through a `Date`.
 */
interface RunAnchorRow {
  id: string;
  startedAt: string;
}

/**
 * Resolve the journal entries for every run in `[fromRunId, toRunId]` of one
 * thread (`toRunId` omitted ⇒ open-ended to the latest run), and return them
 * oldest-first as a `GitResult`-style envelope.
 *
 * READ-ONLY: this never creates `brainstrike_assistant_thread_runs` and never
 * writes a run. MIGRATION 118 owns that table (BST-1651), and the runId
 * provenance invariant (`docs/agents/assistant-persistence.md`, settled)
 * forbids a second producer — `repository.createThreadRun` is the sole one.
 * There is deliberately NO absence handling: `getDatabase()` cannot resolve a
 * handle until `migrate()` has run (`db-main.ts`), so the only database that
 * lacks the relation is one that was never migrated, and that raises 42P01 as
 * itself rather than being softened into an envelope. The `runs-unavailable:`
 * probe this function used to open with described a renderer-lazy bootstrap
 * that no longer exists; it reported "no assistant run has been recorded on
 * this profile" for a relation every migrated profile now has.
 *
 * Range membership is a row-value comparison on `(started_at, id)`, never on
 * `id` alone: `id` is a UUID with no relationship to run order, so sorting or
 * bounding by it alone would produce an arbitrary membership set. Two runs
 * that started in the same millisecond are disambiguated deterministically by
 * the `id` tiebreak. This predicate does NOT match the leading column of
 * `brainstrike_assistant_thread_runs_thread_latest_idx`
 * (`resource_id, thread_id, started_at DESC, id DESC`) — this query has no
 * `resource_id` filter, so it is a sequential scan over the thread's runs,
 * not an index scan. State that honestly; do not claim index coverage
 * without checking the leading column.
 *
 * A range whose anchors both resolve but which simply has no journaled edits
 * — or, symmetrically, an INVERTED range (`toRunId` started before
 * `fromRunId`, so no run can satisfy both bounds) — is a legitimate, honest
 * empty view: `{ ok: true, value: [] }`, not an error. That is a deliberate
 * reading of the plan's "empty range ⇒ ok:true" rule, not an accident.
 * Only a MISSING anchor run (a `fromRunId`/`toRunId` that does not exist in
 * THIS thread — an id that belongs to a different thread counts as missing,
 * never a cross-thread leak) is an error, and since the `runs-unavailable:`
 * probe was retired it is the ONLY typed error this function produces. It is
 * prefixed `run-anchor-missing:` — one of the stable machine-readable markers
 * registered in `changeset-diff-service.ts` — and names which id and which
 * thread, so callers can tell "that run is gone" from an honest empty range
 * without parsing prose.
 */
export async function listRunRangeCheckpoints(
  db: EditCheckpointDatabase,
  params: RunRangeCheckpointsParams
): Promise<GitResult<AssistantEditCheckpointRecord[]>> {
  const anchorIds = Array.from(
    new Set(params.toRunId ? [params.fromRunId, params.toRunId] : [params.fromRunId])
  );
  const anchorRows = await db.query<RunAnchorRow>(
    `SELECT id AS "id", started_at::text AS "startedAt"
     FROM ${RUNS_TABLE}
     WHERE thread_id = $1 AND id = ANY($2)`,
    [params.threadId, anchorIds]
  );
  const anchorsById = new Map(anchorRows.rows.map((row) => [row.id, row]));

  const fromAnchor = anchorsById.get(params.fromRunId);
  if (!fromAnchor) {
    return {
      error: `run-anchor-missing: fromRunId "${params.fromRunId}" was not found in thread "${params.threadId}".`,
      ok: false,
    };
  }
  const toAnchor = params.toRunId ? anchorsById.get(params.toRunId) : undefined;
  if (params.toRunId && !toAnchor) {
    return {
      error: `run-anchor-missing: toRunId "${params.toRunId}" was not found in thread "${params.threadId}".`,
      ok: false,
    };
  }

  // Bounds are bound back in as TEXT and cast to timestamptz at the DB —
  // never through a JS `Date` — so the comparison sees the exact value
  // Postgres stored, including any sub-millisecond fraction (see
  // `RunAnchorRow`).
  const rangeSql = toAnchor
    ? `SELECT id AS "id" FROM ${RUNS_TABLE}
       WHERE thread_id = $1 AND (started_at, id) >= ($2::timestamptz, $3) AND (started_at, id) <= ($4::timestamptz, $5)`
    : `SELECT id AS "id" FROM ${RUNS_TABLE}
       WHERE thread_id = $1 AND (started_at, id) >= ($2::timestamptz, $3)`;
  const rangeParams = toAnchor
    ? [params.threadId, fromAnchor.startedAt, fromAnchor.id, toAnchor.startedAt, toAnchor.id]
    : [params.threadId, fromAnchor.startedAt, fromAnchor.id];
  const rangeResult = await db.query<{ id: string }>(rangeSql, rangeParams);
  const runIds = rangeResult.rows.map((row) => row.id);
  if (runIds.length === 0) {
    return { ok: true, value: [] };
  }

  const journalResult = await db.query<CheckpointRecordRow>(
    `SELECT ${SELECT_RECORD_COLUMNS} FROM ${TABLE}
     WHERE run_id = ANY($1)
     ORDER BY occurred_at ASC, id ASC`,
    [runIds]
  );
  return { ok: true, value: journalResult.rows.map(mapCheckpointRecordRow) };
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
 * id vanished (row-cap retention raced the undo).
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

/**
 * Bound per-thread ledger size: hard-delete the oldest rows beyond the row
 * cap. Runs inside the capture path after every insert. The content-era byte
 * budget (and its `expired` status transition) died with content capture
 * (BST-1164 T4) — attribution rows are small and uniform, so the row cap is
 * the whole policy.
 */
export async function pruneThreadCheckpoints(
  db: EditCheckpointDatabase,
  threadId: string
): Promise<void> {
  const maxRows = resolveCheckpointMaxRows();

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
