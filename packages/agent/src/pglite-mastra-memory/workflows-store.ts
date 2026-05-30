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

function parseWorkflowSnapshot(value: WorkflowRunState | string): WorkflowRunState {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isRecord(parsed)) {
    throw new Error('Stored Mastra workflow snapshot is not an object');
  }
  if (!isRecord(parsed['context'])) {
    throw new Error(`Snapshot not found for runId ${String(parsed['runId'] ?? 'unknown')}`);
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
  if (page === undefined || perPage === undefined || perPage === false) {
    return sql;
  }
  if (!Number.isSafeInteger(perPage) || perPage < 0) {
    throw new Error('perPage must be false or a non-negative safe integer');
  }
  values.push(perPage);
  const limitParam = `$${values.length}`;
  values.push(page * perPage);
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
    return typeof this.database.transaction === 'function';
  }

  async dangerouslyClearAll(): Promise<void> {
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

  async listWorkflowRuns({
    workflowName,
    fromDate,
    toDate,
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
    if (toDate) {
      values.push(toDate);
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
       ORDER BY "createdAt" DESC`,
      queryValues,
      page,
      perPage
    );
    const result = await this.database.query<WorkflowSnapshotRow>(sql, queryValues);

    return {
      runs: result.rows.map(workflowRunFromRow),
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
    if (!workflowName) {
      return null;
    }
    const row = await selectWorkflowRun(this.database, workflowName, runId);
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
