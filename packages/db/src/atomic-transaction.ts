/**
 * Atomic transaction helper for the desktop `db:transaction` IPC channel (#1141).
 *
 * The renderer can't pass a callback across the IPC boundary (the callback would run
 * in the renderer, but PGlite lives in the main process), so the atomic primitive
 * ships an ORDERED LIST of statements as data. This helper runs them inside a single
 * `pglite.transaction()` in the main process and returns the rows of one designated
 * statement. Because PGlite's `transaction()` holds the single-connection lock, a
 * concurrent `query()` (e.g. the FTS half of HybridSearchService's `Promise.all`)
 * cannot interleave — restoring the isolation that raw BEGIN/COMMIT over separate IPC
 * calls leaves open.
 */

/** One statement to run inside the transaction. */
export interface TransactionStatement {
  params?: unknown[];
  sql: string;
}

export interface AtomicStatementTransport {
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
  transaction?: <T>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<T>
  ) => Promise<T | undefined>;
}

/** Minimal transactional surface of a PGlite instance (`db.transaction`). */
export interface TransactionalDb {
  transaction: <T>(
    fn: (tx: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<T>
  ) => Promise<T>;
}

function validateStatements(statements: TransactionStatement[], resultIndex: number): void {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error('runStatementsInTransaction requires at least one statement');
  }
  if (!Number.isInteger(resultIndex) || resultIndex < 0 || resultIndex >= statements.length) {
    throw new Error(
      `runStatementsInTransaction resultIndex ${resultIndex} out of range [0, ${statements.length - 1}]`
    );
  }
}

async function runStatementList(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  statements: TransactionStatement[],
  resultIndex: number
): Promise<{ rows: unknown[] }> {
  let designated: { rows: unknown[] } = { rows: [] };
  for (const [index, statement] of statements.entries()) {
    const current =
      statement.params && statement.params.length > 0
        ? await query(statement.sql, statement.params)
        : await query(statement.sql);
    if (index === resultIndex) {
      designated = current;
    }
  }
  return designated;
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
  validateStatements(statements, resultIndex);
  return db.transaction(async (tx) => runStatementList(tx.query.bind(tx), statements, resultIndex));
}

/**
 * Run an ordered statement list through one of the two supported atomic
 * transports: the desktop IPC statement-list bridge or an in-process callback
 * transaction. A query-only handle is intentionally unsupported because raw
 * BEGIN/COMMIT calls do not hold either transport's connection/admission lock.
 */
export async function runAtomicStatements(
  transport: AtomicStatementTransport,
  statements: TransactionStatement[],
  resultIndex: number,
  unavailableMessage: string
): Promise<{ rows: unknown[] }> {
  validateStatements(statements, resultIndex);

  if (transport.runTransaction) {
    return await transport.runTransaction(statements, resultIndex);
  }

  if (!transport.transaction) {
    throw new Error(unavailableMessage);
  }

  const result = await transport.transaction(async (tx) =>
    runStatementList(tx.query.bind(tx), statements, resultIndex)
  );

  if (!result) {
    throw new Error('Atomic transaction returned no result.');
  }
  return result;
}
