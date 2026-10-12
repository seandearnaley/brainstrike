/**
 * `brainstrike.querySelf` against a REAL, fully migrated PGlite.
 *
 * WHY THIS EXISTS, given query-self-tool.test.ts already passes: that suite
 * drives a hand-written `fakeDatabase()`. It encodes what I expected the engine
 * and the provider to do — and both of the defects that reached review lived in
 * exactly that gap:
 *
 *  - the desktop client returned OBJECT rows with no `fields`, because
 *    `RemoteDbTransaction.query` had no options parameter; every production
 *    call would have failed while the fake happily returned arrays;
 *  - the sandbox rejections (privilege, syntax, recursion) were asserted by
 *    throwing hand-made errors, not by provoking PostgreSQL into producing them.
 *
 * So this file deliberately fakes as little as possible:
 *  - a real PGlite with the REAL migration set, so migration 074's role and
 *    grants are the ones under test;
 *  - reached through an adapter whose signature is EXACTLY `RemoteDbClient`'s
 *    (`readonly` params, an options bag, `{rows, fields}` back), so the service
 *    is bound to the client's shape rather than to PGlite's. That adapter
 *    IMPLEMENTS forwarding, so it does not by itself reproduce the original P1
 *    (a client that DROPPED the options bag) — the last test in this file
 *    encodes that case explicitly, and db-host-manager.test.ts covers the wire;
 *  - the real `runQuerySelf`, so mode dispatch, error classification and the
 *    output budget all run;
 *  - the real projection, fed real query output rather than a fixture.
 *
 * Only the IPC hop is absent; `db-host-manager.test.ts` covers that seam
 * separately with the fake utility process.
 */
import { ToolInputError } from '@brainstrike/assistant-contract';
import { MigrationRunner, migrations } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const getDatabaseMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: () => getDatabaseMock(),
}));

const { runQuerySelf } = await import('../../assistant-server/query-self-tool');
const { projectQuerySelfModelOutput } = await import(
  '../../assistant-server/query-self-model-projection'
);
const { wasmLoader } = await import('@brainstrike/db');

interface PGliteTransactionShape {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, params?: unknown[], options?: { rowMode?: 'array' }) => Promise<unknown>;
}

/**
 * Wraps real PGlite in the desktop remote client's EXACT surface.
 *
 * Not a convenience: `RemoteDbTransaction.query` takes
 * `(sql, params?: readonly unknown[], options?: { rowMode })` and returns
 * `{ rows, fields? }`. Binding the service to that signature — rather than to
 * PGlite's own — is what makes this test able to catch the class of bug where
 * the service works against PGlite and fails against the real client.
 */
function asRemoteClientShape(db: PGlite) {
  const wrapTx = (tx: PGliteTransactionShape) => ({
    exec: async (sql: string, params?: readonly unknown[]) =>
      params === undefined ? await tx.exec(sql) : await tx.query(sql, [...params]),
    query: async <T>(
      sql: string,
      params?: readonly unknown[],
      options?: { readonly rowMode?: 'array' }
    ) => {
      const result = (await tx.query(
        sql,
        params === undefined ? [] : [...params],
        options?.rowMode ? { rowMode: options.rowMode } : undefined
      )) as { fields?: { name: string }[]; rows: T[] };
      return {
        // Readonly on the way out, exactly like the real client.
        ...(result.fields === undefined
          ? {}
          : { fields: result.fields.map((field) => ({ name: field.name })) }),
        rows: result.rows,
      };
    },
  });

  return {
    transaction: async <T>(fn: (tx: ReturnType<typeof wrapTx>) => Promise<T>): Promise<T> =>
      await db.transaction(async (tx) => fn(wrapTx(tx))),
  };
}

let db: PGlite;

