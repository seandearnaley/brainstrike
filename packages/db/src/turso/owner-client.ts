import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseTursoOwnerClientQoSSnapshot } from '@brainstrike/types';
import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type {
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
  BrainstrikeDbWorkOptions,
} from '../architecture/brainstrike-db-client-contract.js';
import { markBrainstrikeDbExecutionRuntime } from '../architecture/brainstrike-db-client-contract.js';
import {
  createTursoDatabaseConnectOptions,
  type TursoDatabaseConnectOptions,
} from './connect-options.js';

const transactionCallbackContext = new AsyncLocalStorage<symbol>();
const DEFAULT_SLOW_QUEUE_THRESHOLD_MS = 1000;

type TursoOwnerClientOperationPriority = NonNullable<BrainstrikeDbWorkOptions['priority']>;

export interface TursoOwnerClientOptions {
  readonly dbPath: string;
  readonly now?: () => number;
  readonly openDatabase?: (
    dbPath: string,
    options: TursoDatabaseConnectOptions
  ) => Promise<TursoDatabase>;
  readonly slowQueueThresholdMs?: number;
}

export type TursoOwnerClientOperationKind =
  | 'close'
  | 'exec'
  | 'exclusiveTransaction'
  | 'query'
  | 'transaction';

export interface TursoOwnerClientActiveOperationDiagnostic {
  readonly activeDurationMs: number;
  readonly id: number;
  readonly kind: TursoOwnerClientOperationKind;
  readonly label: string;
  readonly priority: TursoOwnerClientOperationPriority | null;
  readonly queuedAt: number;
  readonly queueWaitMs: number;
  readonly startedAt: number;
}

export interface TursoOwnerClientQueuedOperationDiagnostic {
  readonly id: number;
  readonly kind: TursoOwnerClientOperationKind;
  readonly label: string;
  readonly priority: TursoOwnerClientOperationPriority | null;
  readonly queuedAt: number;
  readonly queuedForMs: number;
}

export interface TursoOwnerClientQoSDiagnostics {
  readonly activeOperation: TursoOwnerClientActiveOperationDiagnostic | null;
  readonly queuedOperationCount: number;
  readonly queuedOperations: readonly TursoOwnerClientQueuedOperationDiagnostic[];
  readonly slowQueuedOperationCount: number;
  readonly slowQueueThresholdMs: number;
  readonly totalCompletedOperations: number;
  readonly totalFailedOperations: number;
  readonly totalQueuedOperations: number;
  readonly totalStartedOperations: number;
}

export interface TursoOwnerClient extends BrainstrikeDbTransactionClient {
  readonly close: () => Promise<void>;
  readonly exclusiveTransaction: <TResult>(
    callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>,
    options?: BrainstrikeDbWorkOptions
  ) => Promise<TResult>;
  readonly getQoSDiagnostics: () => TursoOwnerClientQoSDiagnostics;
  readonly transaction: <TResult>(
    callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>,
    options?: BrainstrikeDbWorkOptions
  ) => Promise<TResult>;
}

interface TursoOwnerClientOperationState {
  readonly id: number;
  readonly kind: TursoOwnerClientOperationKind;
  readonly label: string;
  readonly priority: TursoOwnerClientOperationPriority | null;
  readonly queuedAt: number;
  startedAt: number | null;
}

interface TursoOwnerClientQoSCounters {
  totalCompletedOperations: number;
  totalFailedOperations: number;
  totalQueuedOperations: number;
  totalStartedOperations: number;
}

