export const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
export const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';

export type AssistantRunPersistenceRuntimeEngine = 'pglite' | 'turso';
export type AssistantThreadRunTerminalStatus = 'cancelled' | 'completed' | 'failed';

export interface AssistantRunPersistenceQuery {
  readonly params: unknown[];
  readonly sql: string;
}

export interface BuildAppendAssistantRunEventQueryInput {
  readonly detail: string | null;
  readonly durationMs: number | null;
  readonly eventId: string;
  readonly kind: string;
  readonly label: string;
  readonly metadataJson: string | null;
  readonly now: Date;
  readonly occurredAt: Date;
  readonly runId: string;
  readonly runtimeEngine: AssistantRunPersistenceRuntimeEngine;
  readonly sequence: number;
  readonly status: string;
}

export interface BuildCompleteAssistantThreadRunQueryInput {
  readonly error: string | null;
  readonly now: Date;
  readonly runId: string;
  readonly runtimeEngine: AssistantRunPersistenceRuntimeEngine;
  readonly status: AssistantThreadRunTerminalStatus;
}

export function buildAppendAssistantRunEventQuery(
  input: BuildAppendAssistantRunEventQueryInput
): AssistantRunPersistenceQuery {
  if (input.runtimeEngine === 'turso') {
    return {
      sql: `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
        (
          id,
          run_id,
          resource_id,
          thread_id,
          sequence,
          kind,
          status,
          label,
          detail,
          metadata,
          duration_ms,
          occurred_at,
          created_at,
          updated_at
        )
       SELECT
          ?,
          runs.id,
          runs.resource_id,
          runs.thread_id,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
       FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
       WHERE runs.id = ?
       ON CONFLICT (id) DO UPDATE SET
          sequence = excluded.sequence,
          kind = excluded.kind,
          status = excluded.status,
          label = excluded.label,
          detail = excluded.detail,
          metadata = excluded.metadata,
          duration_ms = excluded.duration_ms,
          occurred_at = excluded.occurred_at,
          updated_at = excluded.updated_at`,
      params: [
        input.eventId,
        input.sequence,
        input.kind,
        input.status,
        input.label,
        input.detail,
        input.metadataJson,
        input.durationMs,
        toSqliteTimestamp(input.occurredAt),
        toSqliteTimestamp(input.now),
        toSqliteTimestamp(input.now),
        input.runId,
      ],
    };
  }

  return {
    sql: `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
      (
        id,
        run_id,
        resource_id,
        thread_id,
        sequence,
        kind,
        status,
        label,
        detail,
        metadata,
        duration_ms,
        occurred_at,
        created_at,
        updated_at
      )
     SELECT
        $1,
        runs.id,
        runs.resource_id,
        runs.thread_id,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        $10,
        $11,
        $12
     FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
     WHERE runs.id = $2
     ON CONFLICT (id) DO UPDATE SET
        sequence = EXCLUDED.sequence,
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        label = EXCLUDED.label,
        detail = EXCLUDED.detail,
        metadata = EXCLUDED.metadata,
        duration_ms = EXCLUDED.duration_ms,
        occurred_at = EXCLUDED.occurred_at,
        updated_at = EXCLUDED.updated_at`,
    params: [
      input.eventId,
      input.runId,
      input.sequence,
      input.kind,
      input.status,
      input.label,
      input.detail,
      input.metadataJson,
      input.durationMs,
      input.occurredAt,
      input.now,
      input.now,
    ],
  };
}

export function buildCompleteAssistantThreadRunQuery(
  input: BuildCompleteAssistantThreadRunQueryInput
): AssistantRunPersistenceQuery {
  if (input.runtimeEngine === 'turso') {
    return {
      sql: `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
       SET status = ?, error = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      params: [
        input.status,
        input.error,
        toSqliteTimestamp(input.now),
        toSqliteTimestamp(input.now),
        input.runId,
      ],
    };
  }

  return {
    sql: `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
     SET status = $2, error = $3, completed_at = $4, updated_at = $5
     WHERE id = $1`,
    params: [input.runId, input.status, input.error, input.now, input.now],
  };
}

function toSqliteTimestamp(value: Date): string {
  return value.toISOString();
}
