import { AsyncLocalStorage } from 'node:async_hooks';
import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type {
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../architecture/brainstrike-db-client-contract.js';
import {
  createTursoDatabaseConnectOptions,
  type TursoDatabaseConnectOptions,
} from './connect-options.js';

const transactionCallbackContext = new AsyncLocalStorage<symbol>();

export interface TursoOwnerClientOptions {
  readonly dbPath: string;
  readonly openDatabase?: (
    dbPath: string,
    options: TursoDatabaseConnectOptions
  ) => Promise<TursoDatabase>;
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
  const database = await openDatabase(options.dbPath, createTursoDatabaseConnectOptions());
  let closed = false;
  let exclusiveTail = Promise.resolve();
  const ownerClientId = Symbol('turso-owner-client');

  await applyTursoMvccJournalMode(database);

  const assertOpen = (): void => {
    if (closed) {
      throw new Error('Turso owner client is closed.');
    }
  };

  const assertOuterClientAvailable = (): void => {
    if (transactionCallbackContext.getStore() === ownerClientId) {
      throw new Error(
        'Use the transaction callback client inside Turso owner transactions; the outer owner client is locked until the callback finishes.'
      );
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
      assertOuterClientAvailable();
      await runExclusive(async () => {
        if (closed) {
          return;
        }
        await database.close();
        closed = true;
      });
    },
    exec: async (sql, params) => {
      assertOuterClientAvailable();
      return runExclusive(async () => {
        assertOpen();
        await execTursoSql(database, sql, params);
      });
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      _options?: BrainstrikeDbWorkOptions
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      assertOuterClientAvailable();
      return runExclusive(async () => {
        assertOpen();
        return queryTursoSql(database, sql, params);
      });
    },
    transaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
    ): Promise<TResult> => {
      assertOuterClientAvailable();
      return runExclusive(async () => {
        assertOpen();
        await database.exec('BEGIN');
        try {
          const result = await transactionCallbackContext.run(ownerClientId, () =>
            callback(runWithoutLock)
          );
          await database.exec('COMMIT');
          return result;
        } catch (error) {
          await rollbackIgnoringFailure(database);
          throw error;
        }
      });
    },
  };

  return client;
}

async function queryTursoSql<TRecord>(
  database: TursoDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<BrainstrikeDbQueryResult<TRecord>> {
  if (params && params.length > 0) {
    assertParameterizedSqlIsSingleStatement(sql, 'query');
  }
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

  assertParameterizedSqlIsSingleStatement(sql, 'exec');
  await database.run(sql, [...params]);
}

function assertParameterizedSqlIsSingleStatement(sql: string, operation: 'exec' | 'query'): void {
  if (hasNonTrailingStatementSeparator(sql)) {
    throw new Error(`Parameterized Turso ${operation} accepts exactly one SQL statement.`);
  }
}

function hasNonTrailingStatementSeparator(sql: string): boolean {
  let quote: '"' | "'" | '`' | null = null;
  let index = 0;

  while (index < sql.length) {
    if (quote) {
      const result = consumeQuotedSqlChar(sql, index, quote);
      quote = result.quote;
      index = result.nextIndex;
      continue;
    }

    const commentEndIndex = skipCommentAt(sql, index);
    if (commentEndIndex !== null) {
      index = commentEndIndex;
      continue;
    }
    const nextQuote = readSqlQuote(sql[index]);
    if (nextQuote) {
      quote = nextQuote;
      index += 1;
      continue;
    }
    if (sql[index] === ';' && hasSqlAfterStatementSeparator(sql, index + 1)) {
      return true;
    }

    index += 1;
  }

  return false;
}

function consumeQuotedSqlChar(
  sql: string,
  index: number,
  quote: '"' | "'" | '`'
): { readonly nextIndex: number; readonly quote: '"' | "'" | '`' | null } {
  if (sql[index] !== quote) {
    return { nextIndex: index + 1, quote };
  }
  if (sql[index + 1] === quote) {
    return { nextIndex: index + 2, quote };
  }
  return { nextIndex: index + 1, quote: null };
}

function readSqlQuote(value: string | undefined): '"' | "'" | '`' | null {
  return value === '"' || value === "'" || value === '`' ? value : null;
}

function hasSqlAfterStatementSeparator(sql: string, startIndex: number): boolean {
  let index = startIndex;
  while (index < sql.length) {
    if (isSqlWhitespace(sql[index])) {
      index += 1;
      continue;
    }
    const commentEndIndex = skipCommentAt(sql, index);
    if (commentEndIndex !== null) {
      index = commentEndIndex;
      continue;
    }
    return true;
  }
  return false;
}

function skipCommentAt(sql: string, index: number): number | null {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === '-' && next === '-') {
    return skipLineComment(sql, index + 2);
  }
  if (char === '/' && next === '*') {
    return skipBlockComment(sql, index + 2);
  }
  return null;
}

function skipLineComment(sql: string, startIndex: number): number {
  const end = sql.indexOf('\n', startIndex);
  return end === -1 ? sql.length : end + 1;
}

function skipBlockComment(sql: string, startIndex: number): number {
  const end = sql.indexOf('*/', startIndex);
  return end === -1 ? sql.length : end + 2;
}

function isSqlWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f';
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
