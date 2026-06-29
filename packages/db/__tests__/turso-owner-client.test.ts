import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as TursoDatabase } from '@tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import { createTursoOwnerClient } from '../src/turso/owner-client.js';

describe('Turso owner client', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-owner-'));
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it('executes parameterized writes and queries through the owner handle', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'profile.db'),
    });
    const _executionClient: BrainstrikeDbExecutionClient = client;
    expect(_executionClient).toBe(client);

    try {
      await client.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      await client.exec('INSERT INTO notes (value) VALUES (?)', ['alpha']);

      const result = await client.query<{ value: string }>(
        'SELECT value FROM notes WHERE value = ?',
        ['alpha']
      );

      expect(result).toEqual({ rows: [{ value: 'alpha' }] });
    } finally {
      await client.close();
    }
  });

  it('opens the owner handle with the same Turso index-method option as bootstrap', async () => {
    const database = createMockTursoDatabase();
    const openDatabase = vi.fn(async () => database);

    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'profile.db'),
      openDatabase,
    });

    try {
      expect(openDatabase).toHaveBeenCalledWith(
        join(tempDir, 'profile.db'),
        expect.objectContaining({ experimental: ['index_method'] })
      );
    } finally {
      await client.close();
    }
  });

  it('starts callback transactions with BEGIN CONCURRENT for concurrent writes', async () => {
    const database = createMockTursoDatabase();
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'concurrent-transactions.db'),
      openDatabase: async () => database,
    });

    try {
      await client.transaction(async () => undefined);

      expect(database.exec).toHaveBeenCalledWith('BEGIN CONCURRENT');
    } finally {
      await client.close();
    }
  });

  it('starts explicit exclusive transactions with BEGIN for schema work', async () => {
    const database = createMockTursoDatabase();
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'exclusive-transactions.db'),
      openDatabase: async () => database,
    });

    try {
      await client.exclusiveTransaction(async () => undefined);

      expect(database.exec).toHaveBeenCalledWith('BEGIN');
    } finally {
      await client.close();
    }
  });

  it('enables foreign-key cascades on every owner connection', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'foreign-keys.db'),
    });

    try {
      await client.exec(`
        CREATE TABLE parent_records (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE child_records (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent_records(id) ON DELETE CASCADE
        )
      `);
      await client.exec('INSERT INTO parent_records (id) VALUES (?)', ['parent-1']);
      await client.exec('INSERT INTO child_records (id, parent_id) VALUES (?, ?)', [
        'child-1',
        'parent-1',
      ]);

      await client.exec('DELETE FROM parent_records WHERE id = ?', ['parent-1']);

      await expect(
        client.query<{ count: number }>('SELECT COUNT(*) AS count FROM child_records')
      ).resolves.toEqual({ rows: [{ count: 0 }] });
    } finally {
      await client.close();
    }
  });

  it('rejects parameterized exec calls that contain more than one SQL statement', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'single-statement.db'),
    });

    try {
      await expect(
        client.exec('CREATE TABLE notes (value TEXT); INSERT INTO notes (value) VALUES (?)', [
          'alpha',
        ])
      ).rejects.toThrow('Parameterized Turso exec accepts exactly one SQL statement.');
    } finally {
      await client.close();
    }
  });

  it('rolls back failed callback transactions', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'transactions.db'),
    });

    try {
      await client.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

      await expect(
        client.transaction(async (tx) => {
          await tx.exec('INSERT INTO notes (value) VALUES (?)', ['rolled-back']);
          throw new Error('rollback requested');
        })
      ).rejects.toThrow('rollback requested');

      const result = await client.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM notes WHERE value = ?',
        ['rolled-back']
      );

      expect(result.rows).toEqual([{ count: 0 }]);
    } finally {
      await client.close();
    }
  });

  it('rejects transaction callback clients after the callback completes', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'escaped-transaction.db'),
    });
    let escapedTransactionClient: BrainstrikeDbTransactionClient | null = null;

    try {
      await client.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      await client.transaction(async (tx) => {
        escapedTransactionClient = tx;
        await tx.exec('INSERT INTO notes (value) VALUES (?)', ['inside-transaction']);
      });

      expect(escapedTransactionClient).not.toBeNull();
      if (!escapedTransactionClient) {
        throw new Error('Expected transaction client to escape the callback.');
      }
      await expect(
        escapedTransactionClient.exec('INSERT INTO notes (value) VALUES (?)', ['escaped'])
      ).rejects.toThrow('Turso transaction client is no longer active.');

      const result = await client.query<{ value: string }>(
        'SELECT value FROM notes ORDER BY value'
      );

      expect(result.rows).toEqual([{ value: 'inside-transaction' }]);
    } finally {
      await client.close();
    }
  });

  it('fails fast when a transaction callback re-enters the outer owner client', async () => {
    const database = createMockTursoDatabase();
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'reentrant.db'),
      openDatabase: async () => database,
    });

    const result = await Promise.race([
      client
        .transaction(async () => {
          await client.query('SELECT 1 AS value');
        })
        .then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);

    expect(result).toBe(
      'Use the transaction callback client inside Turso owner transactions; the outer owner client is locked until the callback finishes.'
    );
  });

  it('queues unrelated outer-client callers while a transaction callback is active', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'transaction-queue.db'),
    });
    let releaseTransaction: (() => void) | null = null;
    let markTransactionStarted: (() => void) | null = null;
    const transactionStarted = new Promise<void>((resolve) => {
      markTransactionStarted = resolve;
    });

    try {
      await client.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const transactionPromise = client.transaction(async (tx) => {
        await tx.exec('INSERT INTO notes (value) VALUES (?)', ['inside-transaction']);
        markTransactionStarted?.();
        await new Promise<void>((resolve) => {
          releaseTransaction = resolve;
        });
      });

      await transactionStarted;
      const queryPromise = client.query<{ count: number }>('SELECT COUNT(*) AS count FROM notes');

      await expect(
        Promise.race([
          queryPromise.then(
            () => 'resolved',
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ])
      ).resolves.toBe('pending');

      releaseTransaction?.();
      await transactionPromise;
      await expect(queryPromise).resolves.toEqual({ rows: [{ count: 1 }] });
    } finally {
      releaseTransaction?.();
      await client.close();
    }
  });

  it('reports queued, started, completed, and slow queued owner operations without changing serialization', async () => {
    let now = 1000;
    const firstQueryGate = createDeferred<void>();
    const database = createMockTursoDatabase();
    database.all = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstQueryGate.promise;
        return [{ value: 'first' }];
      })
      .mockResolvedValueOnce([{ value: 'second' }]);
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'qos-diagnostics.db'),
      now: () => now,
      openDatabase: async () => database,
      slowQueueThresholdMs: 50,
    });

    try {
      const firstQuery = client.query<{ value: string }>('SELECT 1 AS value', undefined, {
        label: 'first query',
      });
      await waitFor(() => client.getQoSDiagnostics().activeOperation?.label === 'first query');

      now = 1010;
      const secondQuery = client.query<{ value: string }>('SELECT 2 AS value', undefined, {
        label: 'queued query',
      });
      await waitFor(() => client.getQoSDiagnostics().queuedOperationCount === 1);

      now = 1075;
      expect(client.getQoSDiagnostics()).toMatchObject({
        activeOperation: {
          activeDurationMs: 75,
          kind: 'query',
          label: 'first query',
          queueWaitMs: 0,
        },
        queuedOperationCount: 1,
        queuedOperations: [
          {
            kind: 'query',
            label: 'queued query',
            queuedForMs: 65,
          },
        ],
        slowQueuedOperationCount: 1,
        totalCompletedOperations: 0,
        totalFailedOperations: 0,
        totalQueuedOperations: 2,
        totalStartedOperations: 1,
      });

      firstQueryGate.resolve();
      await expect(firstQuery).resolves.toEqual({ rows: [{ value: 'first' }] });
      now = 1090;
      await expect(secondQuery).resolves.toEqual({ rows: [{ value: 'second' }] });

      expect(client.getQoSDiagnostics()).toMatchObject({
        activeOperation: null,
        queuedOperationCount: 0,
        queuedOperations: [],
        slowQueuedOperationCount: 0,
        totalCompletedOperations: 2,
        totalFailedOperations: 0,
        totalQueuedOperations: 2,
        totalStartedOperations: 2,
      });
    } finally {
      firstQueryGate.resolve();
      await client.close();
    }
  });

  it('fails loudly after the owner handle is closed', async () => {
    const client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'closed.db'),
    });

    await client.close();

    await expect(client.query('SELECT 1 AS value')).rejects.toThrow(
      'Turso owner client is closed.'
    );
    await expect(client.exec('CREATE TABLE closed_probe (id INTEGER PRIMARY KEY)')).rejects.toThrow(
      'Turso owner client is closed.'
    );
  });
});

function createMockTursoDatabase(): TursoDatabase {
  return {
    all: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    exec: vi.fn(async () => undefined),
    pragma: vi.fn(async (statement: string) =>
      statement === 'foreign_keys' ? [{ foreign_keys: 1 }] : [{ journal_mode: 'mvcc' }]
    ),
    run: vi.fn(async () => undefined),
  } as unknown as TursoDatabase;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}
