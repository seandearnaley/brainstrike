import type { McpTaskRecord, UpdateMcpTaskInput } from '@brainstrike/db';
import type { CreateTaskResult, GetTaskResult, TaskStatus } from '@brainstrike/mcp-tasks-extension';

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'cancelled',
  'completed',
  'failed',
]);

export interface McpTaskTiming {
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly pollIntervalMs?: number;
  readonly ttlMs: number | null;
}

function parseInstant(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`MCP task ${field} must be a valid timestamp.`);
  }
  return timestamp;
}

export function parseMcpTaskDuration(
  value: number | null | undefined,
  field: string
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError(`MCP task ${field} must be a non-negative safe integer or null.`);
  }
  return value;
}

export function readMcpTaskTiming(task: CreateTaskResult | GetTaskResult): McpTaskTiming {
  const createdAt = parseInstant(task.createdAt, 'createdAt');
  const lastUpdatedAt = parseInstant(task.lastUpdatedAt, 'lastUpdatedAt');
  if (lastUpdatedAt < createdAt) {
    throw new TypeError('MCP task lastUpdatedAt must not precede createdAt.');
  }
  const ttlMs = parseMcpTaskDuration(task.ttlMs, 'ttlMs');
  const pollIntervalMs = parseMcpTaskDuration(task.pollIntervalMs, 'pollIntervalMs');
  return Object.freeze({
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ...(pollIntervalMs === null ? {} : { pollIntervalMs }),
    ttlMs,
  });
}

export function assertMcpTaskTimingProgress(
  previous: McpTaskTiming,
  next: McpTaskTiming,
  taskId: string
): void {
  if (next.createdAt !== previous.createdAt) {
    throw new Error(`MCP task "${taskId}" createdAt changed during polling.`);
  }
  if (Date.parse(next.lastUpdatedAt) < Date.parse(previous.lastUpdatedAt)) {
    throw new Error(`MCP task "${taskId}" lastUpdatedAt regressed during polling.`);
  }
}

type McpTaskMetadata = NonNullable<UpdateMcpTaskInput['inputMetadata']>;

function timingMetadata(timing: McpTaskTiming): McpTaskMetadata {
  return {
    lifecycle: {
      createdAt: timing.createdAt,
      lastUpdatedAt: timing.lastUpdatedAt,
      ...(timing.pollIntervalMs === undefined ? {} : { pollIntervalMs: timing.pollIntervalMs }),
      ttlMs: timing.ttlMs,
    },
  };
}

export function readStoredMcpTaskTiming(record: McpTaskRecord): McpTaskTiming {
  const lifecycle = record.inputMetadata?.['lifecycle'];
  if (typeof lifecycle !== 'object' || lifecycle === null || Array.isArray(lifecycle)) {
    throw new Error(`MCP task "${record.taskId}" has no durable lifecycle timing metadata.`);
  }
  const createdAt = lifecycle['createdAt'];
  const lastUpdatedAt = lifecycle['lastUpdatedAt'];
  if (typeof createdAt !== 'string' || typeof lastUpdatedAt !== 'string') {
    throw new TypeError(`MCP task "${record.taskId}" has invalid durable lifecycle timestamps.`);
  }
  const pollIntervalMs = lifecycle['pollIntervalMs'];
  const ttlMs = lifecycle['ttlMs'];
  if (pollIntervalMs !== undefined && typeof pollIntervalMs !== 'number') {
    throw new TypeError(`MCP task "${record.taskId}" has an invalid durable poll interval.`);
  }
  if (ttlMs !== null && typeof ttlMs !== 'number') {
    throw new TypeError(`MCP task "${record.taskId}" has an invalid durable lifetime.`);
  }
  return readMcpTaskTiming({
    createdAt,
    lastUpdatedAt,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    resultType: 'task',
    status: record.status,
    taskId: record.taskId,
    ttlMs,
  });
}

export function createMcpTaskUpdate(task: CreateTaskResult | GetTaskResult): UpdateMcpTaskInput {
  const lifecycleMetadata = timingMetadata(readMcpTaskTiming(task));
  const common = {
    status: task.status,
    statusMessage: task.statusMessage ?? null,
  };
  if (task.status === 'input_required') {
    if (!('inputRequests' in task)) {
      throw new TypeError('An input_required MCP task must include inputRequests.');
    }
    const inputMetadata: McpTaskMetadata = {
      ...lifecycleMetadata,
      inputRequests: task.inputRequests,
    };
    return { ...common, inputMetadata };
  }
  if (task.status === 'completed') {
    if (!('result' in task)) {
      throw new TypeError('A completed MCP task must include its result.');
    }
    const resultMetadata: McpTaskMetadata = { ...lifecycleMetadata, result: task.result };
    return { ...common, inputMetadata: null, resultMetadata };
  }
  if (task.status === 'failed') {
    if (!('error' in task)) {
      throw new TypeError('A failed MCP task must include its JSON-RPC error.');
    }
    const resultMetadata: McpTaskMetadata = { ...lifecycleMetadata, error: task.error };
    return { ...common, inputMetadata: null, resultMetadata };
  }
  if (task.status === 'cancelled') {
    return { ...common, inputMetadata: null };
  }
  return { ...common, inputMetadata: lifecycleMetadata };
}

export function resolveMcpTaskDeadline(
  timing: McpTaskTiming,
  record: McpTaskRecord,
  localDeadline: number,
  maxLifetimeMs: number
): number {
  if (timing.ttlMs === null) {
    return Math.min(localDeadline, record.createdAt.getTime() + maxLifetimeMs);
  }
  const createdAt = parseInstant(timing.createdAt, 'createdAt');
  return Math.min(
    localDeadline,
    createdAt + timing.ttlMs,
    record.createdAt.getTime() + maxLifetimeMs
  );
}