beforeAll(async () => {
  db = await wasmLoader.createPGlite(`memory://query-self-integration-${Date.now()}`);
  const runner = new MigrationRunner(db);
  await runner.initialize();
  // The FULL set: migration 074 creates the read-only role and its grants, and
  // the revokes that close pg_sleep / set_config. Nothing here is stubbed.
  await runner.up(migrations);
  getDatabaseMock.mockResolvedValue(asRemoteClientShape(db));
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('querySelf against real PGlite through the remote-client shape', () => {
  it('lists the real application tables', { timeout: 120_000 }, async () => {
    const result = await runQuerySelf({ mode: 'listTables', target: 'app' }, undefined);

    expect(result.kind).toBe('tables');
    const names = (result as { tables: { name: string }[] }).tables.map((t) => t.name);
    // Real tables created by the real migrations, not a fixture list.
    expect(names).toContain('file_chunks');
    expect(names).toContain('roots');
    expect(names).toContain('brainstrike_assistant_run_outcomes');
  });

  it('describes a real table with its real columns', { timeout: 120_000 }, async () => {
    const result = await runQuerySelf(
      { mode: 'describeTable', table: 'brainstrike_assistant_run_outcomes', target: 'app' },
      undefined
    );

    const columns = (result as { columns: { name: string; nullable: boolean }[] }).columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.has('run_id')).toBe(true);
    expect(byName.has('verdict')).toBe(true);
    // Nullability comes from the real schema: detail is nullable, run_id is not.
    expect(byName.get('run_id')?.nullable).toBe(false);
    expect(byName.get('detail')?.nullable).toBe(true);
  });

  it('returns real rows with real column names', { timeout: 120_000 }, async () => {
    await db.exec(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ('r1','path','Alpha','/alpha'), ('r2','path','Beta','/beta')`
    );

    const result = await runQuerySelf(
      {
        mode: 'query',
        sql: 'SELECT display_name, path FROM roots ORDER BY display_name',
        target: 'app',
      },
      undefined
    );

    expect(result).toMatchObject({
      columns: ['display_name', 'path'],
      kind: 'rows',
      rowCount: 2,
      target: 'app',
    });
    expect((result as { rows: { cells: string[] }[] }).rows.map((r) => r.cells)).toEqual([
      ['Alpha', '/alpha'],
      ['Beta', '/beta'],
    ]);
  });

  it('preserves duplicate column names, which object rows would collapse', {
    timeout: 120_000,
  }, async () => {
    // THE regression the fake could not express: this only works because
    // rowMode:'array' + fields survive the remote-client signature.
    const result = await runQuerySelf(
      { mode: 'query', sql: 'SELECT a.id, b.id FROM roots a, roots b LIMIT 1', target: 'app' },
      undefined
    );

    expect((result as { columns: string[] }).columns).toEqual(['id', 'id']);
    expect((result as { rows: { cells: string[] }[] }).rows[0]?.cells).toHaveLength(2);
  });

  it('renders a real NULL rather than dropping the column', { timeout: 120_000 }, async () => {
    const result = await runQuerySelf(
      { mode: 'query', sql: `SELECT last_verified_at FROM roots WHERE id = 'r1'`, target: 'app' },
      undefined
    );
    expect((result as { rows: { cells: string[] }[] }).rows[0]?.cells).toEqual(['NULL']);
  });

  describe('the sandbox, provoked from PostgreSQL rather than hand-thrown', () => {
    it('passes a REAL syntax error back to the model', { timeout: 120_000 }, async () => {
      const error = await runQuerySelf(
        { mode: 'query', sql: 'SLECT 1', target: 'app' },
        undefined
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ToolInputError);
      // PostgreSQL's own wording, not a message this test wrote.
      expect((error as Error).message).toMatch(/syntax error/i);
    });

    it('passes a REAL privilege denial back to the model', { timeout: 120_000 }, async () => {
      const error = await runQuerySelf(
        { mode: 'query', sql: `SELECT pg_read_file('postgresql.conf')`, target: 'app' },
        undefined
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as Error).message).toMatch(/permission denied for function pg_read_file/i);
    });

    it.each([
      ['write', `INSERT INTO roots (id, kind, display_name) VALUES ('x','path','x')`],
      ['DDL', 'DROP TABLE roots'],
      ['pg_sleep', 'SELECT pg_sleep(86400)'],
      ['set_config escape', `SELECT set_config('role', 'postgres', false)`],
    ])('refuses %s and leaves the connection usable', { timeout: 120_000 }, async (_l, sql) => {
      await expect(
        runQuerySelf({ mode: 'query', sql, target: 'app' }, undefined)
      ).rejects.toThrow();

      // The app's own connection still works — a wedged transaction or a leaked
      // role would take the whole single-connection database down with it.
      const after = (await db.query('SELECT count(*)::int AS n FROM roots')) as {
        rows: Array<{ n: number }>;
      };
      expect(after.rows[0]?.n).toBe(2);
      const who = (await db.query('SELECT current_user')) as {
        rows: Array<{ current_user: string }>;
      };
      expect(who.rows[0]?.current_user).toBe('postgres');
    });

    it('refuses an unbounded recursion with an actionable message', {
      timeout: 120_000,
    }, async () => {
      const error = await runQuerySelf(
        {
          mode: 'query',
          sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r',
          target: 'app',
        },
        undefined
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as Error).message).toMatch(/termination condition/i);
    });

    it('refuses a recursion whose rows a filter suppresses, through the real tool', {
      timeout: 120_000,
    }, async () => {
      // The guard's unit tests proved the SERVICE rejects this shape. This
      // proves the rejection survives the seam: it must reach the model as an
      // actionable ToolInputError, not the generic `tool_failed` that an
      // earlier version of the recursion guard produced because the new error
      // class was never added to `handleQuerySelfError`'s actionable branch.
      //
      // Asserted as a rejection on purpose — if the guard regresses, this hangs
      // the desktop integration lane rather than failing quietly.
      const error = await runQuerySelf(
        {
          mode: 'query',
          sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r WHERE n < 0',
          target: 'app',
        },
        undefined
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ToolInputError);
      expect((error as Error).message).toMatch(/termination condition/i);
    });

    it('still ALLOWS a real bounded traversal', { timeout: 120_000 }, async () => {
      const result = await runQuerySelf(
        {
          mode: 'query',
          sql: `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5)
                SELECT count(*)::int AS c FROM r`,
          target: 'app',
        },
        undefined
      );
      expect(Number((result as { rows: { cells: string[] }[] }).rows[0]?.cells[0])).toBe(5);
    });
  });

  it('REGRESSION: a client that DROPS rowMode must fail loudly, not return wrong data', {
    timeout: 120_000,
  }, async () => {
    // Honest scope note: the adapter above IMPLEMENTS option forwarding, so on
    // its own it proves the service works against the client's signature — it
    // would NOT have caught the original P1, where RemoteDbTransaction.query
    // had no options parameter and silently dropped `rowMode`.
    //
    // This case encodes that bug directly: a client that ignores the options
    // bag returns object rows with no `fields`, exactly as production did.
    // The requirement is that this SURFACES rather than quietly yielding
    // mangled columns — a wrong answer the model would have believed.
    const droppingClient = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        await db.transaction(
          async (tx) =>
            await fn({
              exec: async (sql: string) =>
                await (tx as { exec: (s: string) => Promise<unknown> }).exec(sql),
              // Note the missing third parameter — the pre-fix shape.
              query: async (sql: string, params?: readonly unknown[]) =>
                await (tx as { query: (s: string, p: unknown[]) => Promise<unknown> }).query(
                  sql,
                  params === undefined ? [] : [...params]
                ),
            })
        ),
    };
    getDatabaseMock.mockResolvedValueOnce(droppingClient);

    const outcome = await runQuerySelf(
      { mode: 'query', sql: 'SELECT display_name FROM roots ORDER BY display_name', target: 'app' },
      undefined
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const })
    );

    // Asserted STRICTLY on current behaviour rather than "either is fine":
    // a tolerant either-branch assertion is the vacuous-pass shape this whole
    // exercise has been about. Today a dropped rowMode surfaces as a failure,
    // because PGlite returns object rows that the array-shaped projection
    // cannot consume. If someone later makes object rows survivable, this
    // test MUST be updated deliberately — and the replacement has to prove
    // the columns are still correct, not merely that nothing threw.
    expect(
      outcome.ok,
      'a client that drops rowMode silently produced a result — the model would have believed it'
    ).toBe(false);
    expect((outcome as { error: unknown }).error).toBeInstanceOf(Error);
  });

  describe('explain against the real planner', () => {
    it('returns a real plan naming the real access method', { timeout: 120_000 }, async () => {
      const result = await runQuerySelf(
        { mode: 'explain', sql: 'SELECT * FROM roots WHERE path = $$/alpha$$', target: 'app' },
        undefined
      );

      const plan = (result as { plan: string[] }).plan.join('\n');
      expect(result).toMatchObject({ analyzed: false, kind: 'plan', target: 'app' });
      expect(plan).toMatch(/Scan/);
    });

    it('reports real execution timings under analyze', { timeout: 120_000 }, async () => {
      const result = await runQuerySelf(
        { analyze: true, mode: 'explain', sql: 'SELECT count(*) FROM roots', target: 'app' },
        undefined
      );

      const plan = (result as { plan: string[] }).plan.join('\n');
      expect(result).toMatchObject({ analyzed: true });
      expect(plan).toMatch(/actual time/i);
      expect(plan).toMatch(/Execution Time/i);
    });

    it('will not execute a write under analyze', { timeout: 120_000 }, async () => {
      await expect(
        runQuerySelf(
          {
            analyze: true,
            mode: 'explain',
            sql: `INSERT INTO roots (id, kind, display_name) VALUES ('sneak','path','sneak')`,
            target: 'app',
          },
          undefined
        )
      ).rejects.toThrow();

      const after = (await db.query(`SELECT count(*)::int AS n FROM roots WHERE id = 'sneak'`)) as {
        rows: Array<{ n: number }>;
      };
      expect(after.rows[0]?.n).toBe(0);
    });
  });

  describe('the projection, fed real query output', () => {
    it('projects a real result inside the model budget', { timeout: 120_000 }, async () => {
      // Every other projection test builds its input by hand. This one takes
      // whatever the real tool actually returns.
      const result = await runQuerySelf(
        {
          maxRows: 5,
          mode: 'query',
          sql: 'SELECT table_name, column_name FROM information_schema.columns ORDER BY table_name',
          target: 'app',
        },
        undefined
      );

      const projection = projectQuerySelfModelOutput(result);
      expect(JSON.stringify(projection).length).toBeLessThanOrEqual(6000);
      expect(projection.value).toMatch(/^rows \| returned=5/);
      expect(projection.value).toContain('table_name\tcolumn_name');
    });

    it('projects a real plan, keeping the timing lines', { timeout: 120_000 }, async () => {
      const result = await runQuerySelf(
        { analyze: true, mode: 'explain', sql: 'SELECT count(*) FROM roots', target: 'app' },
        undefined
      );

      const projection = projectQuerySelfModelOutput(result);
      expect(projection.value).toContain('plan | analyzed=true');
      expect(projection.value).toMatch(/Execution Time/i);
    });

    it('projects the real table listing inside budget', { timeout: 120_000 }, async () => {
      const result = await runQuerySelf({ mode: 'listTables', target: 'app' }, undefined);
      const projection = projectQuerySelfModelOutput(result);

      expect(JSON.stringify(projection).length).toBeLessThanOrEqual(6000);
      expect(projection.value).toContain('file_chunks');
    });
  });
});
