import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
