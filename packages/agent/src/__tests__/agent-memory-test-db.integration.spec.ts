import { describe, expect, it } from 'vitest';
import { createAgentMemoryTestDb } from './helpers/migrated-agent-test-db';

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
