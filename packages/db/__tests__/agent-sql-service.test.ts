import {
  NATIVE_TOOL_ID,
  QUERY_SELF_EXAMPLE_QUERIES,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/assistant-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  AGENT_READONLY_ROLE,
  AgentSqlCostRejectedError,
  AgentSqlInputError,
  AgentSqlService,
  AgentSqlUnboundedRecursionError,
} from '../src/search/agent-sql-service.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface SandboxTx {
  query: <T>(sql: string) => Promise<{ rows: T[] }>;
}

/**
 * The agent SQL sandbox is FOUR independent, engine-enforced layers. Each test
 * below pins one of them, and each layer is load-bearing on its own:
 *
 *  1. read-only transaction  → blocks writes and DDL
 *  2. non-superuser role     → blocks file reads, COPY TO PROGRAM, pg_authid
 *  3. extended protocol      → blocks multi-statement text
 *  4. EXPLAIN cost gate      → blocks runaway plans (PGlite has NO working
 *                              statement_timeout — see agent-self-query.md)
 *
 * Deleting any one of these tests deletes the proof for a distinct escalation.
 */
describe('AgentSqlService sandbox', () => {
  let db: PGlite;
  let service: AgentSqlService;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-agent-sql-service');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    service = new AgentSqlService(db);
  }, 240_000);

  afterEach(async () => {
    await db.close();
  });

  /**
   * The subquery wrapper (`SELECT * FROM (<sql>) …`) means a non-SELECT
   * statement fails to PARSE before the read-only transaction or the role are
   * consulted. That is a real structural constraint — only an expression valid
   * in a FROM clause can be planned at all — but it is the PROXIMATE cause of
   * rejection, not the whole defense.
   *
   * These tests therefore pin the outcome (rejected) rather than the message.
   * The deeper layers are proven independently in "defense in depth" below, so
   * that changing the wrapper can never silently remove them.
   */
  describe('non-read statements are rejected', () => {
    it.each([
      ['INSERT', `INSERT INTO file_records (id, name, path) VALUES ('x', 'x', 'x')`],
      ['UPDATE', `UPDATE file_records SET name = 'x'`],
      ['DELETE', 'DELETE FROM file_records'],
      ['CREATE TABLE', 'CREATE TABLE evil (id int)'],
      ['DROP TABLE', 'DROP TABLE file_records'],
      ['ALTER TABLE', 'ALTER TABLE file_records ADD COLUMN evil int'],
      ['GRANT', 'GRANT ALL ON file_records TO brainstrike_agent_readonly'],
      ['COPY TO PROGRAM', `COPY file_records TO PROGRAM 'cat'`],
    ])('rejects %s', { timeout: 120_000 }, async (_label, sql) => {
      await expect(service.query(sql)).rejects.toThrow();
    });

    it('rejects a data-modifying CTE', { timeout: 120_000 }, async () => {
      // The nastiest shape: syntactically a SELECT, but PostgreSQL allows
      // data-modifying CTEs only at the top level of a statement — and the
      // read-only transaction blocks the write regardless.
      await expect(
        service.query(
          `WITH w AS (INSERT INTO file_records (id, name, path) VALUES ('x','x','x') RETURNING id)
           SELECT * FROM w`
        )
      ).rejects.toThrow();

      const rows = await service.query(
        `SELECT count(*)::int AS n FROM file_records WHERE id = 'x'`
      );
      expect(Number(rows.rows[0]?.[0])).toBe(0);
    });
  });

  describe('layer 2: non-superuser role (through the real service path)', () => {
    it('rejects pg_read_file', { timeout: 120_000 }, async () => {
      await expect(service.query(`SELECT pg_read_file('postgresql.conf')`)).rejects.toThrow(
        /permission denied for function pg_read_file/i
      );
    });

    it('rejects pg_ls_dir', { timeout: 120_000 }, async () => {
      await expect(service.query(`SELECT pg_ls_dir('.')`)).rejects.toThrow(
        /permission denied for function pg_ls_dir/i
      );
    });

    it('rejects reads of pg_authid', { timeout: 120_000 }, async () => {
      await expect(service.query('SELECT rolname FROM pg_authid')).rejects.toThrow(
        /permission denied for table pg_authid/i
      );
    });

    it('runs the statement as the restricted role', { timeout: 120_000 }, async () => {
      const result = await service.query('SELECT current_user AS who');
      expect(result.rows[0]?.[0]).toBe(AGENT_READONLY_ROLE);
    });

    it('does not leak the role to later queries', { timeout: 120_000 }, async () => {
      await service.query('SELECT 1');
      const after = await db.query<{ current_user: string }>('SELECT current_user');
      expect(after.rows[0]?.current_user).toBe('postgres');
    });
  });

  /**
   * The cost gate is a PLANNER-cost gate: it catches statements expensive to
   * PLAN, not statements cheap to plan and unbounded to EXECUTE. These close the
   * two verified escapes of that class at the privilege layer instead, which is
   * the only engine-enforced place they can be closed.
   */
  describe('cheap-to-plan, unbounded-to-execute escapes are revoked', () => {
    it.each([
      ['pg_sleep', 'SELECT pg_sleep(86400)'],
      ['pg_sleep_for', `SELECT pg_sleep_for('1 day')`],
      ['pg_sleep_until', `SELECT pg_sleep_until(now() + interval '1 day')`],
    ])('rejects %s', { timeout: 120_000 }, async (_label, sql) => {
      // Measured cost of the wrapped plan is 0.01 — six orders of magnitude
      // below the ceiling — so ONLY the privilege revoke stops this. PGlite has
      // no working statement_timeout and one connection, so admitting it would
      // freeze the entire application for the requested duration.
      await expect(service.query(sql)).rejects.toThrow(/permission denied for function pg_sleep/i);
    });

    it('rejects set_config, which can escape SET LOCAL', { timeout: 120_000 }, async () => {
      await expect(
        service.query(`SELECT set_config('role', '${AGENT_READONLY_ROLE}', false)`)
      ).rejects.toThrow(/permission denied for function set_config/i);
    });

    it('leaves the shared connection usable after a GUC-escape attempt', {
      timeout: 120_000,
    }, async () => {
      // The regression this pins: with is_local => false the session value
      // survives the transaction, stranding the SHARED PGlite connection as
      // the restricted role. Every later app write then fails permanently.
      await expect(
        service.query(`SELECT set_config('role', '${AGENT_READONLY_ROLE}', false)`)
      ).rejects.toThrow();

      const who = await db.query<{ current_user: string }>('SELECT current_user');
      expect(who.rows[0]?.current_user).toBe('postgres');

      await expect(
        db.exec(
          `INSERT INTO roots (id, kind, display_name, path) VALUES ('probe', 'path', 'probe', '/probe')`
        )
      ).resolves.toBeDefined();
    });
  });

  describe('layer 3: single statement only', () => {
    it('rejects multi-statement input', { timeout: 120_000 }, async () => {
      await expect(service.query('SELECT 1; SELECT 2')).rejects.toThrow();
    });

    it('rejects a second statement appended after a trailing semicolon', {
      timeout: 120_000,
    }, async () => {
      // We strip ONE trailing semicolon so `SELECT 1;` works. Prove that the
      // strip cannot be abused to smuggle a second statement past the wrapper.
      await expect(service.query('SELECT 1; DROP TABLE file_records;')).rejects.toThrow();

      const still = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'file_records'`
      );
      expect(still.rows[0]?.n).toBe(1);
    });

    it('rejects empty sql', { timeout: 120_000 }, async () => {
      await expect(service.query('   ')).rejects.toBeInstanceOf(AgentSqlInputError);
    });
  });

  /**
   * The wrapper is the outermost layer, and the tests above only reach it. These
   * drive the transaction preamble DIRECTLY — the same `SET TRANSACTION READ
   * ONLY` + `SET LOCAL ROLE` the service issues — so the layers underneath are
   * proven to hold on their own.
   *
   * If someone ever changes the wrapper (for example to support `EXPLAIN` or
   * `VALUES` at the top level), these are what stop that from silently becoming
   * a privilege escalation.
   */
  describe('defense in depth: the transaction preamble alone blocks escalation', () => {
    async function inSandbox<T>(fn: (tx: SandboxTx) => Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec(`SET LOCAL ROLE ${AGENT_READONLY_ROLE}`);
        return await fn(tx as unknown as SandboxTx);
      });
    }

    it.each([
      ['INSERT', `INSERT INTO file_records (id, name, path) VALUES ('x','x','x')`],
      ['UPDATE', `UPDATE file_records SET name = 'x'`],
      ['DELETE', 'DELETE FROM file_records'],
      ['CREATE TABLE', 'CREATE TABLE evil (id int)'],
      ['DROP TABLE', 'DROP TABLE file_records'],
    ])('read-only transaction blocks unwrapped %s', { timeout: 120_000 }, async (_label, sql) => {
      await expect(inSandbox(async (tx) => await tx.query(sql))).rejects.toThrow(
        /read-only transaction|permission denied/i
      );
    });

    it('the role blocks unwrapped COPY TO PROGRAM', { timeout: 120_000 }, async () => {
      await expect(
        inSandbox(async (tx) => await tx.query(`COPY file_records TO PROGRAM 'cat'`))
      ).rejects.toThrow(/permission denied|read-only transaction/i);
    });

    it('the role blocks unwrapped pg_read_file', { timeout: 120_000 }, async () => {
      await expect(
        inSandbox(async (tx) => await tx.query(`SELECT pg_read_file('postgresql.conf')`))
      ).rejects.toThrow(/permission denied for function pg_read_file/i);
    });
  });

  describe('layer 4: EXPLAIN cost gate', () => {
    it('rejects a runaway cartesian plan', { timeout: 120_000 }, async () => {
      const runaway = 'SELECT count(*) FROM generate_series(1,6000) a, generate_series(1,6000) b';
      await expect(service.query(runaway)).rejects.toBeInstanceOf(AgentSqlCostRejectedError);
    });

    it('reports the estimated cost and the ceiling so the model can narrow', {
      timeout: 120_000,
    }, async () => {
      const runaway = 'SELECT count(*) FROM generate_series(1,6000) a, generate_series(1,6000) b';
      const error = await service.query(runaway).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AgentSqlCostRejectedError);
      const rejected = error as AgentSqlCostRejectedError;
      expect(rejected.estimatedCost).toBeGreaterThan(rejected.costCeiling);
      expect(rejected.message).toContain(String(Math.round(rejected.costCeiling)));
    });

    it('admits an ordinary full scan with an aggregate', { timeout: 120_000 }, async () => {
      // Guards the other direction: a ceiling that blocks legitimate analysis is
      // as much of a bug as one that admits a cartesian product.
      const result = await service.query(
        'SELECT count(*) AS n FROM (SELECT * FROM generate_series(1, 50000)) s'
      );
      expect(Number(result.rows[0]?.[0])).toBe(50_000);
    });
  });

  describe('result shaping', () => {
    it('returns columns once and rows as arrays', { timeout: 120_000 }, async () => {
      const result = await service.query(`SELECT 1 AS a, 'two' AS b`);
      expect(result.columns).toEqual(['a', 'b']);
      expect(result.rows).toEqual([[1, 'two']]);
    });

    it('preserves duplicate column names', { timeout: 120_000 }, async () => {
      // Object-keyed rows would silently collapse these into one value.
      const result = await service.query(
        'SELECT x.id, y.id FROM (SELECT 1 AS id) x, (SELECT 2 AS id) y'
      );
      expect(result.columns).toEqual(['id', 'id']);
      expect(result.rows).toEqual([[1, 2]]);
    });

    it('caps rows and flags truncation', { timeout: 120_000 }, async () => {
      const result = await service.query('SELECT g FROM generate_series(1, 100) g', {
        maxRows: 10,
      });
      expect(result.rows).toHaveLength(10);
      expect(result.truncated).toBe(true);
    });

    it('does not flag truncation when the result fits', { timeout: 120_000 }, async () => {
      const result = await service.query('SELECT g FROM generate_series(1, 5) g', {
        maxRows: 10,
      });
      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(false);
    });

    it('supports CTEs through the LIMIT wrapper', { timeout: 120_000 }, async () => {
      const result = await service.query(
        'WITH c AS (SELECT g FROM generate_series(1, 3) g) SELECT * FROM c'
      );
      expect(result.rows).toEqual([[1], [2], [3]]);
    });

    it('rejects a maxRows above the hard cap', { timeout: 120_000 }, async () => {
      await expect(service.query('SELECT 1', { maxRows: 5000 })).rejects.toBeInstanceOf(
        AgentSqlInputError
      );
    });
  });

  describe('transaction hygiene', () => {
    it('leaves the database usable after a failing query', { timeout: 120_000 }, async () => {
      await expect(service.query('SELECT nonexistent_column')).rejects.toThrow();

      // A wedged open transaction would take the single PGlite connection —
      // and therefore the whole app — down with it.
      const after = await db.query<{ n: number }>('SELECT 1::int AS n');
      expect(after.rows[0]?.n).toBe(1);
    });

    it('leaves the database usable after a cost rejection', { timeout: 120_000 }, async () => {
      await expect(
        service.query('SELECT count(*) FROM generate_series(1,6000) a, generate_series(1,6000) b')
      ).rejects.toBeInstanceOf(AgentSqlCostRejectedError);

      const after = await db.query<{ n: number }>('SELECT 1::int AS n');
      expect(after.rows[0]?.n).toBe(1);
    });
  });

  describe('the tool description stays true to the schema', () => {
    it('executes every example query embedded in the model-facing description', {
      timeout: 120_000,
    }, async () => {
      // A broken example in a tool description is worse than no example: it
      // teaches the model a column that does not exist and costs it a turn.
      // This is the regression guard for a migration renaming something the
      // description references.
      expect(QUERY_SELF_EXAMPLE_QUERIES.length).toBeGreaterThan(0);

      for (const example of QUERY_SELF_EXAMPLE_QUERIES) {
        // Every example must be in the shipped description, so the constant
        // cannot drift into being tested-but-not-shown.
        expect(TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.querySelf]).toContain(example);
        await expect(service.query(example)).resolves.toBeDefined();
      }
    });
  });

  /**
   * The sandbox is deliberately NOT limited to application tables — reading the
   * catalog and statistics views is what makes real index/schema tuning
   * possible. These pin that surface so a future narrowing of the role is a
   * conscious decision rather than an accident.
   */
  /**
   * The cost gate bounds PLANNED work. An unbounded recursive CTE plans at ~3
   * and runs until memory is exhausted, so it needs a different guard — and a
   * text denylist is not it. The PLANNER names the construct (`Recursive
   * Union`), so the guard reads the plan, exactly like the cost gate does.
   *
   * The distinction is measured, not guessed:
   *   LIMIT over a pipelined recursion  -> completed in 869ms with 51 rows
   *   count(*) over the same recursion  -> still running after 10s (killed)
   *
   * So recursion is NOT banned — BST-919's symbol-graph traversal needs it.
   * Only recursion under a DRAINING parent, where the row cap cannot help, is
   * refused.
   */
  describe('unbounded recursion guard', () => {
    const UNBOUNDED = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r)';

    it('refuses recursion drained by an aggregate', { timeout: 120_000 }, async () => {
      await expect(
        service.query(`${UNBOUNDED} SELECT count(*) AS c FROM r`)
      ).rejects.toBeInstanceOf(AgentSqlUnboundedRecursionError);
    });

    it('refuses recursion drained by a sort', { timeout: 120_000 }, async () => {
      await expect(
        service.query(`${UNBOUNDED} SELECT n FROM r ORDER BY n DESC`)
      ).rejects.toBeInstanceOf(AgentSqlUnboundedRecursionError);
    });

    it('explains how to fix it rather than just refusing', { timeout: 120_000 }, async () => {
      const error = await service
        .query(`${UNBOUNDED} SELECT count(*) AS c FROM r`)
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toMatch(/termination|WHERE|bound/i);
    });

    it('ALLOWS a pipelined recursion the row cap can bound', { timeout: 120_000 }, async () => {
      // Guards the other direction: banning recursion outright would break
      // graph traversal, a headline use case for this tool.
      const result = await service.query(`${UNBOUNDED} SELECT n FROM r`, { maxRows: 5 });
      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(true);
    });

    it('ALLOWS a terminating recursion under an aggregate', { timeout: 120_000 }, async () => {
      const result = await service.query(
        'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 20) SELECT count(*)::int AS c FROM r'
      );
      expect(Number(result.rows[0]?.[0])).toBe(20);
    });
  });

  describe('explain mode', () => {
    it('returns a readable plan without executing', { timeout: 120_000 }, async () => {
      const plan = await service.explain('SELECT * FROM file_records');
      expect(plan.plan.join('\n')).toMatch(/Scan/i);
      expect(plan.analyzed).toBe(false);
    });

    it('does not apply the cost ceiling to a plan-only explain', { timeout: 120_000 }, async () => {
      // Explaining an expensive query is exactly when the plan is MOST useful;
      // refusing on cost would defeat the point. Planning does not execute.
      const plan = await service.explain(
        'SELECT count(*) FROM generate_series(1,6000) a, generate_series(1,6000) b'
      );
      expect(plan.plan.length).toBeGreaterThan(0);
    });

    it('reports actual rows and timing when analyzing', { timeout: 120_000 }, async () => {
      const plan = await service.explain('SELECT count(*) FROM file_records', { analyze: true });
      expect(plan.analyzed).toBe(true);
      expect(plan.plan.join('\n')).toMatch(/actual time|rows=/i);
    });

    it('applies the cost ceiling when analyzing, since that EXECUTES', {
      timeout: 120_000,
    }, async () => {
      await expect(
        service.explain(
          'SELECT count(*) FROM generate_series(1,6000) a, generate_series(1,6000) b',
          { analyze: true }
        )
      ).rejects.toBeInstanceOf(AgentSqlCostRejectedError);
    });

    it('applies the recursion guard when analyzing', { timeout: 120_000 }, async () => {
      await expect(
        service.explain(
          'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r',
          { analyze: true }
        )
      ).rejects.toBeInstanceOf(AgentSqlUnboundedRecursionError);
    });

    it('still refuses to write when analyzing', { timeout: 120_000 }, async () => {
      await expect(
        service.explain(`INSERT INTO roots (id, kind, display_name) VALUES ('x','path','x')`, {
          analyze: true,
        })
      ).rejects.toThrow(/read-only transaction|permission denied/i);
    });
  });

  describe('database tuning surface', () => {
    it.each([
      ['index usage', 'SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables'],
      ['unused indexes', 'SELECT indexrelname, idx_scan FROM pg_stat_user_indexes'],
      [
        'index definitions',
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
      ],
      [
        'relation sizes',
        `SELECT relname, pg_relation_size(oid) AS bytes, relpages FROM pg_class WHERE relnamespace = 'public'::regnamespace`,
      ],
      [
        'planner column stats',
        `SELECT attname, n_distinct, correlation FROM pg_stats WHERE schemaname = 'public'`,
      ],
      ['server settings', `SELECT name, setting FROM pg_settings WHERE name = 'work_mem'`],
      [
        'constraints and keys',
        `SELECT conname, contype FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'public'::regnamespace`,
      ],
    ])('can read %s', { timeout: 120_000 }, async (_label, sql) => {
      await expect(service.query(sql)).resolves.toBeDefined();
    });

    it('can flush statistics so counters are not silently zero', { timeout: 120_000 }, async () => {
      // PGlite never flushes stats on its own within a session, so pg_stat_*
      // views read 0 despite track_counts being on. An agent that skips this
      // concludes "no index is ever used" — a confidently WRONG tuning answer,
      // which is worse than an error. The flush must therefore be reachable
      // from inside the sandbox (it is a stats flush, not a data write).
      await expect(
        service.query('SELECT pg_stat_force_next_flush() IS NULL AS flushed')
      ).resolves.toBeDefined();
    });
  });

  describe('schema description', () => {
    it('lists real application tables', { timeout: 120_000 }, async () => {
      const tables = await service.describeTables();
      const names = tables.map((table) => table.name);

      expect(names).toContain('file_chunks');
      expect(names).toContain('brainstrike_assistant_run_outcomes');
      expect(names).toContain('job_queue');
    });

    it('describes a table’s columns', { timeout: 120_000 }, async () => {
      const columns = await service.describeTable('brainstrike_assistant_run_outcomes');
      const names = columns.map((column) => column.name);

      expect(names).toContain('run_id');
      expect(names).toContain('verdict');
      expect(names).toContain('source');
    });

    it('returns an empty description for an unknown table', { timeout: 120_000 }, async () => {
      const columns = await service.describeTable('definitely_not_a_table');
      expect(columns).toEqual([]);
    });

    it('never reads a table outside the public schema', { timeout: 120_000 }, async () => {
      const columns = await service.describeTable('pg_authid');
      expect(columns).toEqual([]);
    });
  });
});
