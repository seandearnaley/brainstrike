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

import { homedir } from 'node:os';
import { fitItemsToCharBudget, type QuerySelfInput, type RuntimeData } from '@brainstrike/agent';
import {
  coerceLensValues,
  type LensParamSpec,
  type LensRequirement,
  NATIVE_TOOL_ID,
  type QuerySelfTarget,
  ToolInputError,
} from '@brainstrike/assistant-contract';
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
import { scanUserLenses, type UserLensScanResult } from './lens-loader';
import { createNodeFsScanDeps } from './node-fs-scan-deps';
import { type QuerySelfIndexClient, runIndexQuerySelf } from './query-self-index-tool';

const logger = createLogger('AssistantQuerySelfTool');

export const QUERY_SELF_TOOL_ID = NATIVE_TOOL_ID.querySelf;

export const QUERY_SELF_ERROR_MESSAGES = {
  analyzeOutsideExplain:
    'analyze is only meaningful with mode="explain". Set mode="explain" to execute the statement for real timings, or drop analyze.',
  missingLens: 'mode="lens" requires a lens id. Use mode="listLenses" to see them.',
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
  estimatedCost?: number;
  hint?: string;
  kind: 'rows';
  rowCount: number;
  rows: QuerySelfRow[];
  target: QuerySelfTarget;
  truncated: boolean;
}

export interface QuerySelfTablesResult {
  kind: 'tables';
  tables: { estimatedRows: number | null; name: string }[];
  target: QuerySelfTarget;
  truncated?: boolean;
}

export interface QuerySelfColumnsResult {
  columns: { dataType: string; name: string; nullable: boolean }[];
  kind: 'columns';
  table: string;
  target: QuerySelfTarget;
  truncated?: boolean;
}

export interface QuerySelfPlanResult {
  /** True when the statement was executed to collect real timings. */
  analyzed: boolean;
  kind: 'plan';
  /** PostgreSQL's own indented plan text, one entry per output row. */
  plan: string[];
  target: QuerySelfTarget;
}

export interface QuerySelfLensesResult {
  /** Directories not fully scanned, with why. */
  incompleteDirs: { dir: string; reason: string }[];
  /** Broken lens files, VISIBLE with their parse errors (fail closed, never silent). */
  invalid: { error: string; fileName: string; source: string }[];
  kind: 'lenses';
  lenses: {
    description: string;
    id: string;
    target: QuerySelfTarget;
    requirement?: LensRequirement;
    params: { description: string; name: string; type: string }[];
    /** Owning root id, or 'global' for `~/.brainstrike` — "which file is
     * this" is the load-bearing fact for a reviewable artifact. */
    source: string;
  }[];
  /** Same-id files suppressed by first-wins — shadowing must be visible,
   * naming the file that WON (skill-scan / persona-loader shape). */
  shadowed: { fileName: string; shadowedByPath: string; source: string }[];
  target: QuerySelfTarget;
}

export type QuerySelfResult =
  | QuerySelfQueryResult
  | QuerySelfTablesResult
  | QuerySelfColumnsResult
  | QuerySelfPlanResult
  | QuerySelfLensesResult;

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

/**
 * Scan lenses from disk over the request's already-resolved workspace roots
 * (SecureRoot-backed fs; disposed after the scan). Mirrors
 * `scanUserPersonasFromDisk` in assistant-server/agent-stream-init.ts.
 */
function scanLensesFromDisk(workspaceRoots: RuntimeData['workspaceRoots']): UserLensScanResult {
  const filesystem = createNodeFsScanDeps();
  try {
    const scanRoots = (workspaceRoots ?? [])
      .filter((root) => Boolean(root.path))
      .map((root) => ({
        absPath: root.path,
        displayName: root.displayName,
        id: root.rootId,
      }));
    return scanUserLenses({ homeDir: homedir(), roots: scanRoots }, filesystem);
  } finally {
    filesystem.dispose();
  }
}

function toLensListing(scan: UserLensScanResult, target: QuerySelfTarget): QuerySelfLensesResult {
  const sourceOf = (rootId: string | undefined): string => rootId ?? 'global';
  const okEntries = scan.entries.filter((entry) => entry.status === 'ok');
  return {
    incompleteDirs: scan.incompleteDirs.map((entry) => ({
      dir: entry.dir,
      reason: entry.reason,
    })),
    invalid: scan.entries
      .filter((entry) => entry.status === 'invalid')
      .map((entry) => ({
        error: entry.error,
        fileName: entry.fileName,
        source: sourceOf(entry.sourceRootId),
      })),
    kind: 'lenses',
    lenses: okEntries.map((entry) => ({
      description: entry.lens.description,
      ...(entry.lens.requirement ? { requirement: entry.lens.requirement } : {}),
      id: entry.lens.id,
      params: entry.lens.params.map((param: LensParamSpec) => ({
        description: param.description,
        name: param.name,
        type: param.type,
      })),
      source: sourceOf(entry.sourceRootId),
      target: entry.lens.target,
    })),
    shadowed: scan.entries
      .filter((entry) => entry.status === 'shadowed')
      .map((entry) => ({
        fileName: entry.fileName,
        shadowedByPath: entry.shadowedBy.absPath,
        source: sourceOf(entry.sourceRootId),
      })),
    target,
  };
}

/**
 * Resolve a lens invocation to `{ sql, params }`. The lens file already passed
 * the parse-time placeholder discipline; values arrive as positional strings
 * and are coerced by the DECLARED types — both failure shapes are
 * model-correctable input errors, and the values themselves only ever travel
 * as bind parameters (never interpolated into the SQL).
 */
