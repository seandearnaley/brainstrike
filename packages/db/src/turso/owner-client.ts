import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type {
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../architecture/brainstrike-db-client-contract.js';

export interface TursoOwnerClientOptions {
  readonly dbPath: string;
  readonly openDatabase?: (dbPath: string) => Promise<TursoDatabase>;
}

export interface TursoOwnerClient extends BrainstrikeDbTransactionClient {
  readonly close: () => Promise<void>;
  readonly transaction: <TResult>(
    callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
  ) => Promise<TResult>;
}

export async function createTursoOwnerClient(
  options: TursoOwnerClientOptions
): Promise<TursoOwnerClient> {
  const openDatabase = options.openDatabase ?? connect;
  const database = await openDatabase(options.dbPath);
  let closed = false;
  let exclusiveTail = Promise.resolve();

  await applyTursoMvccJournalMode(database);

  const assertOpen = (): void => {
    if (closed) {
      throw new Error('Turso owner client is closed.');
    }
  };

  const runWithoutLock: BrainstrikeDbTransactionClient = {
    exec: async (sql, params) => {
      assertOpen();
      await execTursoSql(database, sql, params);
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      _options?: BrainstrikeDbWorkOptions
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      assertOpen();
      return queryTursoSql(database, sql, params);
    },
  };

  const runExclusive = async <TResult>(work: () => Promise<TResult>): Promise<TResult> => {
    const previous = exclusiveTail;
    let releaseCurrent = (): void => {
      throw new Error('Turso owner client exclusive queue was not initialized.');
    };
    exclusiveTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      releaseCurrent();
    }
  };

  const client: TursoOwnerClient = {
    close: async () => {
      await runExclusive(async () => {
        if (closed) {
          return;
        }
        await database.close();
        closed = true;
      });
    },
    exec: async (sql, params) =>
      runExclusive(async () => {
        assertOpen();
        await execTursoSql(database, sql, params);
      }),
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      _options?: BrainstrikeDbWorkOptions
    ): Promise<BrainstrikeDbQueryResult<TRecord>> =>
      runExclusive(async () => {
        assertOpen();
        return queryTursoSql(database, sql, params);
      }),
    transaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
    ): Promise<TResult> =>
      runExclusive(async () => {
        assertOpen();
        await database.exec('BEGIN');
        try {
          const result = await callback(runWithoutLock);
          await database.exec('COMMIT');
          return result;
        } catch (error) {
          await rollbackIgnoringFailure(database);
          throw error;
        }
      }),
  };

  return client;
}

async function queryTursoSql<TRecord>(
  database: TursoDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<BrainstrikeDbQueryResult<TRecord>> {
  const rows = params ? await database.all(sql, [...params]) : await database.all(sql);
  return { rows: rows as TRecord[] };
}

async function execTursoSql(
  database: TursoDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<void> {
  if (!params || params.length === 0) {
    await database.exec(sql);
    return;
  }

  await database.run(sql, [...params]);
}

async function applyTursoMvccJournalMode(database: TursoDatabase): Promise<void> {
  const rows = await database.pragma("journal_mode = 'mvcc'", {});
  const appliedMode = readJournalMode(rows);
  if (appliedMode !== 'mvcc') {
    throw new Error(`Turso owner client failed to enable MVCC journal mode: ${appliedMode}.`);
  }
}

function readJournalMode(rows: readonly unknown[]): string {
  const first = rows[0];
  if (!first || typeof first !== 'object') {
    return 'unknown';
  }

  const value = (first as Record<string, unknown>)['journal_mode'];
  return typeof value === 'string' ? value.trim().toLowerCase() : 'unknown';
}

async function rollbackIgnoringFailure(database: TursoDatabase): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // Preserve the original transaction failure.
  }
}
