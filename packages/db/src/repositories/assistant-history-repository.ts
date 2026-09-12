import {
  ASSISTANT_MESSAGE_PARENTS_TABLE,
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ASSISTANT_RUN_EVENT_KINDS,
  ASSISTANT_RUN_EVENT_STATUSES,
  type AssistantRunEvent,
  type AssistantRunEventKind,
  type AssistantRunEventStatus,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';

interface AssistantHistoryDatabase {
  query(sql: string, params?: (string | number | null)[]): Promise<{ rows: unknown[] }>;
}

export const ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT = 80;
const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';
const ASSISTANT_RUN_EVENT_KIND_SET = new Set<AssistantRunEventKind>(ASSISTANT_RUN_EVENT_KINDS);
const ASSISTANT_RUN_EVENT_STATUS_SET = new Set<AssistantRunEventStatus>(
  ASSISTANT_RUN_EVENT_STATUSES
);

export interface AssistantHistoryMessage {
  readonly content: unknown;
  readonly createdAt: Date;
  readonly id: string;
  /** Undefined only for legacy rows written before durable branch topology. */
  readonly parentId?: string | null;
  readonly role: string;
}

export interface AssistantThreadMessageListOptions {
  /** Exclusive native message cursor, scoped to the same thread and resource. */
  readonly beforeMessageId?: string;
  readonly limitLatest?: number;
  /** Stop a targeted read if its same-owner native message was deleted or hidden. */
  readonly targetMessageId?: string;
}

export interface AssistantThreadRunEventListOptions {
  readonly limitLatestRuns?: number;
}

/** Requires a migrated database. These readers perform no schema creation. */
export async function readAssistantHistoryMessages(
  database: AssistantHistoryDatabase,
  threadId: string,
  resourceId: string,
  options?: AssistantThreadMessageListOptions
): Promise<readonly AssistantHistoryMessage[]> {
  const limitLatest =
    typeof options?.limitLatest === 'number' && Number.isSafeInteger(options.limitLatest)
      ? options.limitLatest
      : undefined;
  if (limitLatest !== undefined && limitLatest < 1) {
    throw new Error('Assistant message history limit must be a positive safe integer.');
  }
  const params: (string | number | null)[] = [threadId, resourceId];
  if (options?.beforeMessageId && limitLatest === undefined) {
    throw new Error('Assistant message history pagination requires a bounded page size.');
  }
  // Legacy Mastra rows may omit the message resource. Only the native thread's
  // actual resource can supply it, matching search admission without widening ownership.
  const nativeResourceSql = `(SELECT native."resourceId" FROM ${MASTRA_MEMORY_TABLES.threads} native WHERE native.id = $1)`;
  const cursorClause = options?.beforeMessageId
    ? `AND ("createdAt", id) < (
    SELECT cursor."createdAt", cursor.id FROM ${MASTRA_MEMORY_TABLES.messages} cursor
    WHERE cursor.id = $4 AND cursor.thread_id = $1 AND COALESCE(cursor."resourceId", ${nativeResourceSql}) = $2
  )`
    : '';
  const limitClause =
    limitLatest === undefined
      ? ''
      : `-- id is a deterministic tie-breaker for same-timestamp rows;
               -- insertion-order ties need a future monotonic schema column.
               ORDER BY "createdAt" DESC, id DESC
               LIMIT $3`;
  const targetParameter = options?.beforeMessageId ? 5 : limitLatest === undefined ? 3 : 4;
  const targetClause = options?.targetMessageId
    ? `AND EXISTS (
    SELECT 1 FROM ${MASTRA_MEMORY_TABLES.messages} target
    WHERE target.id = $${targetParameter} AND target.thread_id = $1 AND COALESCE(target."resourceId", ${nativeResourceSql}) = $2
      AND NOT EXISTS (SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} hidden WHERE hidden.message_id = target.id)
  )`
    : '';
  // Soft-rewind exclusion (BST-1115) sits INSIDE the windowing subquery, so
  // it applies before `limitLatest` — the hydration window is the latest N
  // VISIBLE messages, not N rows of which some are then dropped. Reload
  // hydration is this query, which is why a tombstoned message stays gone
  // across a restart without any renderer-side memory of the rewind.
  const sql = `SELECT
          recent_messages.id,
          recent_messages.role,
          recent_messages.content,
          recent_messages."createdAt",
          message_parents.message_id AS "parentMappingMessageId",
          message_parents.parent_id AS "parentId"
        FROM (
          SELECT id, role, content, "createdAt"
          FROM ${MASTRA_MEMORY_TABLES.messages}
          WHERE thread_id = $1 AND COALESCE("resourceId", ${nativeResourceSql}) = $2
            AND NOT EXISTS (
              SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
              WHERE tombstones.message_id = ${MASTRA_MEMORY_TABLES.messages}.id
            )
          ${cursorClause}
          ${targetClause}
          ${limitClause}
        ) AS recent_messages
        LEFT JOIN ${ASSISTANT_MESSAGE_PARENTS_TABLE} AS message_parents
          ON message_parents.message_id = recent_messages.id
          AND message_parents.thread_id = $1
          AND message_parents.resource_id = $2
        ORDER BY recent_messages."createdAt" ASC, recent_messages.id ASC`;
  if (limitLatest !== undefined) {
    params.push(limitLatest);
  }
  if (options?.beforeMessageId) {
    params.push(options.beforeMessageId);
  }
  if (options?.targetMessageId) {
    params.push(options.targetMessageId);
  }
  const result = await database.query(sql, params);
  return result.rows.map((row) => mapAssistantHistoryMessageRow(requireHistoryRow(row)));
}

/** Requires a migrated database. These readers perform no schema creation. */
export async function readAssistantHistoryRunEvents(
  database: AssistantHistoryDatabase,
  threadId: string,
  resourceId: string,
  options?: AssistantThreadRunEventListOptions
): Promise<readonly AssistantRunEvent[]> {
  const limitLatestRuns =
    typeof options?.limitLatestRuns === 'number' && Number.isSafeInteger(options.limitLatestRuns)
      ? options.limitLatestRuns
      : undefined;
  if (limitLatestRuns !== undefined && limitLatestRuns < 1) {
    throw new Error('Assistant run event history limit must be a positive safe integer.');
  }
  const params: (string | number | null)[] = [threadId, resourceId];
  const boundedRunFilter =
    limitLatestRuns === undefined
      ? ''
      : `AND run.id IN (
            SELECT recent_run.id
            FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS recent_run
            WHERE recent_run.thread_id = $1 AND recent_run.resource_id = $2
            ORDER BY recent_run.started_at DESC, recent_run.created_at DESC, recent_run.id DESC
            LIMIT $3
          )`;
  if (limitLatestRuns !== undefined) {
    params.push(limitLatestRuns);
  }
  const result = await database.query(
    `SELECT
          event.id,
          event.run_id,
          event.sequence,
          event.kind,
          event.status,
          event.label,
          event.detail,
          event.duration_ms,
          event.metadata,
          run.turn_message_id AS "originatingTurnMessageId",
          event.occurred_at
       FROM ${ASSISTANT_RUN_EVENTS_TABLE} AS event
       INNER JOIN ${ASSISTANT_THREAD_RUNS_TABLE} AS run ON run.id = event.run_id
       WHERE event.thread_id = $1
          AND event.resource_id = $2
          ${boundedRunFilter}
       ORDER BY run.started_at ASC, run.created_at ASC, run.id ASC,
                event.sequence ASC, event.occurred_at ASC, event.id ASC`,
    params
  );
  return result.rows.map((row) => toThreadRunEvent(requireHistoryRow(row)));
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid timestamp value');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new Error(`Invalid timestamp value: ${String(value)}`);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Mastra memory row: ${fieldName} is not a string.`);
  }
  return value;
}

