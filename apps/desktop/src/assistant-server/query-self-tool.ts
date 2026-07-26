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
import { AgentSqlCostRejectedError, AgentSqlInputError, AgentSqlService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantQuerySelfTool');

export const QUERY_SELF_TOOL_ID = NATIVE_TOOL_ID.querySelf;

export const QUERY_SELF_ERROR_MESSAGES = {
  missingInput: 'Provide exactly one of sql or describe.',
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

export type QuerySelfResult = QuerySelfQueryResult | QuerySelfTablesResult | QuerySelfColumnsResult;

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
  if (error instanceof AgentSqlCostRejectedError || error instanceof AgentSqlInputError) {
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

    if (input.describe !== undefined) {
      if (input.describe === true) {
        const tables = await service.describeTables();
        return { kind: 'tables', tables };
      }
      const columns = await service.describeTable(input.describe);
      return { columns, kind: 'columns', table: input.describe };
    }

    if (input.sql === undefined) {
      // Unreachable through the Zod refinement; kept as a fail-closed guard so a
      // future schema edit cannot silently produce a no-op call.
      throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingInput);
    }

    const result = await service.query(input.sql, {
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