function resolveLensInvocation(
  input: QuerySelfInput,
  scan: UserLensScanResult
): {
  params: readonly unknown[];
  sql: string;
  requirement?: LensRequirement;
  paramSpecs: readonly LensParamSpec[];
} {
  const id = input.lens?.trim();
  if (!id) {
    throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.missingLens);
  }
  const lens = scan.lenses.find((candidate) => candidate.id === id);
  if (!lens) {
    // A broken file RESERVES its id (a malformed project lens must never
    // silently fall through to a same-named global one), so the honest
    // answer here is the parse error, not "unknown".
    const invalid = scan.entries.find(
      (entry) => entry.status === 'invalid' && entry.fileName.replace(/\.sql$/i, '') === id
    );
    if (invalid && invalid.status === 'invalid') {
      throw new AgentSqlInputError(`Lens "${id}" exists but is invalid: ${invalid.error}`);
    }
    const available = scan.lenses.map((candidate) => candidate.id).join(', ');
    throw new AgentSqlInputError(
      `Unknown lens "${id}". Available: ${available.length > 0 ? available : '(none)'}. Use mode="listLenses" for details.`
    );
  }
  if (lens.target !== input.target) {
    throw new AgentSqlInputError(
      `Lens "${id}" targets "${lens.target}"; set target="${lens.target}" to run it.`
    );
  }
  const coerced = coerceLensValues(lens.params, input.values ?? []);
  if (!coerced.ok) {
    throw new AgentSqlInputError(coerced.error);
  }
  return {
    paramSpecs: lens.params,
    params: coerced.values,
    sql: lens.sql,
    ...(lens.requirement ? { requirement: lens.requirement } : {}),
  };
}

/** Test seam: inject the lens scan; production scans the request's roots. */
export interface QuerySelfToolOptions {
  readonly openIndexQuery?: (signal?: AbortSignal) => Promise<QuerySelfIndexClient>;
  readonly scanLenses?: () => UserLensScanResult;
  readonly signal?: AbortSignal | undefined;
}

export async function runQuerySelf(
  input: QuerySelfInput,
  runtimeData: RuntimeData | undefined,
  options: QuerySelfToolOptions = {}
): Promise<QuerySelfResult> {
  options.signal?.throwIfAborted();
  const result = await executeQuerySelf(input, runtimeData, options);
  // Shared app SQL is joined, not interrupted; Stop must still suppress its late result.
  options.signal?.throwIfAborted();
  return result;
}

async function executeQuerySelf(
  input: QuerySelfInput,
  runtimeData: RuntimeData | undefined,
  options: QuerySelfToolOptions = {}
): Promise<QuerySelfResult> {
  const scanLenses = options.scanLenses ?? (() => scanLensesFromDisk(runtimeData?.workspaceRoots));
  try {
    // NO SILENT FALLBACKS: `analyze` means "execute it and give me real
    // timings". Ignoring it outside explain would discard the model's stated
    // intent while still reporting success — unlike `maxRows`/`table`, where a
    // mismatch is harmless. Enforced HERE rather than as a schema refinement on
    // purpose: cross-field refinements are invisible in the emitted JSON Schema
    // and broke 100% of calls once already (see QuerySelfInputSchema).
    if (input.analyze === true && input.mode !== 'explain') {
      throw new AgentSqlInputError(QUERY_SELF_ERROR_MESSAGES.analyzeOutsideExplain);
    }

    if (input.mode === 'listLenses') {
      // No database needed: the listing is a pure directory scan, and invalid
      // files are part of the answer.
      return toLensListing(scanLenses(), input.target);
    }

    const invocation =
      input.mode === 'lens' ? resolveLensInvocation(input, scanLenses()) : undefined;
    if (input.target === 'index') {
      return await runIndexQuerySelf(input, invocation, options.openIndexQuery, options.signal);
    }
    if (input.target !== 'app') {
      throw new AgentSqlInputError('querySelf requires target="app" or target="index".');
    }
    const db = await getDatabase();
    options.signal?.throwIfAborted();
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
  } catch (error) {
    handleQuerySelfError(error, options.signal);
  }
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

export function shapeQuerySelfRows(
  result: {
    columns: readonly string[];
    rows: readonly (readonly unknown[])[];
    truncated: boolean;
    estimatedCost?: number;
  },
  maxRows: number,
  target: QuerySelfTarget
): QuerySelfQueryResult {
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
      columns: [...result.columns],
      ...(result.estimatedCost === undefined ? {} : { estimatedCost: result.estimatedCost }),
      kind: 'rows',
      rowCount: kept.length,
      rows: kept,
      target,
      truncated,
      ...(truncated
        ? {
            hint: budgetTruncated
              ? `Showing ${kept.length} of ${rows.length} returned rows (output budget). Select fewer columns, or aggregate.`
              : `More rows matched than the ${maxRows}-row cap. Add a LIMIT, narrow the WHERE clause, or aggregate.`,
          }
        : {}),
    };
  };

  return fitItemsToCharBudget(rows, buildResult).result;
}

/**
 * Converts an input-schema validation failure into a message the model can act
 * on.
 *
 * `parseToolExecuteInput` throws a `ToolInputValidationError` (compact
 * single-line message, raw Zod `issues` attached) before `runQuerySelf` is
 * reached, and without this the model receives only the generic
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
    `Invalid querySelf input — ${detail}. Required: target = "app" | "index"; mode = "listTables" | "describeTable" | "query" | "explain" | "listLenses" | "lens"; pass sql for mode="query" or "explain", table for mode="describeTable", lens (+ values) for mode="lens".`
  );
}
