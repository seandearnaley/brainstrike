import {
  MASTRA_WORKFLOW_TABLE,
  type PgliteDatabase,
} from '@brainstrike/agent/pglite-mastra-memory';
import {
  type AssistantRunEvent,
  emitAssistantRunEventSafely,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { DbHostRequestTimeoutError } from '../db-host-manager';
import { runDesktopScheduledDatabaseWork } from '../platform/desktop-database-work';

const logger = createLogger('AssistantRunCriticalDatabase');

interface RunCriticalDatabaseRetry {
  readonly attempt: 2;
  readonly error: DbHostRequestTimeoutError;
}

interface RunCriticalDatabaseEvidenceOptions {
  readonly eventSink: ((event: AssistantRunEvent) => void) | undefined;
  readonly runId: string;
}

export interface RunCriticalDatabaseOperationOptions<T> {
  readonly label: string;
  readonly onRetry?: ((retry: RunCriticalDatabaseRetry) => void) | undefined;
  readonly operation: () => Promise<T>;
  readonly retry: 'none' | 'idempotent';
  readonly runId?: string | undefined;
}

export function runCriticalDatabaseOperation<T>(
  options: RunCriticalDatabaseOperationOptions<T>
): Promise<T> {
  return runAttempt(options, 1).catch((error: unknown) => {
    if (
      options.retry !== 'idempotent' ||
      !(error instanceof DbHostRequestTimeoutError) ||
      !error.hostSaturated
    ) {
      throw error;
    }

    logger.warn('Retrying run-critical database work after saturated-host timeout', {
      attempt: 2,
      label: options.label,
      pendingCount: error.pendingCount,
      requestKind: error.requestKind,
      runId: options.runId,
      timeoutMs: error.timeoutMs,
    });
    options.onRetry?.({ attempt: 2, error });
    return runAttempt(options, 2);
  });
}

export function createRunCriticalDatabase(
  database: PgliteDatabase,
  evidence: RunCriticalDatabaseEvidenceOptions
): PgliteDatabase {
  const transaction = database.transaction?.bind(database);
  const run = <T>(
    label: string,
    operation: () => Promise<T>,
    retry: 'none' | 'idempotent'
  ): Promise<T> =>
    runCriticalDatabaseOperation({
      label,
      onRetry: ({ error }) => {
        emitAssistantRunEventSafely({
          event: {
            detail: 'Retried once after the database host was saturated.',
            kind: 'run.database.retried',
            label: 'Run database operation retried',
            metadata: {
              attempt: 2,
              operation: label,
              pendingCount: error.pendingCount,
              requestKind: error.requestKind,
              timeoutMs: error.timeoutMs,
            },
            status: 'info',
          },
          eventSink: evidence.eventSink,
          onError: (sinkError) => {
            logger.warn('Failed to emit run-critical database retry evidence', {
              error: sinkError,
              label,
              runId: evidence.runId,
            });
          },
          runId: evidence.runId,
        });
      },
      operation,
      retry,
      runId: evidence.runId,
    });

  return {
    exec: (query) => run('assistant-run-database-exec', () => database.exec(query), 'none'),
    query: (query, values) =>
      run(
        'assistant-run-database-query',
        () => database.query(query, values),
        isWorkflowSnapshotRead(query) ? 'idempotent' : 'none'
      ),
    ...(transaction
      ? {
          transaction: <T>(operation: (tx: PgliteDatabase) => Promise<T>) =>
            run('assistant-run-database-transaction', () => transaction(operation), 'none'),
        }
      : {}),
  };
}

function isWorkflowSnapshotRead(query: string): boolean {
  return (
    /^\s*select\b/i.test(query) && new RegExp(`\\b${MASTRA_WORKFLOW_TABLE}\\b`, 'i').test(query)
  );
}

function runAttempt<T>(
  options: RunCriticalDatabaseOperationOptions<T>,
  attempt: 1 | 2
): Promise<T> {
  return runDesktopScheduledDatabaseWork(
    {
      label: attempt === 1 ? options.label : `${options.label}:retry`,
      priority: 'foreground',
    },
    options.operation
  );
}