function requireNonEmptyTopologyId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Assistant message topology ${fieldName} must be a non-empty string.`);
  }
  return value;
}

function mapAssistantHistoryMessageRow(row: Record<string, unknown>): AssistantHistoryMessage {
  const parentMappingMessageId = row['parentMappingMessageId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    requireNonEmptyTopologyId(parentMappingMessageId, 'parentMappingMessageId');
  }
  const parentId = row['parentId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    if (parentId !== null) {
      requireNonEmptyTopologyId(parentId, 'parentId');
    }
  } else if (parentId !== null && parentId !== undefined) {
    throw new Error('Assistant message parent exists without a mapping row.');
  }
  return {
    content: parseJson(row['content']),
    createdAt: normalizeDate(row['createdAt']),
    id: requireString(row['id'], 'id'),
    ...(parentMappingMessageId === null || parentMappingMessageId === undefined
      ? {}
      : { parentId: parentId === null ? null : (parentId as string) }),
    role: requireString(row['role'], 'role'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return optionalRecord(parsed);
}

function getRowValue(row: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  return row[camelKey] ?? row[snakeKey];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireRunEventKind(value: unknown): AssistantRunEventKind {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_KIND_SET.has(value as AssistantRunEventKind)
  ) {
    return value as AssistantRunEventKind;
  }
  throw new Error('Invalid assistant run event row: kind is not valid.');
}

function requireRunEventStatus(value: unknown): AssistantRunEventStatus {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_STATUS_SET.has(value as AssistantRunEventStatus)
  ) {
    return value as AssistantRunEventStatus;
  }
  throw new Error('Invalid assistant run event row: status is not valid.');
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function toThreadRunEvent(row: Record<string, unknown>): AssistantRunEvent {
  const metadata = optionalJsonRecord(row['metadata']);
  const originatingTurnMessageId = nullableString(row['originatingTurnMessageId']);
  const sanitizedMetadata = sanitizeAssistantRunEventMetadata(
    originatingTurnMessageId ? { ...metadata, originatingTurnMessageId } : metadata
  );
  const detail = nullableString(row['detail']);
  const durationRaw = getRowValue(row, 'durationMs', 'duration_ms');
  const durationMs = isFiniteInteger(durationRaw) ? durationRaw : undefined;
  const event: AssistantRunEvent = {
    id: requireString(row['id'], 'id'),
    kind: requireRunEventKind(row['kind']),
    label: requireString(row['label'], 'label'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    sequence: isFiniteInteger(row['sequence']) ? row['sequence'] : Number(row['sequence']),
    status: requireRunEventStatus(row['status']),
    timestamp: normalizeDate(getRowValue(row, 'timestamp', 'occurred_at')).toISOString(),
    ...(detail ? { detail } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
  };
  if (!Number.isSafeInteger(event.sequence)) {
    throw new Error('Invalid assistant run event row: sequence is not valid.');
  }
  return event;
}

function requireHistoryRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid assistant history row.');
  }
  return value as Record<string, unknown>;
}

/** Shared topology writer; native Mastra remains the sole message-content writer. */
export async function recordAssistantHistoryParent(
  database: AssistantHistoryDatabase,
  input: {
    readonly messageId: string;
    readonly threadId: string;
    readonly resourceId: string;
    readonly parentId: string | null;
  }
): Promise<void> {
  for (const [name, value] of Object.entries(input)) {
    if (name === 'parentId' && value === null) {
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Assistant message topology ${name} must be a non-empty string.`);
    }
  }
  const result = await database.query(
    `INSERT INTO ${ASSISTANT_MESSAGE_PARENTS_TABLE}
    (message_id, thread_id, resource_id, parent_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (message_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
    WHERE ${ASSISTANT_MESSAGE_PARENTS_TABLE}.thread_id = EXCLUDED.thread_id
      AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.resource_id = EXCLUDED.resource_id
      AND ${ASSISTANT_MESSAGE_PARENTS_TABLE}.parent_id IS NOT DISTINCT FROM EXCLUDED.parent_id
    RETURNING message_id`,
    [input.messageId, input.threadId, input.resourceId, input.parentId]
  );
  if (result.rows.length !== 1) {
    throw new Error(`Assistant message ${input.messageId} has conflicting branch topology.`);
  }
}