export async function createTursoOwnerClient(
  options: TursoOwnerClientOptions
): Promise<TursoOwnerClient> {
  const openDatabase = options.openDatabase ?? connect;
  const database = await openDatabase(options.dbPath, createTursoDatabaseConnectOptions());
  const now = options.now ?? Date.now;
  const slowQueueThresholdMs = options.slowQueueThresholdMs ?? DEFAULT_SLOW_QUEUE_THRESHOLD_MS;
  let closed = false;
  let exclusiveTail = Promise.resolve();
  let nextOperationId = 1;
  let activeOperation: TursoOwnerClientOperationState | null = null;
  const queuedOperations: TursoOwnerClientOperationState[] = [];
  const qosCounters: TursoOwnerClientQoSCounters = {
    totalCompletedOperations: 0,
    totalFailedOperations: 0,
    totalQueuedOperations: 0,
    totalStartedOperations: 0,
  };
  const ownerClientId = Symbol('turso-owner-client');

  await applyTursoMvccJournalMode(database);
  await applyTursoForeignKeys(database);

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

  const runExclusive = async <TResult>(
    operationInput: {
      readonly kind: TursoOwnerClientOperationKind;
      readonly label?: string | undefined;
      readonly priority?: TursoOwnerClientOperationPriority | undefined;
    },
    work: () => Promise<TResult>
  ): Promise<TResult> => {
    const operation: TursoOwnerClientOperationState = {
      id: nextOperationId,
      kind: operationInput.kind,
      label: operationInput.label ?? operationInput.kind,
      priority: operationInput.priority ?? null,
      queuedAt: now(),
      startedAt: null,
    };
    nextOperationId += 1;
    qosCounters.totalQueuedOperations += 1;
    queuedOperations.push(operation);
    const previous = exclusiveTail;
    let releaseCurrent = (): void => {
      throw new Error('Turso owner client exclusive queue was not initialized.');
    };
    exclusiveTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;
    removeQueuedOperation(queuedOperations, operation.id);
    operation.startedAt = now();
    activeOperation = operation;
    qosCounters.totalStartedOperations += 1;
    try {
      const result = await work();
      qosCounters.totalCompletedOperations += 1;
      return result;
    } catch (error) {
      qosCounters.totalFailedOperations += 1;
      throw error;
    } finally {
      if (activeOperation?.id === operation.id) {
        activeOperation = null;
      }
      releaseCurrent();
    }
  };

  const client: TursoOwnerClient = {
    close: async () => {
      assertOuterClientAvailable();
      await runExclusive({ kind: 'close' }, async () => {
        if (closed) {
          return;
        }
        await database.close();
        closed = true;
      });
    },
    exec: async (sql, params, operationOptions) => {
      assertOuterClientAvailable();
      return runExclusive(
        {
          kind: 'exec',
          label: operationOptions?.label,
          priority: operationOptions?.priority,
        },
        async () => {
          assertOpen();
          await execTursoSql(database, sql, params);
        }
      );
    },
    query: async <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[],
      operationOptions?: BrainstrikeDbWorkOptions
    ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
      assertOuterClientAvailable();
      return runExclusive(
        {
          kind: 'query',
          label: operationOptions?.label,
          priority: operationOptions?.priority,
        },
        async () => {
          assertOpen();
          return queryTursoSql(database, sql, params);
        }
      );
    },
    exclusiveTransaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>,
      operationOptions?: BrainstrikeDbWorkOptions
    ): Promise<TResult> =>
      runTransaction({
        assertOpen,
        assertOuterClientAvailable,
        beginSql: 'BEGIN',
        callback,
        database,
        operationKind: 'exclusiveTransaction',
        operationOptions,
        ownerClientId,
        runExclusive,
      }),
    getQoSDiagnostics: () =>
      createQoSDiagnosticsSnapshot({
        activeOperation,
        now: now(),
        queuedOperations,
        slowQueueThresholdMs,
        ...qosCounters,
      }),
    transaction: async <TResult>(
      callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>,
      operationOptions?: BrainstrikeDbWorkOptions
    ): Promise<TResult> =>
      runTransaction({
        assertOpen,
        assertOuterClientAvailable,
        beginSql: 'BEGIN CONCURRENT',
        callback,
        database,
        operationKind: 'transaction',
        operationOptions,
        ownerClientId,
        runExclusive,
      }),
  };

  return markBrainstrikeDbExecutionRuntime(client, 'turso');
}

async function runTransaction<TResult>(params: {
  readonly assertOpen: () => void;
  readonly assertOuterClientAvailable: () => void;
  readonly beginSql: 'BEGIN' | 'BEGIN CONCURRENT';
  readonly callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>;
  readonly database: TursoDatabase;
  readonly operationKind: TursoOwnerClientOperationKind;
  readonly operationOptions?: BrainstrikeDbWorkOptions | undefined;
  readonly ownerClientId: symbol;
  readonly runExclusive: <TValue>(
    operationInput: {
      readonly kind: TursoOwnerClientOperationKind;
      readonly label?: string | undefined;
      readonly priority?: TursoOwnerClientOperationPriority | undefined;
    },
    work: () => Promise<TValue>
  ) => Promise<TValue>;
}): Promise<TResult> {
  params.assertOuterClientAvailable();
  return params.runExclusive(
    {
      kind: params.operationKind,
      label: params.operationOptions?.label,
      priority: params.operationOptions?.priority,
    },
    async () => {
      params.assertOpen();
      await params.database.exec(params.beginSql);
      const transactionClient = createTursoTransactionClient(params.database, params.assertOpen);
      try {
        const result = await transactionCallbackContext.run(params.ownerClientId, () =>
          params.callback(transactionClient.client)
        );
        transactionClient.deactivate();
        await params.database.exec('COMMIT');
        return result;
      } catch (error) {
        transactionClient.deactivate();
        await rollbackIgnoringFailure(params.database);
        throw error;
      }
    }
  );
}

