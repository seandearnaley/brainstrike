import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type { TursoMastraQueryValues, TursoMastraSqlClient } from '../types';

export interface TursoTestClient {
  readonly client: TursoMastraSqlClient;
  readonly close: () => Promise<void>;
  readonly queries: string[];
}

export async function createTursoTestClient(prefix: string): Promise<TursoTestClient> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const database = await connect(join(tempDir, 'profile.db'), {
    concurrency: 4,
    syncInterval: null,
  });
  await database.pragma("journal_mode = 'mvcc'", {});
  await database.pragma('foreign_keys = ON', {});

  const queries: string[] = [];
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new Error('Turso test client is closed.');
    }
  };

  const wrap = (): TursoMastraSqlClient => ({
    exec: async (query, values) => {
      assertOpen();
      queries.push(query);
      if (values && values.length > 0) {
        await database.run(query, normalizeValues(values));
        return;
      }
      await database.exec(query);
    },
    query: async (query, values) => {
      assertOpen();
      queries.push(query);
      const rows = values
        ? await database.all(query, normalizeValues(values))
        : await database.all(query);
      return { rows: rows as Record<string, unknown>[] };
    },
    transaction: async (fn) => {
      assertOpen();
      await database.exec('BEGIN CONCURRENT');
      const tx = wrap();
      try {
        const result = await fn(tx);
        await database.exec('COMMIT');
        return result;
      } catch (error) {
        await rollback(database);
        throw error;
      }
    },
  });

  return {
    client: wrap(),
    queries,
    close: async () => {
      if (!closed) {
        await database.close();
        closed = true;
      }
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}

function normalizeValues(values: TursoMastraQueryValues): unknown[] {
  return values.map((value) => (value instanceof Date ? value.toISOString() : value));
}

async function rollback(database: TursoDatabase): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // The original transaction error is more useful than rollback failure.
  }
}
