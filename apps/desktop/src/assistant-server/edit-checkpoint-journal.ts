import { createHash } from 'node:crypto';
import type {
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';
import type { GitResult } from '@brainstrike/types';

/**
 * Per-turn edit checkpoint journal (undo of agent file edits): record, list, and
 * retention over the `brainstrike_assistant_edit_checkpoints` table. Module
 * functions over a minimal `{ query }` handle (mirrors `task-list-repository.ts`)
 * so it never depends on the concrete main-process DB client. Revert logic lives
 * in the sibling `edit-checkpoint-revert.ts`.
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
 * All journal entries for a single run, oldest-first — scoped to `threadId`
 * (review finding, BST-1113): `changeset.threadId` is structurally required
 * and validated by `validateAgentRunChangeset`, but a wrong or stale
 * `threadId` paired with a real `runId` belonging to ANOTHER thread used to
 * be silently ignored here, resolving that OTHER thread's journal entries
 * (and, downstream, serving its stored `before_content` over
 * `changes:fileDiff`). `run_id`/`thread_id` are filtered TOGETHER in one
 * predicate, mirroring `listRunRangeCheckpoints`'s posture: a run id that
 * belongs to a different thread must never leak that thread's records.
 * Used by W3's changeset resolution for the `agent-run` changeset kind.
 */
export async function listRunCheckpoints(
  db: EditCheckpointDatabase,
  runId: string,
  threadId: string
): Promise<AssistantEditCheckpointRecord[]> {
  const result = await db.query<CheckpointRecordRow>(
    `SELECT ${SELECT_RECORD_COLUMNS} FROM ${TABLE}
     WHERE run_id = $1 AND thread_id = $2
     ORDER BY occurred_at ASC, id ASC`,
    [runId, threadId]
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
 * `to_regclass` PROBE for `brainstrike_assistant_thread_runs` — never a
 * try/catch on `undefined_table` (42P01). The house gotcha (see
 * `docs/agents/assistant-persistence.md`): catching 42P01 INSIDE a
 * transaction cannot tolerate absence, because the failed statement already
 * aborted the transaction — a subsequent COMMIT silently ROLLBACKs, which
 * would make an honest "table not there yet" indistinguishable from a
 * quietly-discarded read. `to_regclass` returns NULL for an absent relation
 * instead of raising, so the probe can never poison a transaction, and it
 * works identically whether or not this call happens to run inside one.
 * `RUNS_TABLE` is a fixed constant (never caller-supplied), so a stale name
 * can't masquerade as "absent" the way an interpolated user string could.
 * Deliberately UNQUALIFIED (no `public.` prefix): the bootstrap DDL that
 * creates this table resolves the name via `search_path`, same as every
 * other `to_regclass` probe in this codebase (`memory-store.ts`,
 * `063-index-consolidation.ts`) — a hardcoded `public.` schema prefix would
 * report "absent" for a table that exists under a different `search_path`.
 */
async function runsTableExists(db: EditCheckpointDatabase): Promise<boolean> {
  const probe = await db.query<{ present: boolean }>(
    `SELECT to_regclass('${RUNS_TABLE}') IS NOT NULL AS present`
  );
  return probe.rows[0]?.present === true;
}

/**
 * Resolve the journal entries for every run in `[fromRunId, toRunId]` of one
 * thread (`toRunId` omitted ⇒ open-ended to the latest run), and return them
 * oldest-first as a `GitResult`-style envelope.
 *
 * READ-ONLY: this never creates `brainstrike_assistant_thread_runs` and never
 * writes a run. That table is renderer-lazy bootstrap-only DDL, and the runId
 * provenance invariant (`docs/agents/assistant-persistence.md`, settled)
 * forbids a second producer — `repository.createThreadRun` is the sole one.
 * A fresh profile with no assistant use yet will not have the table; that is
 * reported as a visible `runs-unavailable` error, never silently bootstrapped
 * or coerced into an empty result.
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
 * never a cross-thread leak) is an error; it is prefixed `run-anchor-missing:`
 * (mirroring the `runs-unavailable:` prefix above) and names which id and
 * which thread, so callers can distinguish "no assistant history yet" from
 * "that run is gone" without parsing prose.
 */
export async function listRunRangeCheckpoints(
  db: EditCheckpointDatabase,
  params: RunRangeCheckpointsParams
): Promise<GitResult<AssistantEditCheckpointRecord[]>> {
  if (!(await runsTableExists(db))) {
    return {
      error: `runs-unavailable: "${RUNS_TABLE}" does not exist yet (no assistant run has been recorded on this profile).`,
      ok: false,
    };
  }

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

export interface CheckpointBeforeContent {
  readonly beforeContent: string | null;
  readonly beforeExisted: boolean;
}

/**
 * MAIN-ONLY, READ-ONLY full-row read of exactly ONE journal record's raw
 * `before_content` (+`before_existed`, needed to distinguish "legitimately no
 * before-state" from "before-state existed but was never captured/has
 * expired"). This is NOT the same claim as "these bytes never leave the main
 * process" — they DO, verbatim, as `StructuredFileDiff.content.oldContent`
 * over the `changes:fileDiff` IPC call once `changeset-journal-view.ts`
 * assembles the diff. What actually never crosses IPC is the LIST DTO: the
 * renderer-facing `AssistantEditCheckpointRecord` (returned by
 * `listRunCheckpoints`/`listRunRangeCheckpoints`, which back `changes:resolveView`)
 * deliberately OMITS `before_content` so a `ChangesetView` listing never rides
 * raw file bytes — only a per-file `fileDiff` call does, and only for the one
 * path requested. This helper is that per-file seam's ONLY caller.
 * `before_content` is also returned UNBOUNDED here, unlike the journal
 * `fileDiff`'s new (disk) side, which IS capped at
 * `STRUCTURED_DIFF_CONTENT_CAP_BYTES` — safe because capture-time already
 * refuses to store anything over `MAX_WRITE_WORKSPACE_FILE_BYTES`
 * (`captureBeforeState` in `edit-checkpoint-capture.ts` marks an oversized
 * before-state `skipped_too_large` and stores no content at all), so a
 * stored `before_content` is already guaranteed small; the `over-cap-old`/
 * `over-cap-both` `StructuredFileDiffContent` reasons are consequently
 * unreachable for a journal-sourced diff. SELECT only — no DDL, no writes,
 * ever.
 */
export async function readCheckpointBeforeContent(
  db: EditCheckpointDatabase,
  id: string
): Promise<GitResult<CheckpointBeforeContent>> {
  const result = await db.query<{ beforeContent: string | null; beforeExisted: boolean }>(
    `SELECT before_content AS "beforeContent", before_existed AS "beforeExisted"
     FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return {
      error: `edit checkpoint "${id}" was not found while reading its before-content.`,
      ok: false,
    };
  }
  return {
    ok: true,
    value: { beforeContent: row.beforeContent, beforeExisted: row.beforeExisted },
  };
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
