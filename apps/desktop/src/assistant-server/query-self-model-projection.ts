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

import {
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  ToolProjectionInputRejectedError,
} from '@brainstrike/agent';
import type { QuerySelfResult } from './query-self-tool';
import {
  decodedWorkspaceTextModelOutputChars as decodedChars,
  isRecord,
  makeWorkspaceTextModelOutput as makeTextModelOutput,
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
 * Finds the largest fitting prefix without serializing every shorter candidate.
 *
 * The full candidate is checked first because its zero-omission hint can differ
 * from the omission note. Once an omission is required, every candidate has
 * the same shape and adding a complete line cannot make it shorter, so binary
 * search preserves the existing "keep as much as fits" result in logarithmic
 * serialization calls.
 *
 * That monotonicity has no margin for rows: an empty added line costs two
 * serialized newline characters, while a dropped-count digit boundary can
 * reclaim one character in both the header and hint. Keep the count to at most
 * those two renderings and keep every added item as a separate line; otherwise
 * a longer prefix could serialize shorter and silently strand items that fit.
 */
function fitLargestPrefix(
  itemCount: number,
  buildLines: (kept: number) => string[],
  domainModelResultCharBudget: number
): string[] {
  const full = buildLines(itemCount);
  if (decodedChars(full) <= domainModelResultCharBudget) {
    return full;
  }

  let best = buildLines(0);
  let low = 0;
  let high = itemCount - 1;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = buildLines(kept);
    if (decodedChars(candidate) <= domainModelResultCharBudget) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
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
function fitLines(
  header: string,
  body: readonly string[],
  note: (dropped: number) => string,
  domainModelResultCharBudget: number
) {
  return fitLargestPrefix(
    body.length,
    (kept) => {
      const dropped = body.length - kept;
      return [header, ...body.slice(0, kept), ...(dropped > 0 ? [note(dropped)] : [])];
    },
    domainModelResultCharBudget
  );
}

function assertProjectionFits(lines: readonly string[], domainModelResultCharBudget: number): void {
  if (decodedChars(lines) <= domainModelResultCharBudget) {
    return;
  }
  throw new RangeError(
    `querySelf model projection exceeds the ${domainModelResultCharBudget}-character domain budget`
  );
}

function parseQuerySelfResult(output: unknown): QuerySelfResult {
  if (!isRecord(output) || typeof output['kind'] !== 'string') {
    throw new ToolProjectionInputRejectedError(
      'querySelf model projection received a malformed result'
    );
  }
  return output as unknown as QuerySelfResult;
}

function projectTables(
  result: Extract<QuerySelfResult, { kind: 'tables' }>,
  domainModelResultCharBudget: number
): string[] {
  const body = result.tables.map((table) => {
    // reltuples is -1 until a table has been analyzed; report that honestly as
    // "unknown" rather than printing a fabricated 0 row count.
    const estimate =
      table.estimatedRows === null || table.estimatedRows < 0
        ? '?'
        : String(Math.round(table.estimatedRows));
    return `${escapeCell(table.name)}${CELL_SEPARATOR}~${estimate}`;
  });
  // Model-facing next-step guidance MUST reference fields the .strict() schema
  // accepts: the pre-BST-923 wording said `describe="<table>"`, so a model that
  // followed its own tool output got a ZodError on the very next call.
  body.push(
    `next: call querySelf with target="${result.target}" mode="describeTable" table="<name>", then mode="query" with sql`
  );
  return fitLines(
    `tables | count=${result.tables.length}${result.truncated ? ' | more tables omitted by the engine row cap' : ''}`,
    body,
    (dropped) => `…${dropped} more listed tables omitted to fit the output budget`,
    domainModelResultCharBudget
  );
}

function projectLenses(
  result: Extract<QuerySelfResult, { kind: 'lenses' }>,
  domainModelResultCharBudget: number
): string[] {
  const body = result.lenses.map((lens) => {
    const params = lens.params
      .map((param) =>
        param.description.length > 0
          ? `${param.name} ${param.type} — ${param.description}`
          : `${param.name} ${param.type}`
      )
      .join('; ');
    return `${escapeCell(lens.id)}${CELL_SEPARATOR}target=${lens.target}${CELL_SEPARATOR}[${escapeCell(lens.source)}]${CELL_SEPARATOR}${escapeCell(lens.description)}${
      params.length > 0 ? `${CELL_SEPARATOR}params: ${escapeCell(params)}` : ''
    }`;
  });
  // Broken files are part of the answer: a lens author asking "why is my lens
  // not listed" must see the parse error here, not silence. Shadowing and
  // listing truncation get the same treatment — a suppressed or unread file
  // that vanishes without a line is the failure mode this feature refuses.
  for (const invalid of result.invalid) {
    body.push(
      `INVALID${CELL_SEPARATOR}${escapeCell(invalid.fileName)}${CELL_SEPARATOR}[${escapeCell(invalid.source)}]${CELL_SEPARATOR}${escapeCell(invalid.error)}`
    );
  }
  for (const item of result.shadowed) {
    body.push(
      `SHADOWED${CELL_SEPARATOR}${escapeCell(item.fileName)}${CELL_SEPARATOR}[${escapeCell(item.source)}] inactive; ${escapeCell(item.shadowedByPath)} owns this id`
    );
  }
  for (const entry of result.incompleteDirs) {
    body.push(
      `INCOMPLETE${CELL_SEPARATOR}${escapeCell(entry.dir)}${CELL_SEPARATOR}${escapeCell(entry.reason)}; some lenses were not read`
    );
  }
  body.push(
    'next: call querySelf with target="<listed target>" mode="lens" lens="<id>" values=["…"] (one string per declared param, in order)'
  );
  return fitLines(
    `lenses | count=${result.lenses.length} invalid=${result.invalid.length}`,
    body,
    (dropped) => `…${dropped} more lenses omitted to fit the output budget`,
    domainModelResultCharBudget
  );
}

function projectColumns(
  result: Extract<QuerySelfResult, { kind: 'columns' }>,
  domainModelResultCharBudget: number
): string[] {
  if (result.columns.length === 0) {
    return [
      `columns | table=${singleLine(result.table)} | not_found`,
      `no such table; call target="${result.target}" mode="listTables" to list readable tables`,
    ];
  }
  const body = result.columns.map(
    (column) =>
      `${escapeCell(column.name)}${CELL_SEPARATOR}${escapeCell(column.dataType)}${CELL_SEPARATOR}${
        column.nullable ? 'null' : 'not null'
      }`
  );
  return fitLines(
    `columns | table=${singleLine(result.table)} | count=${result.columns.length}${result.truncated ? ' | more columns omitted by the engine row cap' : ''}`,
    body,
    (dropped) => `…${dropped} more columns omitted to fit the output budget`,
    domainModelResultCharBudget
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

function projectPlan(
  result: Extract<QuerySelfResult, { kind: 'plan' }>,
  domainModelResultCharBudget: number
): string[] {
  const lines = result.plan.map((line) => clipPlanLine(escapeCell(line)));
  const header = `plan | analyzed=${result.analyzed}`;

  if (decodedChars([header, ...lines]) <= domainModelResultCharBudget) {
    return [header, ...lines];
  }

  // Plans are NOT uniform items, so plain tail-dropping is wrong here: the
  // deepest (usually costliest) nodes are at the bottom, and `Planning Time` /
  // `Execution Time` are the last two lines of EXPLAIN ANALYZE. Keep the head
  // AND the trailing summary, and drop from the middle.
  const tail = lines.slice(-PLAN_TAIL_LINES);
  const head = lines.slice(0, Math.max(0, lines.length - PLAN_TAIL_LINES));

  return fitLargestPrefix(
    head.length,
    (kept) => {
      const dropped = head.length - kept;
      return [
        header,
        ...head.slice(0, kept),
        ...(dropped > 0 ? [`…${dropped} more plan line(s) omitted to fit the output budget`] : []),
        ...tail,
      ];
    },
    domainModelResultCharBudget
  );
}

function projectRows(
  result: Extract<QuerySelfResult, { kind: 'rows' }>,
  domainModelResultCharBudget: number
): string[] {
  const header = (kept: number, dropped: number): string =>
    `rows | returned=${kept}${dropped > 0 ? ` | omitted=${dropped}` : ''} | truncated=${
      result.truncated || dropped > 0
    }${result.estimatedCost === undefined ? '' : ` | cost=${Math.round(result.estimatedCost)}`}`;

  // A pathological column list (SELECT * on a very wide table) could exceed the
  // budget on its own. Clip it rather than throwing: a RangeError here reaches
  // the model as an opaque tool failure, whereas a clipped header still tells it
  // what happened and how to narrow.
  const columnLine = clipColumnLine(result.columns.map(escapeCell), MAX_COLUMN_LINE_CHARS);
  const rowLines = result.rows.map((row) => row.cells.map(escapeCell).join(CELL_SEPARATOR));

  // Keep the largest complete prefix that fits. Equality with the budget is
  // acceptable; central code only throws ABOVE it.
  return fitLargestPrefix(
    rowLines.length,
    (kept) => {
      const dropped = rowLines.length - kept;
      const hint =
        dropped > 0
          ? `omitted ${dropped} row(s) to fit the output budget; select fewer columns or aggregate`
          : result.hint;
      return [
        header(kept, dropped),
        columnLine,
        ...rowLines.slice(0, kept),
        ...(hint ? [singleLine(hint)] : []),
      ];
    },
    domainModelResultCharBudget
  );
}

export function projectQuerySelfModelOutput(
  output: unknown,
  domainModelResultCharBudget = MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
): WorkspaceTextModelOutput {
  const result = parseQuerySelfResult(output);

  const lines =
    result.kind === 'tables'
      ? projectTables(result, domainModelResultCharBudget)
      : result.kind === 'columns'
        ? projectColumns(result, domainModelResultCharBudget)
        : result.kind === 'plan'
          ? projectPlan(result, domainModelResultCharBudget)
          : result.kind === 'lenses'
            ? projectLenses(result, domainModelResultCharBudget)
            : projectRows(result, domainModelResultCharBudget);

  assertProjectionFits(lines, domainModelResultCharBudget);
  return makeTextModelOutput(lines);
}
