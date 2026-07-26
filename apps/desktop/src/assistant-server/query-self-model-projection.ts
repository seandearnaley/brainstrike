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

/** Clips on code points WITHOUT normalizing whitespace, so tab separators survive. */
function clipPreservingTabs(value: string, maxChars: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxChars) {
    return value;
  }
  return `${codePoints.slice(0, maxChars).join('')}…[${
    codePoints.length - maxChars
  } columns clipped]`;
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
  const lines = [`tables | count=${result.tables.length}`];
  for (const table of result.tables) {
    // reltuples is -1 until a table has been analyzed; report that honestly as
    // "unknown" rather than printing a fabricated 0 row count.
    const estimate = table.estimatedRows < 0 ? '?' : String(Math.round(table.estimatedRows));
    lines.push(`${escapeCell(table.name)}${CELL_SEPARATOR}~${estimate}`);
  }
  lines.push('next: call querySelf with describe="<table>" for columns, then with sql');
  return lines;
}

function projectColumns(result: Extract<QuerySelfResult, { kind: 'columns' }>): string[] {
  if (result.columns.length === 0) {
    return [
      `columns | table=${singleLine(result.table)} | not_found`,
      'no such table in the public schema; call describe=true to list readable tables',
    ];
  }
  const lines = [`columns | table=${singleLine(result.table)} | count=${result.columns.length}`];
  for (const column of result.columns) {
    lines.push(
      `${escapeCell(column.name)}${CELL_SEPARATOR}${escapeCell(column.dataType)}${CELL_SEPARATOR}${
        column.nullable ? 'null' : 'not null'
      }`
    );
  }
  return lines;
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
  const columnLine = clipPreservingTabs(
    result.columns.map(escapeCell).join(CELL_SEPARATOR),
    MAX_COLUMN_LINE_CHARS
  );
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
        : projectRows(result);

  assertProjectionFits(lines);
  return makeTextModelOutput(lines);
}
