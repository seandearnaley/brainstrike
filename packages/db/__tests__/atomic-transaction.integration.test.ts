/**
 * Atomic IPC transaction helper integration tests (#1141)
 *
 * `runStatementsInTransaction` is what the desktop main-process `db:transaction` IPC
 * handler uses to run an ordered list of statements inside ONE `pglite.transaction()`
 * and return the rows of a designated statement. This proves, against a real PGlite
 * 0.5.1 build, that:
 *  - the statements share a single transaction (a `SET LOCAL` is visible to a later
 *    SELECT in the same batch, and is gone afterwards — proving the tx opened+closed),
 *  - the designated statement's rows (with bound params) are what comes back,
 *  - bad inputs throw rather than silently doing the wrong thing.
 *
 * Run with: TEST_ENABLE_VECTOR=true pnpm test atomic-transaction.integration.test.ts
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { runAtomicStatements, runStatementsInTransaction } from '../src/atomic-transaction.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('runStatementsInTransaction (pglite integration)', () => {
  it('runs tuning + SELECT atomically and returns the designated rows', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://atomic-tx');
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    // The real #1141 shape: SET LOCAL hnsw.ef_search then a SELECT, in one tx.
    const result = await runStatementsInTransaction(
      db,
      [
        { sql: "SET LOCAL hnsw.ef_search = '137'" },
        { sql: "SELECT current_setting('hnsw.ef_search') AS ef" },
      ],
      1
    );
    // The SELECT saw the SET LOCAL → they ran in the SAME transaction.
    expect((result.rows[0] as { ef: string }).ef).toBe('137');

    // After the helper returns, the transaction has closed, so the SET LOCAL is gone.
    const after = await db.query<{ ef: string }>("SELECT current_setting('hnsw.ef_search') AS ef");
    expect(after.rows[0]?.ef).not.toBe('137');

    await db.close();
  });

  it('returns the rows of statements[resultIndex] with bound params', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://atomic-tx-result');

    const result = await runStatementsInTransaction(
      db,
      [{ params: [42], sql: 'SELECT $1::int AS n' }, { sql: 'SELECT 99 AS n' }],
      0
    );
    expect((result.rows[0] as { n: number }).n).toBe(42);

    await db.close();
  });

  it('isolates a concurrent query from the transaction (the #1141 fix)', async () => {
    // The desktop hazard: vector search (a transaction) and an FTS query run via
    // Promise.all on the SAME pglite connection. With raw BEGIN/COMMIT the FTS query
    // can interleave into the open transaction and inherit its SET LOCAL / snapshot.
    // Going through pglite.transaction() holds the connection lock, so the concurrent
    // plain query runs fully BEFORE or AFTER the block — never inside it — and so never
    // sees the transaction-local GUC.
    const db: PGlite = await wasmLoader.createPGlite('memory://atomic-tx-isolation');
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    const [txResult, plainSetting] = await Promise.all([
      runStatementsInTransaction(
        db,
        [
          { sql: "SET LOCAL hnsw.ef_search = '321'" },
          { sql: "SELECT current_setting('hnsw.ef_search') AS ef" },
        ],
        1
      ),
      db.query<{ ef: string }>("SELECT current_setting('hnsw.ef_search') AS ef"),
    ]);

    // Inside the transaction, the SELECT sees the SET LOCAL.
    expect((txResult.rows[0] as { ef: string }).ef).toBe('321');
    // The concurrent plain query never saw the transaction-local value — isolation holds.
    expect(plainSetting.rows[0]?.ef).not.toBe('321');

    await db.close();
  });

  it('rolls back a failing callback transaction and does not leak SET LOCAL', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://atomic-callback-rollback');
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await db.query('CREATE TABLE atomic_callback_probe (value integer NOT NULL)');

    await expect(
      runAtomicStatements(
        { transaction: db.transaction.bind(db) },
        [
          { sql: "SET LOCAL hnsw.ef_search = '246'" },
          { sql: 'INSERT INTO atomic_callback_probe (value) VALUES (1)' },
          { sql: "SELECT current_setting('hnsw.ef_search') AS ef" },
          { sql: 'SELECT 1 / 0' },
        ],
        2,
        'callback transaction unavailable'
      )
    ).rejects.toThrow();

    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM atomic_callback_probe'
    );
    expect(rows.rows[0]?.count).toBe(0);
    const setting = await db.query<{ ef: string }>(
      "SELECT current_setting('hnsw.ef_search') AS ef"
    );
    expect(setting.rows[0]?.ef).not.toBe('246');

    await db.close();
  });

  it('rejects an out-of-range resultIndex and an empty statement list', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://atomic-tx-validate');

    await expect(runStatementsInTransaction(db, [{ sql: 'SELECT 1' }], 1)).rejects.toThrow(
      /resultIndex/
    );
    await expect(runStatementsInTransaction(db, [], 0)).rejects.toThrow(/at least one/);

    await db.close();
  });
});
