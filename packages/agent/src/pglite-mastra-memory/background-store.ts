import {
  MASTRA_BACKGROUND_TASKS_SCHEMA_SQL,
  MASTRA_BACKGROUND_TASKS_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { createLogger } from '@brainstrike/logging';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  TaskFilter,
  TaskListResult,
  UpdateBackgroundTask,
} from '@mastra/core/background-tasks';
import { BackgroundTasksStorage } from '@mastra/core/storage';
import { z } from 'zod';
import type { PgliteDatabase, PgliteQueryValue } from './types';

export const MAX_BACKGROUND_TASK_TIMEOUT_MS = 300_000;

export interface BackgroundTaskScope {
  readonly resourceId: string;
  readonly threadId: string;
}

function scopeCondition(
  scope: BackgroundTaskScope | undefined,
  values: PgliteQueryValue[]
): string {
  if (!scope) {
    return '';
  }
  values.push(scope.resourceId, scope.threadId);
  return ` AND resource_id = $${values.length - 1} AND thread_id = $${values.length}`;
}

const columns = {
  agentId: 'agent_id',
  args: 'args',
  completedAt: 'completedAt',
  createdAt: 'createdAt',
  error: 'error',
  id: 'id',
  maxRetries: 'max_retries',
  resourceId: 'resource_id',
  result: 'result',
  retryCount: 'retry_count',
  runId: 'run_id',
  startedAt: 'startedAt',
  status: 'status',
  suspendedAt: 'suspendedAt',
  suspendPayload: 'suspend_payload',
  threadId: 'thread_id',
  timeoutMs: 'timeout_ms',
  toolCallId: 'tool_call_id',
  toolName: 'tool_name',
} as const satisfies Record<keyof BackgroundTask, string>;
const jsonFields = new Set<keyof BackgroundTask>(['args', 'result', 'error', 'suspendPayload']);
const dateColumn = z.enum(['createdAt', 'startedAt', 'suspendedAt', 'completedAt']);
const status = z.enum([
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);
const taskSchema = z.object({
  agentId: z.string(),
  args: z.record(z.string(), z.unknown()),
  completedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  error: z.object({ message: z.string(), stack: z.string().optional() }).optional(),
  id: z.string(),
  maxRetries: z.number().int().nonnegative(),
  resourceId: z.string().optional(),
  result: z.unknown().optional(),
  retryCount: z.number().int().nonnegative(),
  runId: z.string(),
  startedAt: z.coerce.date().optional(),
  status,
  suspendedAt: z.coerce.date().optional(),
  suspendPayload: z.unknown().optional(),
  threadId: z.string().optional(),
  timeoutMs: z.number().nonnegative(),
  toolCallId: z.string(),
  toolName: z.string(),
});
const select = `${Object.entries(columns)
  .map(([field, column]) => `"${column}" AS "${field}"`)
  .join(
    ', '
  )}, result IS NOT NULL AS "resultPresent", suspend_payload IS NOT NULL AS "suspendPresent"`;
const mutableFields = [
  'status',
  'result',
  'error',
  'suspendPayload',
  'startedAt',
  'suspendedAt',
  'completedAt',
  'retryCount',
  'maxRetries',
  'timeoutMs',
] as const satisfies readonly (keyof UpdateBackgroundTask)[];

function readTask(row: Record<string, unknown>): BackgroundTask {
  const value = Object.fromEntries(
    Object.entries(row).filter(
      ([field, entry]) =>
        entry !== null ||
        (field === 'result' && row['resultPresent'] === true) ||
        (field === 'suspendPayload' && row['suspendPresent'] === true)
    )
  );
  const { threadId, resourceId, startedAt, suspendedAt, completedAt, error, ...task } =
    taskSchema.parse(value);
  return {
    ...task,
    ...(threadId === undefined ? {} : { threadId }),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(suspendedAt === undefined ? {} : { suspendedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined
      ? {}
      : {
          error: {
            message: error.message,
            ...(error.stack === undefined ? {} : { stack: error.stack }),
          },
        }),
  };
}
function sqlValue(key: keyof BackgroundTask, value: unknown): PgliteQueryValue {
  if (value === undefined) {
    return null;
  }
  if (jsonFields.has(key)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`Background task ${key} is not JSON serializable`);
    }
    return serialized;
  }
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  throw new Error(`Invalid background task ${key}`);
}
function filterQuery(
  filter: TaskFilter,
  scope?: BackgroundTaskScope
): { clause: string; values: PgliteQueryValue[]; order: string } {
  const values: PgliteQueryValue[] = [];
  const predicates: string[] = [];
  const add = (column: string, operator: string, value: PgliteQueryValue) => {
    values.push(value);
    predicates.push(`"${column}" ${operator} $${values.length}`);
  };
  for (const key of [
    'toolCallId',
    'agentId',
    'threadId',
    'resourceId',
    'toolName',
    'runId',
  ] as const) {
    if (filter[key] !== undefined) {
      add(columns[key], '=', filter[key]);
    }
  }
  if (filter.status !== undefined) {
    values.push(
      z.array(status).parse(Array.isArray(filter.status) ? filter.status : [filter.status])
    );
    predicates.push(`status = ANY($${values.length}::text[])`);
  }
  const date = dateColumn.parse(filter.dateFilterBy ?? 'createdAt');
  if (filter.fromDate) {
    add(date, '>=', filter.fromDate);
  }
  if (filter.toDate) {
    add(date, '<', filter.toDate);
  }
  const sort = dateColumn.parse(filter.orderBy ?? 'createdAt');
  const direction = z.enum(['asc', 'desc']).parse(filter.orderDirection ?? 'asc');
  return {
    clause: `WHERE ${predicates.length ? predicates.join(' AND ') : 'TRUE'}${scopeCondition(scope, values)}`,
    order: `ORDER BY "${sort}" ${direction} NULLS ${direction === 'asc' ? 'FIRST' : 'LAST'}, id ${direction}`,
    values,
  };
}
function pagination(filter: TaskFilter, values: PgliteQueryValue[]): string {
  if (filter.perPage === undefined) {
    return '';
  }
  const size = z.number().int().nonnegative().parse(filter.perPage);
  const page = z
    .number()
    .int()
    .nonnegative()
    .parse(filter.page ?? 0);
  values.push(size, size * page);
  return `LIMIT $${values.length - 1} OFFSET $${values.length}`;
}

