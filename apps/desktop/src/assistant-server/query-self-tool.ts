/**
 * Desktop wiring for the `brainstrike.querySelf` assistant tool.
 *
 * Requires an explicit application (PGlite) or workspace index (SQLite) target.
 * Application queries retain AgentSqlService's four sandbox layers; index
 * queries own a killable read-only utility process and join it before returning.
 * Lens declarations select their dialect and must match the requested target.
 * See docs/agents/agent-self-query.md for the two sandbox contracts.
 *
 * ERROR POSTURE — deliberately different from the other DB-backed tools.
 * `hybridSearch` collapses unknown errors into a generic message because a
 * failed search tells the model nothing useful. Here the error IS the product:
 * a syntax error naming the offending token, or `permission denied for function
 * pg_read_file`, is exactly what teaches the model to write a correct query.
 * PostgreSQL messages describe the model's OWN input, so they pass through as
 * trusted input errors rather than being redacted.
 */

import type { QuerySelfInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import {
  AgentSqlCostRejectedError,
  AgentSqlInputError,
  AgentSqlService,
  AgentSqlUnboundedRecursionError,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import {
  SqliteQueryCancelledError,
  SqliteQueryDeadlineError,
  SqliteQueryInputError,
} from '@brainstrike/sqlite-query';
import { getDatabase } from '../db-main';
import type { UserLensScanResult } from './lens-loader';
import {
  QUERY_SELF_ERROR_MESSAGES,
  type QuerySelfQueryResult,
  type QuerySelfRead,
  type QuerySelfResult,
  runQuerySelfWith,
  shapeQuerySelfRows,
} from './query-self-core';
import { type QuerySelfIndexClient, runIndexQuerySelf } from './query-self-index-tool';

const logger = createLogger('AssistantQuerySelfTool');

export const QUERY_SELF_TOOL_ID = NATIVE_TOOL_ID.querySelf;

function redactErrorForLog(error: unknown): {
  code?: string | number;
  name: string;
  redacted: true;
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

/**
 * Classifies a failure as model-correctable or genuinely internal.
 *
 * Cost rejections and input errors are locally constructed. PostgreSQL errors
 * carry a `code` (SQLSTATE) — their `message` describes the submitted
 * statement, which the model authored, so echoing it leaks nothing the model
 * did not already have and is the only way it can self-correct.
 */
function handleQuerySelfError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof SqliteQueryCancelledError) {
    logger.info('Index self-query cancelled', {
      code: error.code,
      ownerPid: error.ownerPid,
      phase: error.phase,
      requestId: error.requestId,
      requestKind: error.requestKind,
      target: 'index',
    });
    throw error;
  }
  if (signal?.aborted) {
    throw error;
  }

  // Every admission rejection belongs here, not just the two original ones. A
  // guard that fires correctly but reports "the tool did not complete
  // successfully" is indistinguishable from a crash: observed live, the model
  // could not tell that its recursive CTE was the problem. If you add a new
  // rejection type to AgentSqlService, add it to this list.
  if (
    error instanceof AgentSqlCostRejectedError ||
    error instanceof AgentSqlInputError ||
    error instanceof AgentSqlUnboundedRecursionError ||
    error instanceof SqliteQueryInputError ||
    error instanceof SqliteQueryDeadlineError ||
    error instanceof ToolInputError
  ) {
    throw new ToolInputError(error.message);
  }

  const isPostgresError =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    error instanceof Error;

  if (isPostgresError) {
    throw new ToolInputError((error as Error).message);
  }

  logger.error('Self-query tool failed', { error: redactErrorForLog(error) });
  throw new Error(QUERY_SELF_ERROR_MESSAGES.queryFailed);
}

/** Test seam: inject the lens scan; production scans the request's roots. */
export interface QuerySelfToolOptions {
  readonly openIndexQuery?: (signal?: AbortSignal) => Promise<QuerySelfIndexClient>;
  readonly scanLenses?: () => UserLensScanResult;
  readonly signal?: AbortSignal | undefined;
  readonly withIndexCallerRead?: import('../native-caller-query').IndexCallerRead;
}

/** Main's own SQL read: the sandboxed application role or the read-only index process. */
export function mainQuerySelfRead(
  options: Pick<QuerySelfToolOptions, 'openIndexQuery' | 'withIndexCallerRead'> = {}
): QuerySelfRead {
  return async ({ input, invocation }, signal) => {
    try {
      if (input.target === 'index') {
        return await runIndexQuerySelf(
          input,
          invocation,
          options.openIndexQuery,
          signal,
          options.withIndexCallerRead
        );
      }
      if (input.target !== 'app') {
        throw new AgentSqlInputError('querySelf requires target="app" or target="index".');
      }
      return await runAppQuerySelf(input, invocation, signal);
    } catch (error) {
      handleQuerySelfError(error, signal);
    }
  };
}

async function runAppQuerySelf(
  input: QuerySelfInput,
  invocation: { params: readonly unknown[]; sql: string } | undefined,
  signal?: AbortSignal
): Promise<QuerySelfResult> {
  const db = await getDatabase();
  signal?.throwIfAborted();
  const service = new AgentSqlService(db);

  if (input.mode === 'listTables') {
    const tables = await service.describeTables();
    return { kind: 'tables', tables, target: 'app' };
  }

  if (input.mode === 'describeTable') {
    const table = input.table?.trim();
    if (!table) {
      // Actionable, not generic: the model can fix this on the next turn.
      throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingTable);
    }
    const columns = await service.describeTable(table);
    return { columns, kind: 'columns', table, target: 'app' };
  }

  if (invocation) {
    return await runRowsQuery(service, invocation.sql, input.maxRows, invocation.params);
  }

  const sql = input.sql?.trim();
  if (!sql) {
    throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingSql);
  }

  if (input.mode === 'explain') {
    const explained = await service.explain(sql, {
      ...(input.analyze === undefined ? {} : { analyze: input.analyze }),
    });
    return { analyzed: explained.analyzed, kind: 'plan', plan: explained.plan, target: 'app' };
  }

  return await runRowsQuery(service, sql, input.maxRows);
}

export function runQuerySelf(
  input: QuerySelfInput,
  runtimeData: RuntimeData | undefined,
  options: QuerySelfToolOptions = {}
): Promise<QuerySelfResult> {
  return runQuerySelfWith(input, runtimeData, mainQuerySelfRead(options), options);
}

/**
 * Execute one statement and shape its rows for the model — shared by
 * mode="query" and mode="lens" so a lens result is EXACTLY a query result
 * (same rendering, same budget behaviour, same truncation hints).
 */
async function runRowsQuery(
  service: AgentSqlService,
  sql: string,
  maxRows: number | undefined,
  params?: readonly unknown[]
): Promise<QuerySelfQueryResult> {
  const result = await service.query(sql, {
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(params === undefined ? {} : { params }),
  });

  return shapeQuerySelfRows(result, maxRows ?? 50, 'app');
}
