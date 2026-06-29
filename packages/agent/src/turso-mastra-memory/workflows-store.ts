import { createLogger } from '@brainstrike/utils/logger';
import type {
  StorageListWorkflowRunsInput,
  UpdateWorkflowStateOptions,
  WorkflowRun,
  WorkflowRuns,
} from '@mastra/core/storage';
import { WorkflowsStorage } from '@mastra/core/storage';
import type { StepResult, WorkflowRunState } from '@mastra/core/workflows';
import { MASTRA_WORKFLOW_SCHEMA_SQL, MASTRA_WORKFLOW_TABLE } from './sql';
import type { TursoMastraQueryValue, TursoMastraSqlClient } from './types';

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

interface TursoWorkflowsStoreOptions {
  database: TursoMastraSqlClient;
}

const PENDING_MARKER_KEY = '__mastra_pending__';
const logger = createLogger('TursoWorkflowsStore');

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
  return JSON.parse(JSON.stringify(value)) as T;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toSqlDate(value: Date | string): string {
  return toDate(value).toISOString();
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

function safeWorkflowRunFromRow(row: WorkflowSnapshotRow): WorkflowRun | undefined {
  try {
    return workflowRunFromRow(row);
  } catch (error) {
    logger.warn('Skipping malformed Mastra workflow snapshot while listing workflow runs', {
      code: 'mastra_workflow_snapshot_list_skip_malformed',
      error: error instanceof Error ? error.message : String(error),
      runId: row.runId,
      workflowName: row.workflowName,
    });
    return;
  }
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
  values: TursoMastraQueryValue[],
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
  values.push(resolvedPage * perPage);
  return `${sql} LIMIT ? OFFSET ?`;
}

async function runTransaction<T>(
  database: TursoMastraSqlClient,
  operation: (tx: TursoMastraSqlClient) => Promise<T>
): Promise<T> {
  if (typeof database.transaction !== 'function') {
    throw new Error('Turso workflows store requires transaction support');
  }
  return database.transaction(operation);
}

async function selectWorkflowRun(
  database: TursoMastraSqlClient,
  workflowName: string,
  runId: string
): Promise<WorkflowSnapshotRow | undefined> {
  const result = await database.query<WorkflowSnapshotRow>(
    `SELECT workflow_name AS "workflowName", run_id AS "runId", "resourceId", snapshot, "createdAt", "updatedAt"
     FROM ${MASTRA_WORKFLOW_TABLE}
     WHERE workflow_name = ? AND run_id = ?`,
    [workflowName, runId]
  );
  return result.rows[0];
}

async function selectWorkflowRunByRunId(
  database: TursoMastraSqlClient,
  runId: string
): Promise<WorkflowSnapshotRow | undefined> {
  const result = await database.query<WorkflowSnapshotRow>(
    `SELECT workflow_name AS "workflowName", run_id AS "runId", "resourceId", snapshot, "createdAt", "updatedAt"
     FROM ${MASTRA_WORKFLOW_TABLE}
     WHERE run_id = ?
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
  database: TursoMastraSqlClient,
  workflowName: string,
  runId: string,
  snapshot: WorkflowRunState
): Promise<void> {
  await database.query(
    `UPDATE ${MASTRA_WORKFLOW_TABLE}
     SET snapshot = ?, "updatedAt" = ?
     WHERE workflow_name = ? AND run_id = ?`,
    [JSON.stringify(snapshot), toSqlDate(new Date()), workflowName, runId]
  );
}

export class TursoWorkflowsStore extends WorkflowsStorage {
  private readonly database: TursoMastraSqlClient;
  private initPromise: Promise<void> | null = null;

  constructor(options: TursoWorkflowsStoreOptions) {
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
    // Turso snapshots are read-modify-write state; require transaction callback
    // support so approval resumes cannot interleave stale snapshot updates.
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
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workflow_name, run_id) DO UPDATE SET
          "resourceId" = EXCLUDED."resourceId",
          snapshot = EXCLUDED.snapshot,
          "updatedAt" = EXCLUDED."updatedAt"`,
        [
          workflowName,
          runId,
          resourceId ?? null,
          JSON.stringify(snapshot),
          toSqlDate(createdAt ?? now),
          toSqlDate(updatedAt ?? now),
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
    const values: TursoMastraQueryValue[] = [];
    if (workflowName) {
      values.push(workflowName);
      where.push('workflow_name = ?');
    }
    if (fromDate) {
      values.push(toSqlDate(fromDate));
      where.push('"createdAt" >= ?');
    }
    if (toDateFilter) {
      values.push(toSqlDate(toDateFilter));
      where.push('"createdAt" <= ?');
    }
    if (resourceId) {
      values.push(resourceId);
      where.push('"resourceId" = ?');
    }
    if (status) {
      values.push(status);
      where.push("json_extract(snapshot, '$.status') = ?");
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
        const run = safeWorkflowRunFromRow(row);
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
      `DELETE FROM ${MASTRA_WORKFLOW_TABLE} WHERE workflow_name = ? AND run_id = ?`,
      [workflowName, runId]
    );
  }
}
