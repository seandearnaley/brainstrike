/**
 * Main's run-event writer (BST-975 slice 2), used by the worktree service and
 * the E2E foreground-latency probe.
 *
 * Production migrations own schema creation. This writer only uses the
 * server-owned run id created by the repository and never executes DDL.
 * The if(runId) gates remain at call sites.
 */
import {
  type AssistantRunEvent,
  readProviderRunError,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/agent';
import { AssistantRunErrorRepository } from '@brainstrike/db';
import { desktopAssistantServerLogger as logger } from './logger';
import { runCriticalDatabaseOperation } from './run-critical-database';

/**
 * The structural DB surface this writer needs (BST-972 A1): satisfied by
 * db-main's handle and by a bare PGlite in the paired integration tests, and
 * structurally assignable to the `AssistantRunErrorDatabase` the forensics
 * repository requires.
 */
interface RunPersistenceDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * A PROVIDER, not a resolved handle: each write awaits the current main-process
 * database, so behavior across a mid-run handle swap (e.g. factory reset) is
 * unchanged. Desktop composition sites pass db-main's `getDatabase` verbatim.
 */
type RunPersistenceDatabaseProvider = () => Promise<RunPersistenceDatabase>;

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';

/**
 * The worktree service (BST-1390) emits its lifecycle rows through this writer
 * and therefore inherits the documented `if (runId)` gate and the "missing
 * parent row ⇒ 0 rows, silent no-op" behavior (the INSERT is an
 * `INSERT ... SELECT ... FROM brainstrike_assistant_thread_runs WHERE id =
 * $runId`, so an unknown/absent runId writes nothing).
 */
export async function recordDesktopAssistantRunEvent(
  runId: string,
  event: AssistantRunEvent,
  getDatabase: RunPersistenceDatabaseProvider
): Promise<void> {
  const now = new Date();
  let metadata = sanitizeAssistantRunEventMetadata(event.metadata);
  const database = await getDatabase();
  await runCriticalDatabaseOperation({
    label: 'assistant-run-event-write',
    onRetry: ({ error }) => {
      metadata = sanitizeAssistantRunEventMetadata({
        ...metadata,
        databaseRetry: {
          attempt: 2,
          pendingCount: error.pendingCount,
          reason: 'host-saturated-timeout',
          requestKind: error.requestKind,
          timeoutMs: error.timeoutMs,
        },
      });
    },
    operation: () =>
      database.query(
        `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
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
        [
          event.id,
          runId,
          event.sequence ?? 0,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          metadata ? JSON.stringify(metadata) : null,
          event.durationMs ?? null,
          new Date(event.timestamp),
          now,
          now,
        ]
      ),
    retry: 'idempotent',
    runId,
  });
  if (event.kind !== 'run.failed') {
    return;
  }
  const runError = readProviderRunError(metadata);
  if (!runError) {
    return;
  }
  try {
    await new AssistantRunErrorRepository(database).record({
      ...runError,
      occurredAt: new Date(event.timestamp),
      runId,
    });
  } catch (error) {
    logger.error('Failed to persist assistant provider failure forensics', {
      error,
      eventId: event.id,
      runId,
    });
  }
}