function createQoSDiagnosticsSnapshot(
  input: TursoOwnerClientQoSCounters & {
    readonly activeOperation: TursoOwnerClientOperationState | null;
    readonly now: number;
    readonly queuedOperations: readonly TursoOwnerClientOperationState[];
    readonly slowQueueThresholdMs: number;
  }
): TursoOwnerClientQoSDiagnostics {
  const queuedOperations = input.queuedOperations.map((operation) =>
    createQueuedOperationDiagnostic(operation, input.now)
  );
  const snapshot = {
    activeOperation: input.activeOperation
      ? createActiveOperationDiagnostic(input.activeOperation, input.now)
      : null,
    queuedOperationCount: queuedOperations.length,
    queuedOperations,
    slowQueuedOperationCount: queuedOperations.filter(
      (operation) => operation.queuedForMs >= input.slowQueueThresholdMs
    ).length,
    slowQueueThresholdMs: input.slowQueueThresholdMs,
    totalCompletedOperations: input.totalCompletedOperations,
    totalFailedOperations: input.totalFailedOperations,
    totalQueuedOperations: input.totalQueuedOperations,
    totalStartedOperations: input.totalStartedOperations,
  } satisfies DatabaseTursoOwnerClientQoSSnapshot;
  return snapshot;
}

function createActiveOperationDiagnostic(
  operation: TursoOwnerClientOperationState,
  now: number
): TursoOwnerClientActiveOperationDiagnostic {
  if (operation.startedAt === null) {
    throw new Error('Active Turso owner operation is missing a start timestamp.');
  }
  return {
    activeDurationMs: Math.max(0, now - operation.startedAt),
    id: operation.id,
    kind: operation.kind,
    label: operation.label,
    priority: operation.priority,
    queueWaitMs: Math.max(0, operation.startedAt - operation.queuedAt),
    queuedAt: operation.queuedAt,
    startedAt: operation.startedAt,
  };
}

function createQueuedOperationDiagnostic(
  operation: TursoOwnerClientOperationState,
  now: number
): TursoOwnerClientQueuedOperationDiagnostic {
  return {
    id: operation.id,
    kind: operation.kind,
    label: operation.label,
    priority: operation.priority,
    queuedAt: operation.queuedAt,
    queuedForMs: Math.max(0, now - operation.queuedAt),
  };
}

function removeQueuedOperation(
  queuedOperations: TursoOwnerClientOperationState[],
  operationId: number
): void {
  const index = queuedOperations.findIndex((operation) => operation.id === operationId);
  if (index !== -1) {
    queuedOperations.splice(index, 1);
  }
}

function createTursoTransactionClient(
  database: TursoDatabase,
  assertOwnerOpen: () => void
): {
  readonly client: BrainstrikeDbTransactionClient;
  readonly deactivate: () => void;
} {
  let active = true;

  const assertTransactionActive = (): void => {
    assertOwnerOpen();
    if (!active) {
      throw new Error('Turso transaction client is no longer active.');
    }
  };

  return {
    client: {
      exec: async (sql, params) => {
        assertTransactionActive();
        await execTursoSql(database, sql, params);
      },
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[],
        _options?: BrainstrikeDbWorkOptions
      ): Promise<BrainstrikeDbQueryResult<TRecord>> => {
        assertTransactionActive();
        return queryTursoSql(database, sql, params);
      },
    },
    deactivate: () => {
      active = false;
    },
  };
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

async function applyTursoForeignKeys(database: TursoDatabase): Promise<void> {
  await database.pragma('foreign_keys = ON', {});
  const rows = await database.pragma('foreign_keys', {});
  const enabled = readForeignKeys(rows);
  if (enabled !== 1) {
    throw new Error(`Turso owner client failed to enable foreign keys: ${enabled}.`);
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

function readForeignKeys(rows: readonly unknown[]): number | 'unknown' {
  const first = rows[0];
  if (!first || typeof first !== 'object') {
    return 'unknown';
  }

  const value = (first as Record<string, unknown>)['foreign_keys'];
  return typeof value === 'number' ? value : 'unknown';
}

async function rollbackIgnoringFailure(database: TursoDatabase): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // Preserve the original transaction failure.
  }
}
