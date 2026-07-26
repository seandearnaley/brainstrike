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
