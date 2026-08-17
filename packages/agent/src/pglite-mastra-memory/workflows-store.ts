import { createLogger } from '@brainstrike/logging';
import type {
  StorageListWorkflowRunsInput,
  UpdateWorkflowStateOptions,
  WorkflowRun,
  WorkflowRuns,
} from '@mastra/core/storage';
import { WorkflowsStorage } from '@mastra/core/storage';
import type { StepResult, WorkflowRunState } from '@mastra/core/workflows';
import { MASTRA_WORKFLOW_SCHEMA_SQL, MASTRA_WORKFLOW_TABLE } from './sql';
import type { PgliteDatabase, PgliteQueryValue } from './types';

type WorkflowStepResult = StepResult<unknown, unknown, unknown, unknown>;

interface WorkflowSnapshotRow {
  createdAt: Date | string;
  resourceId: string | null;
  runId: string;
  snapshot: WorkflowRunState | string;
  updatedAt: Date | string;
  workflowName: string;
  [key: string]: unknown;
}

interface CountRow {
  count: number | string;
  [key: string]: unknown;
}

interface PgliteWorkflowsStoreOptions {
  database: PgliteDatabase;
}

const PENDING_MARKER_KEY = '__mastra_pending__';
const logger = createLogger('PgliteWorkflowsStore');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPendingMarker(value: unknown): boolean {
  return isRecord(value) && value[PENDING_MARKER_KEY] === true;
}

function hasArrayOutput(value: unknown): value is { output: unknown[] } {
  return isRecord(value) && Array.isArray(value['output']);
}

function cloneJson<T>(value: T): T {
  // Prefer structuredClone (matches JSONB round-trip semantics for plain data).
  // Fall back to JSON for non-cloneable caller-supplied step results (functions, etc.).
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseWorkflowSnapshot(value: WorkflowRunState | string): WorkflowRunState {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isRecord(parsed)) {
    throw new Error('Stored Mastra workflow snapshot is not an object');
  }
  if (!isRecord(parsed['context'])) {
    throw new Error(
      `Stored Mastra workflow snapshot for runId ${String(parsed['runId'] ?? 'unknown')} is missing context`
    );
  }
  return cloneJson(parsed as unknown as WorkflowRunState);
}

function workflowRunFromRow(row: WorkflowSnapshotRow): WorkflowRun {
  return {
    createdAt: toDate(row.createdAt),
    runId: row.runId,
    snapshot: parseWorkflowSnapshot(row.snapshot),
    updatedAt: toDate(row.updatedAt),
    workflowName: row.workflowName,
    ...(row.resourceId === null ? {} : { resourceId: row.resourceId }),
  };
}

/**
 * Listing-only tolerance for a corrupt snapshot row (BST-558).
 *
 * NO SILENT FALLBACK: every targeted read (`loadWorkflowSnapshot`,
 * `getWorkflowRunById`, `updateWorkflowResults`) throws, because the malformed
 * row IS the answer the caller asked for — skipping it there would be a lie.
 *
 * Listing is deliberately different. `listWorkflowRuns` backs
 * `agent.listSuspendedRuns`, which is how pending tool approvals are
 * rediscovered after a restart or renderer reload. Throwing for the whole page
 * would let ONE corrupt row make EVERY pending approval undiscoverable — a
 * total outage traded for a partial one. So the intact rows are still served,
 * and the corruption is surfaced at ERROR severity with a stable diagnostic
 * code instead: per the DIAGNOSTIC EVENTS contract
 * (docs/agents/platform-contracts.md) error-severity records are eagerly
 * flushed into `brainstrike_diagnostic_events` (the Flight Recorder) and reach
 * the debug bundle, so the row cannot vanish unnoticed the way a batched warn
 * (which waits on the 2s/32-event window) could.
 *
 * The ERROR record is emitted once per corrupt row PER STORE INSTANCE, guarded
 * by `reportedMalformedRuns`. NOT once per process — review (BST-558) established
 * that `createPgliteMastraMemory` constructs a fresh `PgliteWorkflowsStore` on
 * every call (`memory-factory.ts:137`) and that desktop DELIBERATELY bypasses the
 * shared memory cache for run-scoped instances (`apps/desktop/src/assistant-server.ts:2652`),
 * so a new `Set` is created roughly once per assistant run. Within one store the
 * guard holds; across stores the same permanent corrupt row is re-reported.
 *
 * Closing that fully needs the registry to live in a process-lived owner rather
 * than the store — deliberately NOT done here, because it changes ownership of
 * state this PR does not otherwise touch. Tracked separately; do not describe the
 * current behaviour as a per-process guarantee.
 *
 * A corrupt row is PERMANENT in production
 * (`deleteWorkflowRunById` has no production caller), while this listing runs on
 * every renderer reload AND on every `readResumedApprovalToolCall` during tool
 * approval. Without the guard, each of those writes another eagerly flushed
 * `brainstrike_diagnostic_events` row for the same unfixable condition, bounded
 * only by retention purge. Repeats carry NO new information: the fingerprint is
 * `computeDiagnosticFingerprint(code, scope, message)` and is identical every
 * time. This is not a silent fallback — the condition IS reported, once, at
 * ERROR, and every suppressed repeat still emits a `debug` record.
 */
