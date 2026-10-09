/**
 * The database-free half of `brainstrike.querySelf`: input checks, user lenses
 * (scanned from the request's roots through the secure fs), result shapes and
 * row rendering. The SQL itself runs through a caller-supplied read: Main runs
 * its sandboxed PGlite role and index query process directly, the desktop
 * agent host asks Main for the same read. This module must not import
 * Electron or Main's database: the host bundle loads it.
 */
import { homedir } from 'node:os';
import { fitItemsToCharBudget, type QuerySelfInput, type RuntimeData } from '@brainstrike/agent';
import {
  coerceLensValues,
  type LensParamSpec,
  type LensRequirement,
  type QuerySelfTarget,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { scanUserLenses, type UserLensScanResult } from './lens-loader';
import { createNodeFsScanDeps } from './node-fs-scan-deps';

const logger = createLogger('AssistantQuerySelfTool');

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

/** A resolved lens: its SQL and coerced values, which only ever travel as bind parameters. */
export interface QuerySelfLensInvocation {
  paramSpecs: readonly LensParamSpec[];
  params: readonly unknown[];
  requirement?: LensRequirement;
  sql: string;
}

/** One SQL read against the requested target. */
export interface QuerySelfReadRequest {
  readonly input: QuerySelfInput;
  readonly invocation?: QuerySelfLensInvocation;
}

/**
 * Runs the read and throws only model-facing failures: a `ToolInputError`
 * carrying the engine's own message, or the generic query failure.
 */
export type QuerySelfRead = (
  request: QuerySelfReadRequest,
  signal?: AbortSignal
) => Promise<QuerySelfResult>;

export interface QuerySelfCoreOptions {
  readonly scanLenses?: () => UserLensScanResult;
  readonly signal?: AbortSignal | undefined;
}

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
): QuerySelfLensInvocation {
  const id = input.lens?.trim();
  if (!id) {
    throw new ToolInputError(QUERY_SELF_ERROR_MESSAGES.missingLens);
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
      throw new ToolInputError(`Lens "${id}" exists but is invalid: ${invalid.error}`);
    }
    const available = scan.lenses.map((candidate) => candidate.id).join(', ');
    throw new ToolInputError(
      `Unknown lens "${id}". Available: ${available.length > 0 ? available : '(none)'}. Use mode="listLenses" for details.`
    );
  }
  if (lens.target !== input.target) {
    throw new ToolInputError(
      `Lens "${id}" targets "${lens.target}"; set target="${lens.target}" to run it.`
    );
  }
  const coerced = coerceLensValues(lens.params, input.values ?? []);
  if (!coerced.ok) {
    throw new ToolInputError(coerced.error);
  }
  return {
    paramSpecs: lens.params,
    params: coerced.values,
    sql: lens.sql,
    ...(lens.requirement ? { requirement: lens.requirement } : {}),
  };
}

/** A local failure is the model's to correct, or an internal one it cannot act on. */
function localQuerySelfFailure(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof ToolInputError || signal?.aborted) {
    return error instanceof Error ? error : new Error(String(error));
  }
  logger.error('Self-query tool failed', {
    error: { name: error instanceof Error ? error.name : typeof error, redacted: true },
  });
  return new Error(QUERY_SELF_ERROR_MESSAGES.queryFailed);
}

export async function runQuerySelfWith(
  input: QuerySelfInput,
  runtimeData: RuntimeData | undefined,
  read: QuerySelfRead,
  options: QuerySelfCoreOptions = {}
): Promise<QuerySelfResult> {
  options.signal?.throwIfAborted();
  const scanLenses = options.scanLenses ?? (() => scanLensesFromDisk(runtimeData?.workspaceRoots));
  let request: QuerySelfReadRequest;
  try {
    // NO SILENT FALLBACKS: `analyze` means "execute it and give me real
    // timings". Ignoring it outside explain would discard the model's stated
    // intent while still reporting success — unlike `maxRows`/`table`, where a
    // mismatch is harmless. Enforced HERE rather than as a schema refinement on
    // purpose: cross-field refinements are invisible in the emitted JSON Schema
    // and broke 100% of calls once already (see QuerySelfInputSchema).
    if (input.analyze === true && input.mode !== 'explain') {
      throw new ToolInputError(QUERY_SELF_ERROR_MESSAGES.analyzeOutsideExplain);
    }
    if (input.mode === 'listLenses') {
      // No database needed: the listing is a pure directory scan, and invalid
      // files are part of the answer.
      return toLensListing(scanLenses(), input.target);
    }
    request =
      input.mode === 'lens'
        ? { input, invocation: resolveLensInvocation(input, scanLenses()) }
        : { input };
  } catch (error) {
    throw localQuerySelfFailure(error, options.signal);
  }
  const result = await read(request, options.signal);
  // Shared app SQL is joined, not interrupted; Stop must still suppress its late result.
  options.signal?.throwIfAborted();
  return result;
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
