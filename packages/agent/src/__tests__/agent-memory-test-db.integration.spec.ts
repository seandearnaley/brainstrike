import { describe, expect, it } from 'vitest';
import {
  createAgentMemoryTestDb,
  createPristineBareTestDb,
  createPristineEngineTestDb,
} from './helpers/migrated-agent-test-db';

describe('agent memory test database', () => {
  it('returns a fresh isolated database for every test', async () => {
    const first = await createAgentMemoryTestDb();
    const second = await createAgentMemoryTestDb();
    try {
      await first.query(
        `INSERT INTO mastra_threads
           (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ('fixture-isolation', 'workspace', 'first only', '{}', NOW(), NOW())`
      );

      const firstRows = await first.query('SELECT id FROM mastra_threads');
      const secondRows = await second.query('SELECT id FROM mastra_threads');
      expect(firstRows.rows).toHaveLength(1);
      expect(secondRows.rows).toHaveLength(0);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('loads the full engine extension set into every restored database', async () => {
    const database = await createAgentMemoryTestDb();
    try {
      await database.exec(`
        CREATE EXTENSION IF NOT EXISTS pg_textsearch;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS vector;
      `);
      const result = await database.query<{ extname: string }>(
        `SELECT extname
         FROM pg_extension
         WHERE extname IN ('pg_textsearch', 'pg_trgm', 'vector')
         ORDER BY extname`
      );
      expect(result.rows.map((row) => row.extname)).toEqual(['pg_textsearch', 'pg_trgm', 'vector']);
    } finally {
      await database.close();
    }
  });
});

describe('pristine test databases', () => {
  it('restores an empty, isolated engine database for every call', async () => {
    const first = await createPristineEngineTestDb();
    const second = await createPristineEngineTestDb();
    try {
      await first.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE TABLE only_in_first (id text PRIMARY KEY);
      `);

      const tables = await second.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
      );
      const extensions = await second.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'"
      );
      expect(tables.rows).toEqual([]);
      expect(extensions.rows).toEqual([]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('keeps the construction of the suite it replaces: a bare restore has no engine extensions', async () => {
    const database = await createPristineBareTestDb();
    try {
      await expect(database.exec('CREATE EXTENSION vector')).rejects.toThrow(/vector/u);
    } finally {
      await database.close();
    }
  });
});