function safeWorkflowRunFromRow(
  row: WorkflowSnapshotRow,
  reportedMalformedRuns: Set<string>
): WorkflowRun | undefined {
  try {
    return workflowRunFromRow(row);
  } catch (error) {
    const details = {
      code: 'mastra_workflow_snapshot_malformed',
      error: error instanceof Error ? error.message : String(error),
      runId: row.runId,
      workflowName: row.workflowName,
    };
    const identity = `${row.workflowName}\u0000${row.runId}`;
    if (reportedMalformedRuns.has(identity)) {
      logger.debug('Malformed Mastra workflow snapshot excluded again (already reported)', details);
    } else {
      reportedMalformedRuns.add(identity);
      logger.error(
        'Malformed Mastra workflow snapshot excluded from workflow run listing',
        details
      );
    }
  }
  return;
}

function mergeStepResult(existingResult: unknown, result: WorkflowStepResult): WorkflowStepResult {
  if (!(hasArrayOutput(existingResult) && hasArrayOutput(result))) {
    return cloneJson(result);
  }

  const existingOutput = existingResult.output;
  const newOutput = result.output;
  const mergedOutput = [...existingOutput];
  for (let index = 0; index < Math.max(existingOutput.length, newOutput.length); index += 1) {
    if (index >= newOutput.length) {
      continue;
    }
    const newValue = newOutput[index];
    if (isPendingMarker(newValue)) {
      mergedOutput[index] = null;
      continue;
    }
    if (newValue !== null) {
      mergedOutput[index] = newValue;
    }
  }

  return {
    ...(isRecord(existingResult) ? existingResult : {}),
    ...(isRecord(result) ? result : {}),
    output: mergedOutput,
  } as WorkflowStepResult;
}

function appendLimit(
  sql: string,
  values: PgliteQueryValue[],
  page: number | undefined,
  perPage: number | false | undefined
): string {
  if (perPage === undefined || perPage === false) {
    return sql;
  }
  if (!Number.isSafeInteger(perPage) || perPage < 0) {
    throw new Error('perPage must be false or a non-negative safe integer');
  }
  const resolvedPage = page ?? 0;
  if (!Number.isSafeInteger(resolvedPage) || resolvedPage < 0) {
    throw new Error('page must be >= 0');
  }
  values.push(perPage);
  const limitParam = `$${values.length}`;
  values.push(resolvedPage * perPage);
  return `${sql} LIMIT ${limitParam} OFFSET $${values.length}`;
}

async function runTransaction<T>(
  database: PgliteDatabase,
  operation: (tx: PgliteDatabase) => Promise<T>
): Promise<T> {
  if (typeof database.transaction !== 'function') {
    throw new Error('PGlite workflows store requires transaction support');
  }
  return database.transaction(operation);
}

async function selectWorkflowRun(
  database: PgliteDatabase,
  workflowName: string,
  runId: string
): Promise<WorkflowSnapshotRow | undefined> {
  const result = await database.query<WorkflowSnapshotRow>(
    `SELECT workflow_name AS "workflowName", run_id AS "runId", "resourceId", snapshot, "createdAt", "updatedAt"
     FROM ${MASTRA_WORKFLOW_TABLE}
     WHERE workflow_name = $1 AND run_id = $2`,
    [workflowName, runId]
  );
  return result.rows[0];
}

