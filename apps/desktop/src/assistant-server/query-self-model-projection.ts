/**
 * Model-facing projection for `brainstrike.querySelf`.
 *
 * Unlike every other native tool, this result has NO fixed shape — the columns
 * are whatever the model's own SELECT produced. Two consequences drive the
 * design:
 *
 *  1. **Columns are emitted ONCE, rows as tab-separated positional values.**
 *     A per-row `{"column": value}` object would repeat every key on every row;
 *     on a 10-column, 50-row result that is ~500 redundant key repetitions
 *     inside a 6000-character budget. Positional rows keep wide results usable.
 *  2. **Rows are dropped from the END until the projection fits**, and the
 *     drop is always stated. Central code throws rather than prefix-truncating
 *     a domain projection, so this projector must fit a COMPLETE page itself —
 *     and a silently short result the model believes is complete would be a
 *     correctness failure, not merely a formatting one.
 */

import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import type { QuerySelfResult } from './query-self-tool';
import {
  isRecord,
  makeWorkspaceTextModelOutput as makeTextModelOutput,
  serializedWorkspaceTextModelOutputChars as serializedChars,
  projectionSingleLine as singleLine,
  type WorkspaceTextModelOutput,
} from './workspace-model-projection-helpers';

const CELL_SEPARATOR = '\t';

/** Ceiling for the single column-name line; well under the domain budget so
 * rows always have room. */
const MAX_COLUMN_LINE_CHARS = 1200;

/** Trailing plan lines always preserved: EXPLAIN ANALYZE ends with `Planning
 * Time` and `Execution Time`, which are the numbers the model came for. */
const PLAN_TAIL_LINES = 3;

/**
 * Ceiling for a SINGLE plan line.
 *
 * Line-dropping alone cannot bound this projection, because the head/tail loop
 * preserves `PLAN_TAIL_LINES` unconditionally. One enormous line — a `Filter` on
 * a long IN-list, a wide row-type expression — therefore survived every drop and
 * blew the budget. Chosen so the guaranteed floor (header + note + tail) stays
 * comfortably inside the 6000-character domain budget.
 */
const MAX_PLAN_LINE_CHARS = 1000;

/**
 * Escapes the two characters that carry structure in this format.
 *
 * A cell value is arbitrary database content — a `detail` column, a chunk of
 * source, a JSONB blob — and a raw tab or newline inside one would forge an
 * extra column or an extra row, silently misaligning every value the model
 * reads. The generic `clipProjectionEnd` helper is NOT usable here: it
 * normalizes all whitespace to single spaces, which destroys the separator
 * itself.
 */
function escapeCell(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\t/gu, '\\t')
    .replace(/\r/gu, '\\r')
    .replace(/\n/gu, '\\n');
}

/**
 * Clips a tab-separated column list on WHOLE columns.
 *
 * Two things matter here. It must not normalize whitespace (the generic helper
 * does, which would destroy the tab separators), and it must report a count the
 * model can reason with: the dropped unit is COLUMNS, so counting code points
 * would tell it "430 columns clipped" for a 40-column table.
 */
function clipColumnLine(columns: readonly string[], maxChars: number): string {
  const joined = columns.join(CELL_SEPARATOR);
  if (Array.from(joined).length <= maxChars) {
    return joined;
  }
  let kept = columns.length;
  while (kept > 0 && Array.from(columns.slice(0, kept).join(CELL_SEPARATOR)).length > maxChars) {
    kept -= 1;
  }
  return `${columns.slice(0, kept).join(CELL_SEPARATOR)}…[${columns.length - kept} more columns]`;
}

/**
 * Drops trailing lines until the whole projection fits, appending a note that
 * says how many were dropped.
 *
 * `projectRows` needs this, and so do the describe branches: without it they
 * build an unbounded list and hit `assertProjectionFits`, whose `RangeError` is
 * thrown inside `toModelOutput` — OUTSIDE `runQuerySelf`'s catch — so it reaches
 * the model as an opaque failure with no hint. That would break schema
 * discovery, the thing that makes this tool usable, precisely when the schema is
 * largest.
 */
function fitLines(header: string, body: readonly string[], note: (dropped: number) => string) {
  let kept = body.length;
  for (;;) {
    const dropped = body.length - kept;
    const lines = [header, ...body.slice(0, kept), ...(dropped > 0 ? [note(dropped)] : [])];
    if (serializedChars(lines) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET || kept === 0) {
      return lines;
    }
    kept -= 1;
  }
}

function assertProjectionFits(lines: readonly string[]): void {
  if (serializedChars(lines) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    return;
  }
  throw new RangeError(
    `querySelf model projection exceeds the ${MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET}-character domain budget`
  );
}

function parseQuerySelfResult(output: unknown): QuerySelfResult {
  if (!isRecord(output) || typeof output['kind'] !== 'string') {
    throw new TypeError('querySelf model projection received a malformed result');
  }
  return output as unknown as QuerySelfResult;
}

