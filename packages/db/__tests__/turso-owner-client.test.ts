import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as TursoDatabase } from '@tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    pragma: vi.fn(async () => [{ journal_mode: 'mvcc' }]),
    run: vi.fn(async () => undefined),
  } as unknown as TursoDatabase;
}
