import { ToolInputError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDatabaseMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: () => getDatabaseMock(),
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const { runQuerySelf } = await import('../../assistant-server/query-self-tool');

interface FakeQueryResult {
  fields?: { name: string }[];
  rows: unknown[];
}

/**
 * Minimal stand-in for the PGlite transaction surface. The REAL AgentSqlService
 * runs against it, so the sandbox preamble, the EXPLAIN gate, and the error
 * classification under test are all the production code paths — only the engine
 * is faked. Full engine-level proof lives in
 * `packages/db/__tests__/agent-sql-service.test.ts`.
 */
function fakeDatabase(handler: (sql: string) => FakeQueryResult | Promise<FakeQueryResult>) {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      await fn({
        exec: async () => await Promise.resolve(undefined),
        query: async (sql: string) => await handler(sql),
      }),
  };
}

function explainRows(totalCost: number): FakeQueryResult {
  return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': totalCost } }] }] };
}

function postgresError(message: string, code: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

beforeEach(() => {
  getDatabaseMock.mockReset();
});

describe('runQuerySelf', () => {
  it('returns column names once and rendered positional rows', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? explainRows(1.2)
          : {
              fields: [{ name: 'path' }, { name: 'n' }],
              rows: [
                ['src/a.ts', 4],
                ['src/b.ts', 2],
              ],
            }
      )
    );

    const result = await runQuerySelf({ sql: 'SELECT path, n FROM t' }, undefined);

    expect(result).toEqual({
      columns: ['path', 'n'],
      estimatedCost: 1.2,
      kind: 'rows',
      rowCount: 2,
      rows: [{ cells: ['src/a.ts', '4'] }, { cells: ['src/b.ts', '2'] }],
      truncated: false,
    });
  });

  it('renders NULL rather than dropping it', async () => {
    // "this column is null" is frequently the actual answer — for example when
    // finding chunks with no embedding — so it must be visible, not absent.
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? explainRows(1)
          : { fields: [{ name: 'embedding' }], rows: [[null]] }
      )
    );

    const result = await runQuerySelf({ sql: 'SELECT embedding FROM file_chunks' }, undefined);

    expect(result).toMatchObject({ rows: [{ cells: ['NULL'] }] });
  });

  it('flags truncation with an actionable hint when the row cap is hit', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? explainRows(1)
          : {
              fields: [{ name: 'g' }],
              // maxRows + 1 rows: the sentinel the service uses to detect more.
              rows: Array.from({ length: 3 }, (_unused, index) => [index]),
            }
      )
    );

    const result = await runQuerySelf({ maxRows: 2, sql: 'SELECT g FROM t' }, undefined);

    expect(result).toMatchObject({ kind: 'rows', rowCount: 2, truncated: true });
    expect((result as { hint?: string }).hint).toContain('LIMIT');
  });

  it('passes a PostgreSQL syntax error through so the model can self-correct', async () => {
    // The error IS the product here: it names the offending token and position.
    getDatabaseMock.mockResolvedValue(
      fakeDatabase(() => {
        throw postgresError('syntax error at or near "SLECT"', '42601');
      })
    );

    await expect(runQuerySelf({ sql: 'SLECT 1' }, undefined)).rejects.toThrow(
      /syntax error at or near "SLECT"/
    );
    await expect(runQuerySelf({ sql: 'SLECT 1' }, undefined)).rejects.toBeInstanceOf(
      ToolInputError
    );
  });

  it('passes a permission-denied error through so the model learns the boundary', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase(() => {
        throw postgresError('permission denied for function pg_read_file', '42501');
      })
    );

    await expect(runQuerySelf({ sql: `SELECT pg_read_file('x')` }, undefined)).rejects.toThrow(
      /permission denied for function pg_read_file/
    );
  });

  it('rejects an over-budget plan with the estimate and the ceiling', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) => {
        if (sql.startsWith('EXPLAIN')) {
          return explainRows(900_000);
        }
        throw new Error('the statement must never execute after a cost rejection');
      })
    );

    const error = await runQuerySelf({ sql: 'SELECT * FROM a, b' }, undefined).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toContain('900000');
    expect((error as Error).message).toContain('50000');
  });

  it('redacts a genuinely internal failure instead of leaking it', async () => {
    // No SQLSTATE code => not a message about the model's own input.
    getDatabaseMock.mockRejectedValue(new Error('ENOENT /Users/someone/private/path'));

    const error = await runQuerySelf({ sql: 'SELECT 1' }, undefined).catch(
      (caught: unknown) => caught
    );

    expect(error).not.toBeInstanceOf(ToolInputError);
    expect((error as Error).message).not.toContain('private/path');
    expect((error as Error).message).toBe('Self-query failed. Please try again.');
  });

  it('describes tables', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? explainRows(1)
          : {
              fields: [{ name: 'name' }, { name: 'estimated_rows' }],
              rows: [
                ['file_chunks', 1234],
                ['roots', -1],
              ],
            }
      )
    );

    const result = await runQuerySelf({ describe: true }, undefined);

    expect(result).toEqual({
      kind: 'tables',
      tables: [
        { estimatedRows: 1234, name: 'file_chunks' },
        { estimatedRows: -1, name: 'roots' },
      ],
    });
  });

  it('describes one table’s columns', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? explainRows(1)
          : {
              fields: [{ name: 'column_name' }, { name: 'data_type' }, { name: 'is_nullable' }],
              rows: [
                ['run_id', 'text', 'NO'],
                ['detail', 'text', 'YES'],
              ],
            }
      )
    );

    const result = await runQuerySelf({ describe: 'run_outcomes' }, undefined);

    expect(result).toEqual({
      columns: [
        { dataType: 'text', name: 'run_id', nullable: false },
        { dataType: 'text', name: 'detail', nullable: true },
      ],
      kind: 'columns',
      table: 'run_outcomes',
    });
  });
});