async function selectWorkflowRunByRunId(
  database: PgliteDatabase,
  runId: string
): Promise<WorkflowSnapshotRow | undefined> {
  const result = await database.query<WorkflowSnapshotRow>(
    `SELECT workflow_name AS "workflowName", run_id AS "runId", "resourceId", snapshot, "createdAt", "updatedAt"
     FROM ${MASTRA_WORKFLOW_TABLE}
     WHERE run_id = $1
     ORDER BY workflow_name ASC
     LIMIT 2`,
    [runId]
  );
  if (result.rows.length > 1) {
    throw new Error(`workflowName is required when runId matches multiple workflows: ${runId}`);
  }
  return result.rows[0];
}

async function writeWorkflowSnapshot(
  database: PgliteDatabase,
  workflowName: string,
  runId: string,
  snapshot: WorkflowRunState
): Promise<void> {
  await database.query(
    `UPDATE ${MASTRA_WORKFLOW_TABLE}
     SET snapshot = $3::jsonb, "updatedAt" = $4
     WHERE workflow_name = $1 AND run_id = $2`,
    [workflowName, runId, JSON.stringify(snapshot), new Date()]
  );
}

export class PgliteWorkflowsStore extends WorkflowsStorage {
  private readonly database: PgliteDatabase;
  private initPromise: Promise<void> | null = null;
  /** Identity (`workflowName`, NUL, `runId` — NUL cannot occur in either, so
   * the pair cannot collide) of every corrupt row already reported at ERROR
   * severity by this store instance — see {@link safeWorkflowRunFromRow}. */
  private readonly reportedMalformedRuns = new Set<string>();

  constructor(options: PgliteWorkflowsStoreOptions) {
    super();
    this.database = options.database;
  }

