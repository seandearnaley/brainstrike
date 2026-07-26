import {
  ASSISTANT_RUN_ERRORS_TABLE,
  type AssistantRunErrorRecord,
  type RecordAssistantRunErrorInput,
} from '../models/assistant-run-error.js';

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';

export type AssistantRunErrorStorageOperation = 'read' | 'record';

export class AssistantRunErrorStorageError extends Error {
  readonly operation: AssistantRunErrorStorageOperation;

  constructor(operation: AssistantRunErrorStorageOperation, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to ${operation} assistant run error${detail ? `: ${detail}` : ''}`, { cause });
    this.name = 'AssistantRunErrorStorageError';
    this.operation = operation;
  }
}

export interface AssistantRunErrorDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface AssistantRunErrorRow {
  cause_chain: unknown;
  code: unknown;
  http_status: unknown;
  message: unknown;
  occurred_at: unknown;
  provider_request_id: unknown;
  resource_id: unknown;
  response_headers: unknown;
  run_id: unknown;
  thread_id: unknown;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Assistant run error ${field} must be a non-empty string.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Assistant run error ${field} must be a string or null.`);
  }
  return value;
}

function requireInstant(value: unknown, field: string): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Assistant run error ${field} must be a valid timestamp.`);
  }
  return date;
}

function requireNullableHttpStatus(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (!(Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)) {
    throw new TypeError('Assistant run error httpStatus must be an integer from 100 through 599.');
  }
  return Number(value);
}

function requireNullableCauseChain(value: unknown): readonly unknown[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Assistant run error causeChain must be an array or null.');
  }
  return value;
}

function requireNullableResponseHeaders(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null) {
    return null;
  }
  if (!(typeof value === 'object' && !Array.isArray(value))) {
    throw new TypeError('Assistant run error responseHeaders must be an object or null.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, headerValue]) => typeof headerValue !== 'string')) {
    throw new TypeError('Assistant run error responseHeaders values must be strings.');
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function mapAssistantRunErrorRow(row: AssistantRunErrorRow): AssistantRunErrorRecord {
  return {
    causeChain: requireNullableCauseChain(row.cause_chain),
    code: requireNonEmptyString(row.code, 'code'),
    httpStatus: requireNullableHttpStatus(row.http_status),
    message: requireNullableString(row.message, 'message'),
    occurredAt: requireInstant(row.occurred_at, 'occurredAt'),
    providerRequestId: requireNullableString(row.provider_request_id, 'providerRequestId'),
    resourceId: requireNonEmptyString(row.resource_id, 'resourceId'),
    responseHeaders: requireNullableResponseHeaders(row.response_headers),
    runId: requireNonEmptyString(row.run_id, 'runId'),
    threadId: requireNonEmptyString(row.thread_id, 'threadId'),
  };
}

function validateRecordInput(input: RecordAssistantRunErrorInput): void {
  requireNonEmptyString(input.runId, 'runId');
  requireNonEmptyString(input.code, 'code');
  requireNullableString(input.message ?? null, 'message');
  requireNullableCauseChain(input.causeChain ?? null);
  requireNullableHttpStatus(input.httpStatus ?? null);
  requireNullableString(input.providerRequestId ?? null, 'providerRequestId');
  requireNullableResponseHeaders(input.responseHeaders ?? null);
  requireInstant(input.occurredAt, 'occurredAt');
}

/**
 * Durable terminal-forensics repository.
 *
 * `record` is first-terminal-wins across independent desktop-main/renderer
 * writers. A conflict returns the already-stored row only while the durable
 * parent still exists; a missing parent always returns zero rows and therefore
 * throws instead of silently discarding provider forensics.
 */
export class AssistantRunErrorRepository {
  constructor(private readonly db: AssistantRunErrorDatabase) {}

  async record(input: RecordAssistantRunErrorInput): Promise<AssistantRunErrorRecord> {
    validateRecordInput(input);
    try {
      const result = await this.db.query<AssistantRunErrorRow>(
        `WITH parent AS (
           SELECT thread_id, resource_id
           FROM ${ASSISTANT_THREAD_RUNS_TABLE}
           WHERE id = $1
         ),
         inserted AS (
           INSERT INTO ${ASSISTANT_RUN_ERRORS_TABLE} (
             run_id,
             thread_id,
             resource_id,
             code,
             message,
             cause_chain,
             http_status,
             provider_request_id,
             response_headers,
             occurred_at
           )
           SELECT
             $1,
             parent.thread_id,
             parent.resource_id,
             $2,
             $3,
             $4::jsonb,
             $5,
             $6,
             $7::jsonb,
             $8
           FROM parent
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *
         ),
         stored AS (
           SELECT * FROM inserted
           UNION ALL
           SELECT run_errors.*
           FROM ${ASSISTANT_RUN_ERRORS_TABLE} AS run_errors
           JOIN parent ON TRUE
           WHERE run_errors.run_id = $1
             AND NOT EXISTS (SELECT 1 FROM inserted)
         )
         SELECT * FROM stored LIMIT 1`,
        [
          input.runId,
          input.code,
          input.message ?? null,
          input.causeChain ? JSON.stringify(input.causeChain) : null,
          input.httpStatus ?? null,
          input.providerRequestId ?? null,
          input.responseHeaders ? JSON.stringify(input.responseHeaders) : null,
          input.occurredAt.toISOString(),
        ]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Durable assistant run parent "${input.runId}" does not exist.`);
      }
      return mapAssistantRunErrorRow(row);
    } catch (cause) {
      throw new AssistantRunErrorStorageError('record', cause);
    }
  }

  async getByRunId(runId: string): Promise<AssistantRunErrorRecord | null> {
    requireNonEmptyString(runId, 'runId');
    try {
      const result = await this.db.query<AssistantRunErrorRow>(
        `SELECT *
         FROM ${ASSISTANT_RUN_ERRORS_TABLE}
         WHERE run_id = $1`,
        [runId]
      );
      const row = result.rows[0];
      return row ? mapAssistantRunErrorRow(row) : null;
    } catch (cause) {
      throw new AssistantRunErrorStorageError('read', cause);
    }
  }
}
