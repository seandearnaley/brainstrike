/**
 * Atomic transaction helper for the desktop `db:transaction` IPC channel (#1141).
 *
 * The renderer can't pass a callback across the IPC boundary (the callback would run
 * in the renderer while the transaction-capable owner lives in the DB host), so the
 * atomic primitive ships an ORDERED LIST of statements as data. This helper runs
 * them inside a single owner transaction and returns the rows of one designated
 * statement. PGlite's single-connection transaction lock and Turso's owner-client
 * transaction boundary both prevent a concurrent `query()` from interleaving with
 * the ordered statement list.
 */

/** One statement to run inside the transaction. */
export interface TransactionStatement {
  params?: unknown[];
  sql: string;
}

/** Minimal transaction-capable owner surface. */
export interface TransactionalDb {
  transaction: <T>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<T>
  ) => Promise<T>;
}

/**
 * Run `statements` in order inside ONE transaction and resolve with the rows of
 * `statements[resultIndex]`. Throws (rather than silently degrading) on an empty list
 * or an out-of-range index.
 */
export async function runStatementsInTransaction(
  db: TransactionalDb,
  statements: TransactionStatement[],
  resultIndex: number
): Promise<{ rows: unknown[] }> {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error('runStatementsInTransaction requires at least one statement');
  }
  if (!Number.isInteger(resultIndex) || resultIndex < 0 || resultIndex >= statements.length) {
    throw new Error(
      `runStatementsInTransaction resultIndex ${resultIndex} out of range [0, ${statements.length - 1}]`
    );
  }

  return db.transaction(async (tx) => {
    let designated: { rows: unknown[] } = { rows: [] };
    for (const [i, { sql, params }] of statements.entries()) {
      const res = params && params.length > 0 ? await tx.query(sql, params) : await tx.query(sql);
      if (i === resultIndex) {
        designated = { rows: res.rows };
      }
    }
    return designated;
  });
}
