import { ToolInputError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDatabaseMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: () => getDatabaseMock(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
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

const { runQuerySelf, toQuerySelfInputError } = await import(
  '../../assistant-server/query-self-tool'
);

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
  it('joins admitted app SQL and suppresses its result after Stop', async () => {
    const admitted = Promise.withResolvers<void>();
    const rows = Promise.withResolvers<FakeQueryResult>();
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) => {
        if (sql.startsWith('EXPLAIN')) {
          return explainRows(1);
        }
        admitted.resolve();
        return rows.promise;
      })
    );
    const controller = new AbortController();
    const reason = new Error('User Stop');
    const outcome = runQuerySelf({ mode: 'query', sql: 'SELECT 1', target: 'app' }, undefined, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await admitted.promise;
    controller.abort(reason);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    rows.resolve({ fields: [{ name: 'n' }], rows: [[1]] });
    expect(await outcome).toBe(reason);
  });
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

    const result = await runQuerySelf(
      { mode: 'query', sql: 'SELECT path, n FROM t', target: 'app' },
      undefined
    );

    expect(result).toEqual({
      columns: ['path', 'n'],
      estimatedCost: 1.2,
      kind: 'rows',
      rowCount: 2,
      rows: [{ cells: ['src/a.ts', '4'] }, { cells: ['src/b.ts', '2'] }],
      target: 'app',
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

    const result = await runQuerySelf(
      { mode: 'query', sql: 'SELECT embedding FROM file_chunks', target: 'app' },
      undefined
    );

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

    const result = await runQuerySelf(
      { maxRows: 2, mode: 'query', sql: 'SELECT g FROM t', target: 'app' },
      undefined
    );

    expect(result).toMatchObject({ kind: 'rows', rowCount: 2, target: 'app', truncated: true });
    expect((result as { hint?: string }).hint).toContain('LIMIT');
  });

  it('passes a PostgreSQL syntax error through so the model can self-correct', async () => {
    // The error IS the product here: it names the offending token and position.
    getDatabaseMock.mockResolvedValue(
      fakeDatabase(() => {
        throw postgresError('syntax error at or near "SLECT"', '42601');
      })
    );

    await expect(
      runQuerySelf({ mode: 'query', sql: 'SLECT 1', target: 'app' }, undefined)
    ).rejects.toThrow(/syntax error at or near "SLECT"/);
    await expect(
      runQuerySelf({ mode: 'query', sql: 'SLECT 1', target: 'app' }, undefined)
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it('passes a permission-denied error through so the model learns the boundary', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase(() => {
        throw postgresError('permission denied for function pg_read_file', '42501');
      })
    );

    await expect(
      runQuerySelf({ mode: 'query', sql: `SELECT pg_read_file('x')`, target: 'app' }, undefined)
    ).rejects.toThrow(/permission denied for function pg_read_file/);
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

    const error = await runQuerySelf(
      { mode: 'query', sql: 'SELECT * FROM a, b', target: 'app' },
      undefined
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toContain('900000');
    expect((error as Error).message).toContain('50000');
  });

  it('redacts a genuinely internal failure instead of leaking it', async () => {
    // No SQLSTATE code => not a message about the model's own input.
    getDatabaseMock.mockRejectedValue(new Error('ENOENT /Users/someone/private/path'));

    const error = await runQuerySelf(
      { mode: 'query', sql: 'SELECT 1', target: 'app' },
      undefined
    ).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(ToolInputError);
    expect((error as Error).message).not.toContain('private/path');
    expect((error as Error).message).toBe('Self-query failed. Please try again.');
  });

  it('surfaces the recursion guard as an actionable message, not tool_failed', async () => {
    // Regression from a live run: the guard fired correctly but reached the
    // model as "The tool did not complete successfully", which is
    // indistinguishable from a crash — it could not tell that its recursive CTE
    // was the problem. Every AgentSqlService rejection must be model-readable.
    const { AgentSqlUnboundedRecursionError } = await import('@brainstrike/db');
    getDatabaseMock.mockResolvedValue(
      fakeDatabase(() => {
        throw new AgentSqlUnboundedRecursionError();
      })
    );

    const error = await runQuerySelf(
      {
        mode: 'query',
        sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r',
        target: 'app',
      },
      undefined
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toMatch(/termination|drain/i);
  });

  it('refuses analyze outside explain instead of silently dropping it', async () => {
    // NO SILENT FALLBACKS: analyze means "execute it for real timings". Ignoring
    // it while reporting success would discard the model's stated intent.
    getDatabaseMock.mockResolvedValue(fakeDatabase(() => ({ rows: [] })));

    const error = await runQuerySelf(
      { analyze: true, mode: 'query', sql: 'SELECT 1', target: 'app' },
      undefined
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as Error).message).toMatch(/only meaningful with mode="explain"/i);
  });

  it('tolerates analyze:false outside explain, which strict mode emits by default', async () => {
    // Providers force every declared property to be emitted, so `analyze: false`
    // arrives on ordinary queries. Rejecting THAT would repeat the outage.
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN') ? explainRows(1) : { fields: [{ name: 'n' }], rows: [[1]] }
      )
    );

    await expect(
      runQuerySelf(
        { analyze: false, mode: 'query', sql: 'SELECT 1 AS n', target: 'app' },
        undefined
      )
    ).resolves.toMatchObject({ kind: 'rows', target: 'app' });
  });

  it('returns a query plan for explain mode', async () => {
    getDatabaseMock.mockResolvedValue(
      fakeDatabase((sql) =>
        sql.startsWith('EXPLAIN')
          ? {
              rows: [
                { 'QUERY PLAN': 'Seq Scan on file_chunks  (cost=0.00..11.80 rows=1 width=412)' },
              ],
            }
          : { rows: [] }
      )
    );

    const result = await runQuerySelf(
      { mode: 'explain', sql: 'SELECT * FROM file_chunks', target: 'app' },
      undefined
    );

    expect(result).toEqual({
      analyzed: false,
      kind: 'plan',
      plan: ['Seq Scan on file_chunks  (cost=0.00..11.80 rows=1 width=412)'],
      target: 'app',
    });
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

    const result = await runQuerySelf({ mode: 'listTables', target: 'app' }, undefined);

    expect(result).toEqual({
      kind: 'tables',
      tables: [
        { estimatedRows: 1234, name: 'file_chunks' },
        { estimatedRows: -1, name: 'roots' },
      ],
      target: 'app',
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

    const result = await runQuerySelf(
      { mode: 'describeTable', table: 'run_outcomes', target: 'app' },
      undefined
    );

    expect(result).toEqual({
      columns: [
        { dataType: 'text', name: 'run_id', nullable: false },
        { dataType: 'text', name: 'detail', nullable: true },
      ],
      kind: 'columns',
      table: 'run_outcomes',
      target: 'app',
    });
  });

  describe('provider-shaped input (regressions found in a live run)', () => {
    it('accepts a call where strict function calling filled every field', {
      timeout: 30_000,
    }, async () => {
      // OpenAI strict mode forces the model to emit EVERY declared property. The
      // first design used optional sql/describe made exclusive by a .refine(),
      // and a real call arrived as {sql: ". ", maxRows: 200, describe: true} —
      // rejecting every single call. `mode` is now the sole source of truth and
      // fields the mode does not use are ignored by contract.
      getDatabaseMock.mockResolvedValue(
        fakeDatabase((sql) =>
          sql.startsWith('EXPLAIN')
            ? explainRows(1)
            : { fields: [{ name: 'name' }, { name: 'estimated_rows' }], rows: [['roots', 3]] }
        )
      );

      const result = await runQuerySelf(
        { maxRows: 200, mode: 'listTables', sql: '. ', table: 'ignored', target: 'app' },
        undefined
      );

      expect(result).toMatchObject({ kind: 'tables', target: 'app' });
    });

    it('tells the model what is missing instead of failing opaquely', async () => {
      getDatabaseMock.mockResolvedValue(fakeDatabase(() => ({ rows: [] })));

      await expect(runQuerySelf({ mode: 'query', target: 'app' }, undefined)).rejects.toThrow(
        /require a sql/i
      );
      await expect(runQuerySelf({ mode: 'explain', target: 'app' }, undefined)).rejects.toThrow(
        /require a sql/i
      );
      await expect(
        runQuerySelf({ mode: 'describeTable', target: 'app' }, undefined)
      ).rejects.toThrow(/requires a table name/i);
    });

    it('converts a schema rejection into model-correctable text', () => {
      // Observed live: a ZodError from parseToolExecuteInput surfaced as the
      // generic "The tool did not complete successfully", so the model retried the
      // identical malformed call and abandoned the task.
      const zodLike = { issues: [{ message: 'Invalid input', path: ['mode'] }] };
      const converted = toQuerySelfInputError(zodLike);

      expect(converted).toBeInstanceOf(ToolInputError);
      expect(converted.message).toContain('mode: Invalid input');
      expect(converted.message).toContain('listTables');
    });
  });
});
