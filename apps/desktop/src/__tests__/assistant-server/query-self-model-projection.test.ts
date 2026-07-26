import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import { projectQuerySelfModelOutput } from '../../assistant-server/query-self-model-projection';

function serializedChars(value: { type: 'text'; value: string }): number {
  return JSON.stringify(value).length;
}

describe('querySelf model projection', () => {
  it('emits column names once and rows positionally', () => {
    const projection = projectQuerySelfModelOutput({
      columns: ['path', 'n'],
      estimatedCost: 12.5,
      kind: 'rows',
      rowCount: 2,
      rows: [{ cells: ['src/a.ts', '4'] }, { cells: ['src/b.ts', '2'] }],
      truncated: false,
    });

    expect(projection).toEqual({
      type: 'text',
      value: [
        'rows | returned=2 | truncated=false | cost=13',
        'path\tn',
        'src/a.ts\t4',
        'src/b.ts\t2',
      ].join('\n'),
    });
  });

  it('states the row cap when the source had more rows', () => {
    const projection = projectQuerySelfModelOutput({
      columns: ['id'],
      estimatedCost: 1,
      hint: 'More rows matched than the 50-row cap. Add a LIMIT, narrow the WHERE clause, or aggregate.',
      kind: 'rows',
      rowCount: 1,
      rows: [{ cells: ['1'] }],
      truncated: true,
    });

    expect(projection.value).toContain('truncated=true');
    expect(projection.value).toContain('50-row cap');
  });

  it('drops rows to fit the budget and says how many', () => {
    const wideCell = 'x'.repeat(200);
    const rows = Array.from({ length: 200 }, () => ({
      cells: [wideCell, wideCell],
    }));

    const projection = projectQuerySelfModelOutput({
      columns: ['a', 'b'],
      estimatedCost: 42,
      kind: 'rows',
      rowCount: rows.length,
      rows,
      truncated: false,
    });

    // The budget is a hard contract: central code throws above it rather than
    // prefix-truncating, so the projector must fit a complete page itself.
    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    // A silently short result would be a correctness failure, not a formatting one.
    expect(projection.value).toContain('omitted');
    expect(projection.value).toContain('truncated=true');
  });

  it('reports an unanalyzed row estimate as unknown, never a fabricated zero', () => {
    const projection = projectQuerySelfModelOutput({
      kind: 'tables',
      tables: [
        { estimatedRows: -1, name: 'brainstrike_diagnostic_events' },
        { estimatedRows: 1234, name: 'file_chunks' },
      ],
    });

    expect(projection.value).toContain('brainstrike_diagnostic_events\t~?');
    expect(projection.value).toContain('file_chunks\t~1234');
    expect(projection.value).not.toContain('~0');
  });

  it('teaches the describe → query sequence in table mode', () => {
    const projection = projectQuerySelfModelOutput({
      kind: 'tables',
      tables: [{ estimatedRows: 1, name: 'roots' }],
    });

    expect(projection.value).toContain('describe="<table>"');
  });

  it('projects column descriptions with nullability', () => {
    const projection = projectQuerySelfModelOutput({
      columns: [
        { dataType: 'text', name: 'run_id', nullable: false },
        { dataType: 'timestamp with time zone', name: 'labeled_at', nullable: true },
      ],
      kind: 'columns',
      table: 'brainstrike_assistant_run_outcomes',
    });

    expect(projection.value).toContain('run_id\ttext\tnot null');
    expect(projection.value).toContain('labeled_at\ttimestamp with time zone\tnull');
  });

  it('says an unknown table was not found instead of returning an empty list', () => {
    const projection = projectQuerySelfModelOutput({
      columns: [],
      kind: 'columns',
      table: 'nope',
    });

    expect(projection.value).toContain('not_found');
    expect(projection.value).toContain('describe=true');
  });

  it('fits a very wide column list inside the budget', () => {
    const columns = Array.from({ length: 300 }, (_unused, index) => `column_number_${index}`);

    const projection = projectQuerySelfModelOutput({
      columns,
      estimatedCost: 1,
      kind: 'rows',
      rowCount: 0,
      rows: [],
      truncated: false,
    });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
  });

  it('escapes tabs and newlines so a cell cannot forge columns or rows', () => {
    // Cell values are arbitrary database content. A raw tab would add a phantom
    // column and a raw newline a phantom row, misaligning everything after it.
    const projection = projectQuerySelfModelOutput({
      columns: ['detail', 'n'],
      estimatedCost: 1,
      kind: 'rows',
      rowCount: 1,
      rows: [{ cells: ['tab\there\nand a newline', '7'] }],
      truncated: false,
    });

    const lines = projection.value.split('\n');
    // header + columns + exactly one row
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('tab\\there\\nand a newline\t7');
  });

  it('reports clipped COLUMNS, not characters', () => {
    // The dropped unit is columns; a code-point count would tell the model
    // "430 columns clipped" for a 40-column table — a number it will reason with.
    const columns = Array.from({ length: 300 }, (_unused, index) => `column_number_${index}`);

    const projection = projectQuerySelfModelOutput({
      columns,
      estimatedCost: 1,
      kind: 'rows',
      rowCount: 0,
      rows: [],
      truncated: false,
    });

    const match = /\[(\d+) more columns\]/u.exec(projection.value);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThan(columns.length);
  });

  it('fits a huge table listing instead of throwing', () => {
    // describeTables is capped at 200 rows; at that size an unbounded list blows
    // the budget, and the RangeError would surface OUTSIDE runQuerySelf's catch
    // as an opaque failure — breaking schema discovery exactly when it matters.
    const tables = Array.from({ length: 200 }, (_unused, index) => ({
      estimatedRows: index,
      name: `a_table_with_a_fairly_long_name_number_${index}`,
    }));

    const projection = projectQuerySelfModelOutput({ kind: 'tables', tables });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toContain('more listed tables omitted');
  });

  it('fits a very wide table description instead of throwing', () => {
    const columns = Array.from({ length: 400 }, (_unused, index) => ({
      dataType: 'character varying',
      name: `a_reasonably_long_column_name_${index}`,
      nullable: index % 2 === 0,
    }));

    const projection = projectQuerySelfModelOutput({
      columns,
      kind: 'columns',
      table: 'wide',
    });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toContain('more columns omitted');
  });

  it('passes a query plan through as PostgreSQL renders it', () => {
    const projection = projectQuerySelfModelOutput({
      analyzed: true,
      kind: 'plan',
      plan: [
        'Aggregate  (cost=0.15..0.16 rows=1 width=8) (actual time=0.02..0.02 rows=1 loops=1)',
        '  ->  Seq Scan on file_records  (cost=0.00..0.12 rows=12 width=0)',
        'Execution Time: 0.061 ms',
      ],
    });

    expect(projection.value).toContain('plan | analyzed=true');
    expect(projection.value).toContain('Seq Scan on file_records');
    expect(projection.value).toContain('Execution Time');
  });

  it('fits a very deep plan instead of throwing', () => {
    const plan = Array.from(
      { length: 400 },
      (_unused, index) =>
        `  ->  Nested Loop ${index}  (cost=0.00..${index}.00 rows=${index} width=8)`
    );

    const projection = projectQuerySelfModelOutput({ analyzed: false, kind: 'plan', plan });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toContain('more plan line(s) omitted');
  });

  it('keeps the plan head AND the trailing timings when truncating', () => {
    // Plans are not uniform items: the costliest nodes are deepest (bottom) and
    // EXPLAIN ANALYZE ends with Planning/Execution Time — the numbers the model
    // asked for. Tail-dropping would remove exactly those.
    const body = Array.from(
      { length: 400 },
      (_unused, index) =>
        `  ->  Nested Loop ${index}  (cost=0.00..${index}.00 rows=${index} width=8)`
    );
    const plan = [
      'Aggregate  (cost=1.00..2.00 rows=1 width=8)',
      ...body,
      'Planning Time: 0.412 ms',
      'Execution Time: 1843.9 ms',
    ];

    const projection = projectQuerySelfModelOutput({ analyzed: true, kind: 'plan', plan });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toContain('Aggregate');
    expect(projection.value).toContain('Planning Time: 0.412 ms');
    expect(projection.value).toContain('Execution Time: 1843.9 ms');
    expect(projection.value).toContain('more plan line(s) omitted');
  });

  it('fits a plan whose INDIVIDUAL lines are enormous', () => {
    // Dropping lines cannot help when one surviving line is itself over budget:
    // the head/tail loop preserves the last PLAN_TAIL_LINES unconditionally, so
    // a single huge line reached `assertProjectionFits` and threw a RangeError —
    // from inside `toModelOutput`, OUTSIDE `runQuerySelf`'s catch, so the model
    // saw an opaque failure rather than a usable plan.
    //
    // Not hypothetical: a `Filter` on a long IN-list or a wide row-type
    // expression renders as one very long line of EXPLAIN text.
    const plan = [
      `Seq Scan on wide  (cost=0.00..1.00 rows=1 width=8)  Filter: (${'x'.repeat(9000)})`,
      `  ->  Nested Loop  Join Filter: (${'y'.repeat(9000)})`,
      'Planning Time: 0.412 ms',
      `Execution Time: 1843.9 ms  (${'z'.repeat(9000)})`,
    ];

    const projection = projectQuerySelfModelOutput({ analyzed: true, kind: 'plan', plan });

    expect(serializedChars(projection)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    // The clip is stated, and the informative prefix of each line survives.
    expect(projection.value).toContain('Seq Scan on wide');
    expect(projection.value).toContain('Planning Time: 0.412 ms');
    expect(projection.value).toContain('Execution Time: 1843.9 ms');
    expect(projection.value).toMatch(/more characters clipped/);
  });

  it('rejects a malformed result rather than projecting nonsense', () => {
    expect(() => projectQuerySelfModelOutput({ nope: true })).toThrow(TypeError);
  });
});
