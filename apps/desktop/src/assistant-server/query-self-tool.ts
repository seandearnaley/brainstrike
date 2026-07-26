/**
 * Desktop wiring for the `brainstrike.querySelf` assistant tool.
 *
 * Runs one read-only SQL statement against Brainstrike's own local PGlite
 * database — the store that holds this assistant's run history, edit
 * checkpoints, usage and cost, queue metrics, AND the workspace code index —
 * so questions that would otherwise cost dozens of tool calls become a single
 * statement.
 *
 * All execution safety lives in `AgentSqlService` (@brainstrike/db). This module
 * only resolves the database, dispatches describe-vs-query, and shapes the
 * result. See `docs/agents/agent-self-query.md` for the sandbox contract.
 *
 * ERROR POSTURE — deliberately different from the other DB-backed tools.
 * `hybridSearch` collapses unknown errors into a generic message because a
 * failed search tells the model nothing useful. Here the error IS the product:
 * a syntax error naming the offending token, or `permission denied for function
 * pg_read_file`, is exactly what teaches the model to write a correct query.
 * PostgreSQL messages describe the model's OWN input, so they pass through as
 * trusted input errors rather than being redacted.
 */

import { fitItemsToCharBudget, type QuerySelfInput, type RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import {
  AgentSqlCostRejectedError,
  AgentSqlInputError,
  AgentSqlService,
  AgentSqlUnboundedRecursionError,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantQuerySelfTool');

export const QUERY_SELF_TOOL_ID = NATIVE_TOOL_ID.querySelf;

export const QUERY_SELF_ERROR_MESSAGES = {
  missingSql: 'mode="query" and mode="explain" require a sql statement.',
  missingTable: 'mode="describeTable" requires a table name. Use mode="listTables" to see them.',
  queryFailed: 'Self-query failed. Please try again.',
} as const;

/** Longest cell rendering kept in a result row. A bytea column or a large
 * JSONB document must not consume the whole projection budget on its own. */
const MAX_CELL_CHARS = 200;

export interface QuerySelfRow {
  cells: string[];
}

export interface QuerySelfQueryResult {
  columns: string[];
  estimatedCost: number;
  hint?: string;
  kind: 'rows';
  rowCount: number;
  rows: QuerySelfRow[];
  truncated: boolean;
}

export interface QuerySelfTablesResult {
  kind: 'tables';
  tables: { estimatedRows: number; name: string }[];
}

export interface QuerySelfColumnsResult {
  columns: { dataType: string; name: string; nullable: boolean }[];
  kind: 'columns';
  table: string;
}

export interface QuerySelfPlanResult {
  /** True when the statement was executed to collect real timings. */
  analyzed: boolean;
  kind: 'plan';
  /** PostgreSQL's own indented plan text, one entry per output row. */
  plan: string[];
}

export type QuerySelfResult =
  | QuerySelfQueryResult
  | QuerySelfTablesResult
  | QuerySelfColumnsResult
  | QuerySelfPlanResult;

/**
 * Renders one value for the model.
 *
 * Every cell becomes a string: a row is a positional array, so mixed types in
 * one column would otherwise force the model to reason about JSON encoding
 * noise. `null` is rendered as the literal `NULL` rather than dropped, because
 * "this column is null" is frequently the actual answer (for example finding
 * chunks with no embedding).
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);

  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

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
function handleQuerySelfError(error: unknown): never {
  // Every admission rejection belongs here, not just the two original ones. A
  // guard that fires correctly but reports "the tool did not complete
  // successfully" is indistinguishable from a crash: observed live, the model
  // could not tell that its recursive CTE was the problem. If you add a new
  // rejection type to AgentSqlService, add it to this list.
  if (
    error instanceof AgentSqlCostRejectedError ||
    error instanceof AgentSqlInputError ||
    error instanceof AgentSqlUnboundedRecursionError
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

export async function runQuerySelf(
  input: QuerySelfInput,
  _runtimeData: RuntimeData | undefined
): Promise<QuerySelfResult> {
  try {
    const db = await getDatabase();
    const service = new AgentSqlService(db);

    if (input.mode === 'listTables') {
      const tables = await service.describeTables();
      return { kind: 'tables', tables };
    }

    if (input.mode === 'describeTable') {
      const table = input.table?.trim();
      if (!table) {
        // Actionable, not generic: the model can fix this on the next turn.
        throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingTable);
      }
      const columns = await service.describeTable(table);
      return { columns, kind: 'columns', table };
    }

    const sql = input.sql?.trim();
    if (!sql) {
      throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingSql);
    }

    if (input.mode === 'explain') {
      const explained = await service.explain(sql, {
        ...(input.analyze === undefined ? {} : { analyze: input.analyze }),
      });
      return { analyzed: explained.analyzed, kind: 'plan', plan: explained.plan };
    }

    const result = await service.query(sql, {
      ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
    });

    const rows: QuerySelfRow[] = result.rows.map((row) => ({
      cells: row.map(renderCell),
    }));

    // Self-bound to the native tool output budget: return a SUCCESSFUL partial
    // result with an explicit hint rather than a size error. A short result the
    // model believes is complete would be a silent correctness failure.
    const buildResult = (kept: QuerySelfRow[]): QuerySelfQueryResult => {
      const budgetTruncated = kept.length < rows.length;
      const truncated = result.truncated || budgetTruncated;
      return {
        columns: result.columns,
        estimatedCost: result.estimatedCost,
        kind: 'rows',
        rowCount: kept.length,
        rows: kept,
        truncated,
        ...(truncated
          ? {
              hint: budgetTruncated
                ? `Showing ${kept.length} of ${rows.length} returned rows (output budget). Select fewer columns, or aggregate.`
                : `More rows matched than the ${result.maxRows}-row cap. Add a LIMIT, narrow the WHERE clause, or aggregate.`,
            }
          : {}),
      };
    };

    return fitItemsToCharBudget(rows, buildResult).result;
  } catch (error) {
    handleQuerySelfError(error);
  }
}

/**
 * Converts an input-schema validation failure into a message the model can act
 * on.
 *
 * `parseToolExecuteInput` throws a `ZodError` before `runQuerySelf` is reached,
 * and without this the model receives only the generic
 * "The tool did not complete successfully" envelope. For a tool whose entire
 * value is that the model authors the input, that is a dead end — observed
 * live, the model retried the identical malformed call and then abandoned the
 * task. The Zod issue text describes the model's own arguments, so it is safe
 * to surface and is the only thing that lets it self-correct.
 */
export function toQuerySelfInputError(error: unknown): Error {
  const issues = (error as { issues?: { message?: unknown; path?: unknown[] }[] } | null)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return error instanceof Error ? error : new Error(QUERY_SELF_ERROR_MESSAGES.queryFailed);
  }

  const detail = issues
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : null;
      const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
      return path === null ? message : `${path}: ${message}`;
    })
    .join('; ');

  return new ToolInputError(
    `Invalid querySelf input — ${detail}. Required: mode = "listTables" | "describeTable" | "query"; pass sql for mode="query", table for mode="describeTable".`
  );
}