function projectTables(result: Extract<QuerySelfResult, { kind: 'tables' }>): string[] {
  const body = result.tables.map((table) => {
    // reltuples is -1 until a table has been analyzed; report that honestly as
    // "unknown" rather than printing a fabricated 0 row count.
    const estimate = table.estimatedRows < 0 ? '?' : String(Math.round(table.estimatedRows));
    return `${escapeCell(table.name)}${CELL_SEPARATOR}~${estimate}`;
  });
  body.push('next: call querySelf with describe="<table>" for columns, then with sql');
  return fitLines(
    `tables | count=${result.tables.length}`,
    body,
    (dropped) => `…${dropped} more listed tables omitted to fit the output budget`
  );
}

function projectColumns(result: Extract<QuerySelfResult, { kind: 'columns' }>): string[] {
  if (result.columns.length === 0) {
    return [
      `columns | table=${singleLine(result.table)} | not_found`,
      'no such table in the public schema; call describe=true to list readable tables',
    ];
  }
  const body = result.columns.map(
    (column) =>
      `${escapeCell(column.name)}${CELL_SEPARATOR}${escapeCell(column.dataType)}${CELL_SEPARATOR}${
        column.nullable ? 'null' : 'not null'
      }`
  );
  return fitLines(
    `columns | table=${singleLine(result.table)} | count=${result.columns.length}`,
    body,
    (dropped) => `…${dropped} more columns omitted to fit the output budget`
  );
}

/**
 * Plan output is already PostgreSQL's own indented text, which is both the most
 * information-dense form and the one the model has seen most of in training —
 * so it is passed through structurally, only budget-fitted.
 */
/**
 * Clips one plan line, stating the unit truthfully.
 *
 * Characters ARE the unit here — unlike the column line, a plan line has no
 * inner structure to drop whole items of — so counting code points is honest.
 * The prefix is kept because EXPLAIN puts the node type, cost, and row estimate
 * first and the long expression last.
 */
function clipPlanLine(line: string): string {
  const points = Array.from(line);
  if (points.length <= MAX_PLAN_LINE_CHARS) {
    return line;
  }
  return `${points.slice(0, MAX_PLAN_LINE_CHARS).join('')}…[${
    points.length - MAX_PLAN_LINE_CHARS
  } more characters clipped]`;
}

function projectPlan(result: Extract<QuerySelfResult, { kind: 'plan' }>): string[] {
  const lines = result.plan.map((line) => clipPlanLine(escapeCell(line)));
  const header = `plan | analyzed=${result.analyzed}`;

  if (serializedChars([header, ...lines]) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET) {
    return [header, ...lines];
  }

  // Plans are NOT uniform items, so plain tail-dropping is wrong here: the
  // deepest (usually costliest) nodes are at the bottom, and `Planning Time` /
  // `Execution Time` are the last two lines of EXPLAIN ANALYZE. Keep the head
  // AND the trailing summary, and drop from the middle.
  const tail = lines.slice(-PLAN_TAIL_LINES);
  const head = lines.slice(0, Math.max(0, lines.length - PLAN_TAIL_LINES));

  let kept = head.length;
  for (;;) {
    const dropped = head.length - kept;
    const candidate = [
      header,
      ...head.slice(0, kept),
      ...(dropped > 0 ? [`…${dropped} more plan line(s) omitted to fit the output budget`] : []),
      ...tail,
    ];
    if (serializedChars(candidate) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET || kept === 0) {
      return candidate;
    }
    kept -= 1;
  }
}

function projectRows(result: Extract<QuerySelfResult, { kind: 'rows' }>): string[] {
  const header = (kept: number, dropped: number): string =>
    `rows | returned=${kept}${dropped > 0 ? ` | omitted=${dropped}` : ''} | truncated=${
      result.truncated || dropped > 0
    } | cost=${Math.round(result.estimatedCost)}`;

  // A pathological column list (SELECT * on a very wide table) could exceed the
  // budget on its own. Clip it rather than throwing: a RangeError here reaches
  // the model as an opaque tool failure, whereas a clipped header still tells it
  // what happened and how to narrow.
  const columnLine = clipColumnLine(result.columns.map(escapeCell), MAX_COLUMN_LINE_CHARS);
  const rowLines = result.rows.map((row) => row.cells.map(escapeCell).join(CELL_SEPARATOR));

  let kept = rowLines.length;
  let lines: string[] = [];

  // Drop from the end until the whole projection fits. Equality with the budget
  // is acceptable; central code only throws ABOVE it.
  for (;;) {
    const dropped = rowLines.length - kept;
    const hint =
      dropped > 0
        ? `omitted ${dropped} row(s) to fit the output budget; select fewer columns or aggregate`
        : result.hint;
    lines = [
      header(kept, dropped),
      columnLine,
      ...rowLines.slice(0, kept),
      ...(hint ? [singleLine(hint)] : []),
    ];
    if (serializedChars(lines) <= MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET || kept === 0) {
      break;
    }
    kept -= 1;
  }

  return lines;
}

export function projectQuerySelfModelOutput(output: unknown): WorkspaceTextModelOutput {
  const result = parseQuerySelfResult(output);

  const lines =
    result.kind === 'tables'
      ? projectTables(result)
      : result.kind === 'columns'
        ? projectColumns(result)
        : result.kind === 'plan'
          ? projectPlan(result)
          : projectRows(result);

  assertProjectionFits(lines);
  return makeTextModelOutput(lines);
}
