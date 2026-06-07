/**
 * Vector Extension Integration Tests
 *
 * These tests validate that the pgvector extension works correctly with PGlite.
 * They are designed to run with TEST_ENABLE_VECTOR=true to actually test vector functionality.
 *
 * Run with: TEST_ENABLE_VECTOR=true pnpm test vector-extension.integration.test.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

describe('Vector Extension Integration', () => {
  let db: PGlite;

  beforeAll(async () => {
    // Create a fresh database with vector extension
    try {
      // Dynamic import to handle module resolution
      const vectorModule = await import('@electric-sql/pglite-pgvector');
      const vector = vectorModule.vector;

      db = new PGlite({
        dataDir: 'memory://',
        extensions: { vector },
      });

      // Verify the extension is loaded
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      console.error('Failed to initialize vector extension for tests:', error);
      throw error;
    }
  });

  it('should have vector extension available', async () => {
    const result = await db.query('SELECT 1 FROM pg_extension WHERE extname = $1', ['vector']);

    expect(result.rows).toHaveLength(1);
  });

  it('should create and query vector columns', async () => {
    // Create a table with vector column
    await db.query(`
      CREATE TABLE test_embeddings (
        id SERIAL PRIMARY KEY,
        content TEXT,
        embedding VECTOR(3)
      )
    `);

    // Insert test data
    await db.query(`
      INSERT INTO test_embeddings (content, embedding) VALUES
      ('apple', '[1, 2, 3]'),
      ('banana', '[2, 1, 3]'),
      ('orange', '[3, 2, 1]')
    `);

    // Query the data
    const result = await db.query('SELECT content, embedding FROM test_embeddings ORDER BY id');

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].content).toBe('apple');
    expect(result.rows[0].embedding).toBe('[1,2,3]'); // PGlite returns vector as string
  });

  it('should perform vector similarity search', async () => {
    // Use the table created in previous test (or create if not exists)
    const tableExists = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'test_embeddings'
      )
    `);

    if (!tableExists.rows[0].exists) {
      await db.query(`
        CREATE TABLE test_embeddings (
          id SERIAL PRIMARY KEY,
          content TEXT,
          embedding VECTOR(3)
        )
      `);

      await db.query(`
        INSERT INTO test_embeddings (content, embedding) VALUES
        ('apple', '[1, 2, 3]'),
        ('banana', '[2, 1, 3]'),
        ('orange', '[3, 2, 1]')
      `);
    }

    // Perform similarity search using cosine distance
    const result = await db.query(`
      SELECT content, embedding, embedding <=> '[1, 2, 3]' AS distance
      FROM test_embeddings
      ORDER BY distance
      LIMIT 2
    `);

    expect(result.rows).toHaveLength(2);
    // First result should be exact match (distance 0)
    expect(result.rows[0].content).toBe('apple');
    expect(Number(result.rows[0].distance)).toBe(0);
  });

  it('should handle vector operations correctly', async () => {
    // Test vector operations
    const result = await db.query(`
      SELECT 
        '[1, 2, 3]'::vector + '[1, 1, 1]'::vector AS addition,
        '[1, 2, 3]'::vector <-> '[3, 2, 1]'::vector AS l2_distance,
        '[1, 2, 3]'::vector <#> '[3, 2, 1]'::vector AS neg_inner_product
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].addition).toBe('[2,3,4]');
    expect(Number(result.rows[0].l2_distance)).toBeGreaterThan(0);
    expect(Number(result.rows[0].neg_inner_product)).toBeLessThan(0);
  });
});