  override async init(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.database
      .exec(MASTRA_WORKFLOW_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    await this.initPromise;
  }

  supportsConcurrentUpdates(): boolean {
    // PGlite runs in-process on a single connection, so transaction callbacks
    // serialize this store's read-modify-write workflow snapshot updates.
    // A pooled Postgres-backed implementation would need row locks here.
    return typeof this.database.transaction === 'function';
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.initialize();
    await this.database.exec(`DELETE FROM ${MASTRA_WORKFLOW_TABLE};`);
  }

  async persistWorkflowSnapshot({
    workflowName,
    runId,
    resourceId,
    snapshot,
    createdAt,
    updatedAt,
  }: {
    workflowName: string;
    runId: string;
    resourceId?: string;
    snapshot: WorkflowRunState;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<void> {
    await this.initialize();
    await runTransaction(this.database, async (tx) => {
      const now = new Date();
      await tx.query(
        `INSERT INTO ${MASTRA_WORKFLOW_TABLE}
          (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (workflow_name, run_id) DO UPDATE SET
          "resourceId" = EXCLUDED."resourceId",
          snapshot = EXCLUDED.snapshot,
          "updatedAt" = EXCLUDED."updatedAt"`,
        [
          workflowName,
          runId,
          resourceId ?? null,
          JSON.stringify(snapshot),
          createdAt ?? now,
          updatedAt ?? now,
        ]
      );
    });
  }

  async loadWorkflowSnapshot({
    workflowName,
    runId,
  }: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    await this.initialize();
    const row = await selectWorkflowRun(this.database, workflowName, runId);
    return row ? parseWorkflowSnapshot(row.snapshot) : null;
  }

  async updateWorkflowResults({
    workflowName,
    runId,
    stepId,
    result,
    requestContext,
  }: {
    workflowName: string;
    runId: string;
    stepId: string;
    result: WorkflowStepResult;
    requestContext: Record<string, unknown>;
  }): Promise<Record<string, WorkflowStepResult>> {
    await this.initialize();
    return runTransaction(this.database, async (tx) => {
      const row = await selectWorkflowRun(tx, workflowName, runId);
      if (!row) {
        throw new Error(
          `Cannot update workflow results before snapshot is persisted for workflow ${workflowName} run ${runId}`
        );
      }

      const snapshot = parseWorkflowSnapshot(row.snapshot);
      snapshot.context[stepId] = mergeStepResult(snapshot.context[stepId], result);
      snapshot.requestContext = {
        ...(snapshot.requestContext ?? {}),
        ...requestContext,
      };
      await writeWorkflowSnapshot(tx, workflowName, runId, snapshot);
      return cloneJson(snapshot.context) as Record<string, WorkflowStepResult>;
    });
  }

  async updateWorkflowState({
    workflowName,
    runId,
    opts,
  }: {
    workflowName: string;
    runId: string;
    opts: UpdateWorkflowStateOptions;
  }): Promise<WorkflowRunState | undefined> {
    await this.initialize();
    return runTransaction(this.database, async (tx) => {
      const row = await selectWorkflowRun(tx, workflowName, runId);
      if (!row) {
        return;
      }

      const snapshot = parseWorkflowSnapshot(row.snapshot);
      const nextSnapshot: WorkflowRunState = { ...snapshot, ...opts };
      await writeWorkflowSnapshot(tx, workflowName, runId, nextSnapshot);
      return nextSnapshot;
    });
  }

  /**
   * DO NOT RELITIGATE — `total` and `runs.length` are answers to DIFFERENT
   * questions and may legitimately disagree when a snapshot is corrupt:
   *
   * - `total` is AUTHORITATIVE for what matches the filter IN STORAGE. It is
   *   what makes page boundaries stable, so it must not shrink as rows are
   *   excluded page by page (an exclusion on page 3 cannot retroactively
   *   renumber pages 1-2).
   * - `runs` is what is SERVABLE. A corrupt row is genuinely unfetchable —
   *   `getWorkflowRunById` throws for it by design — so `runs.length <= total`
   *   is the invariant, and the shortfall is exactly the excluded corrupt rows.
   *
   * The alternative — excluding corrupt rows from the COUNT too — would require
   * a SQL predicate mirroring `parseWorkflowSnapshot`'s JS predicate, and any
   * drift between the two would silently miscount. No in-repo consumer reads
   * `total`: `agent.listSuspendedRuns` destructures `{ runs }` only. The
   * corruption signal is the ERROR diagnostic, not the arithmetic.
   */
  async listWorkflowRuns({
    workflowName,
    fromDate,
    toDate: toDateFilter,
    perPage,
    page,
    resourceId,
    status,
  }: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    await this.initialize();
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0)) {
      throw new Error('page must be >= 0');
    }

    const where: string[] = [];
    const values: PgliteQueryValue[] = [];
    if (workflowName) {
      values.push(workflowName);
      where.push(`workflow_name = $${values.length}`);
    }
    if (fromDate) {
      values.push(fromDate);
      where.push(`"createdAt" >= $${values.length}`);
    }
    if (toDateFilter) {
      values.push(toDateFilter);
      where.push(`"createdAt" <= $${values.length}`);
    }
    if (resourceId) {
      values.push(resourceId);
      where.push(`"resourceId" = $${values.length}`);
    }
    if (status) {
      values.push(status);
      where.push(`snapshot ->> 'status' = $${values.length}`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM ${MASTRA_WORKFLOW_TABLE} ${whereSql}`,
      values
    );
    const queryValues = [...values];
    const sql = appendLimit(
      `SELECT workflow_name AS "workflowName", run_id AS "runId", "resourceId", snapshot, "createdAt", "updatedAt"
       FROM ${MASTRA_WORKFLOW_TABLE}
       ${whereSql}
       ORDER BY "createdAt" DESC, run_id ASC, workflow_name ASC`,
      queryValues,
      page,
      perPage
    );
    const result = await this.database.query<WorkflowSnapshotRow>(sql, queryValues);

    return {
      runs: result.rows.flatMap((row) => {
        const run = safeWorkflowRunFromRow(row, this.reportedMalformedRuns);
        return run ? [run] : [];
      }),
      total: Number(countResult.rows[0]?.count ?? 0),
    };
  }

  async getWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    await this.initialize();
    const row = workflowName
      ? await selectWorkflowRun(this.database, workflowName, runId)
      : await selectWorkflowRunByRunId(this.database, runId);
    return row ? workflowRunFromRow(row) : null;
  }

  async deleteWorkflowRunById({
    runId,
    workflowName,
  }: {
    runId: string;
    workflowName: string;
  }): Promise<void> {
    await this.initialize();
    await this.database.query(
      `DELETE FROM ${MASTRA_WORKFLOW_TABLE} WHERE workflow_name = $1 AND run_id = $2`,
      [workflowName, runId]
    );
  }
}
