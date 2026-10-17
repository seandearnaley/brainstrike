import type {
  McpTaskRecord,
  UpdateMcpTaskInput,
} from '@brainstrike/assistant-contract/mcp-task-store';
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

export interface McpTaskMetadataOverflow {
  readonly actualBytes: number;
  readonly field: 'inputMetadata' | 'resultMetadata';
  readonly maxBytes: number;
  readonly sha256: string;
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

/**
 * `CreateTaskResult` extends the BASE task schema, so a create response may
 * carry `status: "completed"` (or `failed`/`input_required`) without the
 * detail fields the status-discriminated `tasks/get` result requires. The
 * handle is still durable and must be persisted before exposure: it is stored
 * as `working` with the remote status and a pending-detail marker, and the
 * lifecycle fetches the detailed state through `tasks/get` immediately.
 * Detail-complete create results take the ordinary path.
 */
export function createMcpTaskHandleUpdate(task: CreateTaskResult): UpdateMcpTaskInput {
  const missingDetail =
    (task.status === 'completed' && !('result' in task)) ||
    (task.status === 'failed' && !('error' in task)) ||
    (task.status === 'input_required' && !('inputRequests' in task));
  if (!missingDetail) {
    return createMcpTaskUpdate(task);
  }
  return {
    inputMetadata: {
      ...timingMetadata(readMcpTaskTiming(task)),
      detail: 'pending',
      remoteStatus: task.status,
    },
    status: 'working',
    statusMessage: task.statusMessage ?? null,
  };
}

export function hasPendingMcpTaskDetail(record: McpTaskRecord): boolean {
  return record.status === 'working' && record.inputMetadata?.['detail'] === 'pending';
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

export function createMcpTaskOverflowUpdate(
  task: CreateTaskResult | GetTaskResult,
  overflow: McpTaskMetadataOverflow
): UpdateMcpTaskInput {
  const diagnostic = {
    actualBytes: overflow.actualBytes,
    code: 'mcp_task_state_too_large',
    field: overflow.field,
    maxBytes: overflow.maxBytes,
    remoteStatus: task.status,
    sha256: overflow.sha256,
  } as const;
  const projection = {
    ...timingMetadata(readMcpTaskTiming(task)),
    omittedState: diagnostic,
  };
  const common = {
    blockedDiagnostic: diagnostic,
    status: task.status,
    statusMessage: 'MCP task state exceeded the durable metadata limit.',
  } as const;
  if (task.status === 'input_required' || task.status === 'working') {
    return { ...common, inputMetadata: projection, resultMetadata: null };
  }
  return { ...common, inputMetadata: null, resultMetadata: projection };
}

/**
 * `ttlMs` is a duration, so it is anchored to the LOCAL instant the handle was
 * first persisted (`record.createdAt`), never to the server's `createdAt`
 * string: a server clock five minutes behind would otherwise expire a fresh
 * task before its first poll, and one ahead would silently extend the TTL.
 */
export function resolveMcpTaskDeadline(
  timing: McpTaskTiming,
  record: McpTaskRecord,
  localDeadline: number,
  maxLifetimeMs: number
): number {
  const persistedAt = record.createdAt.getTime();
  if (timing.ttlMs === null) {
    return Math.min(localDeadline, persistedAt + maxLifetimeMs);
  }
  return Math.min(localDeadline, persistedAt + timing.ttlMs, persistedAt + maxLifetimeMs);
}

export interface McpTaskPollDelayLimits {
  readonly maxBackoffMs: number;
  readonly minimumPollMs: number;
}

/**
 * A server-supplied `pollIntervalMs` is a hint bounded by client-owned limits
 * on both sides: never below `minimumPollMs` (a server cannot pin the client
 * at zero delay) and never above `maxBackoffMs` (a server cannot stall
 * observation). While transport failures are being retried the local backoff
 * dominates the hint, so a stale interval from the last success cannot turn a
 * failing server into a retry storm.
 */
export function resolveMcpTaskPollDelay(
  timing: McpTaskTiming,
  backoffMs: number,
  consecutiveFailures: number,
  limits: McpTaskPollDelayLimits
): number {
  const requested = parseMcpTaskDuration(timing.pollIntervalMs, 'pollIntervalMs');
  if (requested === null) {
    return backoffMs;
  }
  const clamped = Math.min(Math.max(requested, limits.minimumPollMs), limits.maxBackoffMs);
  return consecutiveFailures > 0 ? Math.max(clamped, backoffMs) : clamped;
}