const logger = createLogger('PgliteBackgroundTasksStore');

/** Native Mastra background-task domain, backed by the existing PGlite owner. */
export class PgliteBackgroundTasksStore extends BackgroundTasksStorage {
  constructor(
    private readonly database: PgliteDatabase,
    private readonly scope?: BackgroundTaskScope
  ) {
    super();
  }
  override async init(): Promise<void> {
    await this.database.exec(MASTRA_BACKGROUND_TASKS_SCHEMA_SQL);
  }
  override async createTask(task: BackgroundTask): Promise<void> {
    const valid = this.pinHostRetryPolicy(taskSchema.parse(task));
    this.assertTimeout(valid.timeoutMs);
    if (
      this.scope &&
      (valid.resourceId !== this.scope.resourceId || valid.threadId !== this.scope.threadId)
    ) {
      throw new Error('Background task does not belong to this conversation owner');
    }
    const keys = Object.keys(columns) as (keyof BackgroundTask)[];
    await this.database.query(
      `INSERT INTO ${MASTRA_BACKGROUND_TASKS_TABLE} (${keys.map((key) => `"${columns[key]}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((key) => sqlValue(key, valid[key]))
    );
  }
  override async updateTask(
    taskId: string,
    update: UpdateBackgroundTask,
    options?: { expectedStatus?: BackgroundTaskStatus }
  ): Promise<boolean> {
    if (this.scope && update.maxRetries !== undefined && update.maxRetries !== 0) {
      throw new Error('Automatic background worker retries are not permitted');
    }
    this.assertTimeout(update.timeoutMs);
    const keys = mutableFields.filter((key) => Object.hasOwn(update, key));
    const values: PgliteQueryValue[] = keys.map((key) => sqlValue(key, update[key]));
    values.push(taskId);
    const condition = `id = $${values.length}${scopeCondition(this.scope, values)}`;
    let expected = '';
    if (options?.expectedStatus !== undefined) {
      values.push(status.parse(options.expectedStatus));
      expected = ` AND status = $${values.length}`;
    }
    const statement = keys.length
      ? `UPDATE ${MASTRA_BACKGROUND_TASKS_TABLE} SET ${keys.map((key, i) => `"${columns[key]}" = $${i + 1}`).join(', ')} WHERE ${condition}${expected} RETURNING id`
      : `SELECT id FROM ${MASTRA_BACKGROUND_TASKS_TABLE} WHERE ${condition}${expected}`;
    return (await this.database.query(statement, values)).rows.length === 1;
  }
  override async getTask(taskId: string): Promise<BackgroundTask | null> {
    const values: PgliteQueryValue[] = [taskId];
    const row = (
      await this.database.query(
        `SELECT ${select} FROM ${MASTRA_BACKGROUND_TASKS_TABLE} WHERE id = $1${scopeCondition(this.scope, values)}`,
        values
      )
    ).rows[0];
    return row ? readTask(row) : null;
  }
  async markResultDelivered(taskId: string): Promise<void> {
    const values: PgliteQueryValue[] = [taskId];
    const result = await this.database.query(
      `UPDATE ${MASTRA_BACKGROUND_TASKS_TABLE} SET delivered_at = COALESCE(delivered_at, NOW())
       WHERE id = $1 AND status IN ('completed', 'failed', 'timed_out')${scopeCondition(this.scope, values)} RETURNING id`,
      values
    );
    if (result.rows.length !== 1) {
      throw new Error('Cannot acknowledge an absent, foreign or unfinished background result.');
    }
  }
  async listUndeliveredTasks(filter: TaskFilter): Promise<TaskListResult> {
    return this.readTaskPage(filter, true);
  }
  override async listTasks(filter: TaskFilter): Promise<TaskListResult> {
    return this.readTaskPage(filter, false);
  }
  private async readTaskPage(filter: TaskFilter, undelivered: boolean): Promise<TaskListResult> {
    const { clause, values, order } = filterQuery(filter, this.scope);
    const limit = pagination(filter, values);
    // One statement gives the total and page the same snapshot, including an empty page.
    const result = await this.database.query(
      `WITH matching AS MATERIALIZED (
      SELECT ${select} FROM ${MASTRA_BACKGROUND_TASKS_TABLE} ${clause}${undelivered ? ' AND delivered_at IS NULL' : ''}
    ), page AS (SELECT * FROM matching ${order} ${limit})
    SELECT (SELECT count(*)::int FROM matching) AS total,
      COALESCE(jsonb_agg(to_jsonb(page) ${order}), '[]'::jsonb) AS tasks FROM page`,
      values
    );
    const row = result.rows[0];
    const tasks = z.array(z.record(z.string(), z.unknown())).parse(row?.['tasks']);
    return { tasks: tasks.map(readTask), total: z.number().int().parse(row?.['total']) };
  }
  override async deleteTask(taskId: string): Promise<void> {
    const values: PgliteQueryValue[] = [taskId];
    await this.database.query(
      `DELETE FROM ${MASTRA_BACKGROUND_TASKS_TABLE} WHERE id = $1${scopeCondition(this.scope, values)}`,
      values
    );
  }
  override async deleteTasks(filter: TaskFilter): Promise<void> {
    const { clause, values, order } = filterQuery(filter, this.scope);
    const limit = pagination(filter, values);
    await this.database.query(
      `DELETE FROM ${MASTRA_BACKGROUND_TASKS_TABLE} WHERE id IN (SELECT id FROM ${MASTRA_BACKGROUND_TASKS_TABLE} ${clause} ${order} ${limit})`,
      values
    );
  }
  override async getRunningCount(): Promise<number> {
    return await this.runningCount();
  }
  override async getRunningCountByAgent(agentId: string): Promise<number> {
    return await this.runningCount(agentId);
  }
  private async runningCount(agentId?: string): Promise<number> {
    const { clause, values } = filterQuery(
      { status: 'running', ...(agentId === undefined ? {} : { agentId }) },
      this.scope
    );
    const rows = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${MASTRA_BACKGROUND_TASKS_TABLE} ${clause}`,
      values
    );
    return z.number().int().parse(rows.rows[0]?.count);
  }
  /**
   * The host owns the retry policy for background workers: none, ever (a
   * replayed non-idempotent write is never acceptable). Mastra's own system
   * prompt advertises `_background.maxRetries` to the model and its config
   * resolver honours the model's value ahead of the host default, and no host
   * knob removes that advertisement (BST-1749). A model-requested retry count
   * is therefore overridden here — the only path that reaches a scoped
   * `createTask` — and logged; rejecting it failed every delegation that
   * followed Mastra's guidance and pushed the model into foreground work.
   */
  private pinHostRetryPolicy<
    Task extends Pick<BackgroundTask, 'id' | 'maxRetries' | 'toolCallId' | 'toolName'>,
  >(task: Task): Task {
    if (!this.scope || task.maxRetries === 0) {
      return task;
    }
    logger.warn('Background worker retries pinned to 0 by host policy', {
      code: 'background_task_retries_pinned',
      requestedRetries: task.maxRetries,
      taskId: task.id,
      toolCallId: task.toolCallId,
      toolName: task.toolName,
    });
    return { ...task, maxRetries: 0 };
  }
  private assertTimeout(timeoutMs: number | undefined): void {
    if (!this.scope) {
      return;
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_BACKGROUND_TASK_TIMEOUT_MS)
    ) {
      throw new Error(
        'Background task timeout must be a positive integer no greater than the host limit.'
      );
    }
  }
  override async dangerouslyClearAll(): Promise<void> {
    await this.deleteTasks({});
  }
}
