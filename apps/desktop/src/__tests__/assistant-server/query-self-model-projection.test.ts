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

  it('rejects a malformed result rather than projecting nonsense', () => {
    expect(() => projectQuerySelfModelOutput({ nope: true })).toThrow(TypeError);
  });
});
