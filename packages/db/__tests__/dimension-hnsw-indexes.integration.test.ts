/**
 * Dimension HNSW Index Integration Tests
 *
 * Tests for BST-42: pgvector ANN Index Strategy
 *
 * These tests validate that dimension-based partial HNSW indexes are:
 * 1. Created correctly by migration 014
 * 2. Used by the query planner when WHERE includes vector_dims()
 * 3. Created dynamically when new embedding sets are added
 *
 * Run with: pnpm test dimension-hnsw-indexes.integration.test.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDeferredDimensionIndexBuilder,
  createDimensionIndex,
  DIMENSION_INDEX_BUILD_START_DELAY_MS,
  dimensionIndexExists,
  dropDimensionIndex,
  ensureDimensionIndexExists,
  getDistinctDimensions,
  hnswParams,
  MAX_HNSW_DIMENSION,
} from '../src/migrations/dimension-index-helpers';

describe('Dimension HNSW Index Helpers', () => {
  let db: PGlite;

  beforeAll(async () => {
    // Create a fresh database with vector extension
    const vectorModule = await import('@electric-sql/pglite-pgvector');
    const vector = vectorModule.vector;

    db = new PGlite({
      dataDir: 'memory://',
      extensions: { vector },
    });

    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create minimal schema needed for testing
    await db.query(`
      CREATE TABLE IF NOT EXISTS file_chunks (
        id TEXT PRIMARY KEY,
        embedding VECTOR,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS embedding_sets (
        id TEXT PRIMARY KEY,
        model_key TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('hnswParams', () => {
    it('should return default values when env vars not set', () => {
      const params = hnswParams();
      expect(params.m).toBe(16);
      expect(params.ef).toBe(64);
    });
  });

  describe('createDimensionIndex', () => {
    it('should create an HNSW index for a specific dimension', async () => {
      const params = { m: 16, ef: 64 };
      await createDimensionIndex(db, 128, params);

      // Verify index exists
      const exists = await dimensionIndexExists(db, 128);
      expect(exists).toBe(true);
    });

    it('should be idempotent - creating twice does not error', async () => {
      const params = { m: 16, ef: 64 };
      await createDimensionIndex(db, 256, params);
      await createDimensionIndex(db, 256, params); // Second call should not throw
      expect(await dimensionIndexExists(db, 256)).toBe(true);
    });

    it('builds a half-precision (halfvec) HNSW index to shrink the index and speed search', async () => {
      await createDimensionIndex(db, 768, { m: 16, ef: 64 });
      const def = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_file_chunks_emb_hnsw_768'"
      );
      const indexdef = def.rows[0]?.indexdef ?? '';
      expect(indexdef).toContain('halfvec');
      expect(indexdef).toContain('halfvec_cosine_ops');
      expect(indexdef).not.toContain('vector_cosine_ops');
    });

    it("supports HNSW indexes up to halfvec's 4000-dim limit (e.g. 3072-dim models)", async () => {
      // vector HNSW caps at 2000 dims; halfvec raises it to 4000, so large models
      // (text-embedding-3-large = 3072) get an ANN index instead of a seq scan.
      expect(MAX_HNSW_DIMENSION).toBe(4000);
      await createDimensionIndex(db, 3072, { m: 16, ef: 64 });
      expect(await dimensionIndexExists(db, 3072)).toBe(true);
    });
  });

  describe('dropDimensionIndex', () => {
    it('should drop an existing index', async () => {
      const params = { m: 16, ef: 64 };
      await createDimensionIndex(db, 384, params);
      expect(await dimensionIndexExists(db, 384)).toBe(true);

      await dropDimensionIndex(db, 384);
      expect(await dimensionIndexExists(db, 384)).toBe(false);
    });

    it('should not error when dropping non-existent index', async () => {
      // Use a valid dimension (within 1-65535 range) that doesn't have an index
      await dropDimensionIndex(db, 9999); // Should not throw
    });
  });

  describe('getDistinctDimensions', () => {
    it('should return distinct dimensions from embedding_sets', async () => {
      // Insert embedding sets with different dimensions
      await db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance)
         VALUES ('set-768', 'model-a', 'model-a-id', 768, 'cosine'),
                ('set-1024', 'model-b', 'model-b-id', 1024, 'cosine'),
                ('set-768-2', 'model-c', 'model-c-id', 768, 'l2')
         ON CONFLICT (id) DO NOTHING`
      );

      const dims = await getDistinctDimensions(db);
      expect(dims).toContain(768);
      expect(dims).toContain(1024);
      // 768 should only appear once (distinct)
      expect(dims.filter((d) => d === 768)).toHaveLength(1);
    });
  });

  describe('ensureDimensionIndexExists', () => {
    it('should create index if not exists', async () => {
      await dropDimensionIndex(db, 512); // Ensure clean state
      expect(await dimensionIndexExists(db, 512)).toBe(false);

      await ensureDimensionIndexExists(db, 512);
      expect(await dimensionIndexExists(db, 512)).toBe(true);
    });
  });
});

describe('Dimension HNSW Index Query Plan', () => {
  let db: PGlite;

  beforeAll(async () => {
    // Create a fresh database with vector extension
    const vectorModule = await import('@electric-sql/pglite-pgvector');
    const vector = vectorModule.vector;

    db = new PGlite({
      dataDir: 'memory://',
      extensions: { vector },
    });

    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create file_chunks table with dimensionless vector
    await db.query(`
      CREATE TABLE IF NOT EXISTS file_chunks (
        id TEXT PRIMARY KEY,
        file_record_id TEXT,
        embedding VECTOR,
        embedding_set_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create HNSW index for 768 dimensions
    const params = { m: 16, ef: 64 };
    await createDimensionIndex(db, 768, params);

    // Insert test data with 768-dimensional embeddings
    const embedding768 = new Array(768).fill(0.1);
    for (let i = 0; i < 100; i++) {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, embedding, embedding_set_id, created_at)
         VALUES ($1, 'file-1', $2, 'set-768', CURRENT_TIMESTAMP)`,
        [`chunk-${i}`, `[${embedding768.join(',')}]`]
      );
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('should have correct query structure for HNSW index usage', async () => {
    const queryVector = `[${new Array(768).fill(0.2).join(',')}]`;

    // Run EXPLAIN to check query plan includes the vector_dims predicate
    // Note: With small datasets (100 rows), the query planner may choose seq scan
    // over index scan because it's more efficient. The index will be used for
    // larger datasets (typically 1000+ rows) where ANN search provides benefit.
    const explainResult = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT id, (1 - ((embedding <=> $1::vector) / 2.0)) as similarity
       FROM file_chunks
       WHERE embedding IS NOT NULL
         AND vector_dims(embedding) = 768
       ORDER BY embedding <=> $1::vector
       LIMIT 10`,
      [queryVector]
    );

    const plan = explainResult.rows.map((r) => r['QUERY PLAN']).join('\n');

    // Verify the query plan includes our vector_dims filter
    // This is the critical part that enables index usage with larger datasets
    expect(plan).toContain('vector_dims(embedding) = 768');

    // Verify the index exists (even if not used for small dataset)
    const indexExists = await dimensionIndexExists(db, 768);
    expect(indexExists).toBe(true);
  });

  it('should perform similarity search with correct results', async () => {
    const queryVector = `[${new Array(768).fill(0.1).join(',')}]`;

    const result = await db.query<{ id: string; similarity: string }>(
      `SELECT id, (1 - ((embedding <=> $1::vector) / 2.0)) as similarity
       FROM file_chunks
       WHERE embedding IS NOT NULL
         AND vector_dims(embedding) = 768
       ORDER BY embedding <=> $1::vector
       LIMIT 5`,
      [queryVector]
    );

    expect(result.rows.length).toBeGreaterThan(0);
    // All embeddings are identical, so similarity should be very high (close to 1)
    expect(Number(result.rows[0].similarity)).toBeGreaterThan(0.99);
  });

  it('should use HNSW index when ORDER BY includes the halfvec cast expression', async () => {
    // This test verifies that the query uses the (embedding::halfvec(N)) cast
    // which matches the half-precision HNSW partial index. With the matching
    // cast, the query planner CAN use the HNSW index.
    const queryVector = `[${new Array(768).fill(0.2).join(',')}]`;

    const explainResult = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT id, (1 - (((embedding::halfvec(768)) <=> $1::halfvec(768)) / 2.0)) as similarity
       FROM file_chunks
       WHERE embedding IS NOT NULL
         AND vector_dims(embedding) = 768
       ORDER BY (embedding::halfvec(768)) <=> $1::halfvec(768)
       LIMIT 10`,
      [queryVector]
    );

    const plan = explainResult.rows.map((r) => r['QUERY PLAN']).join('\n');

    // Verify the query plan uses the HNSW index
    // When the cast expression matches the indexed expression, the planner uses the index
    expect(plan).toContain('Index Scan using idx_file_chunks_emb_hnsw_768');
    // Verify the ORDER BY uses the halfvec cast
    expect(plan).toContain('::halfvec(768)');
  });
});

describe('createDeferredDimensionIndexBuilder dispatch deferral', () => {
  it('does not dispatch the CREATE INDEX before the start delay elapses', async () => {
    vi.useFakeTimers();
    try {
      const statements: string[] = [];
      const fakeDb = {
        exec: async (sql: string): Promise<void> => {
          statements.push(sql.trim().slice(0, 30));
        },
        query: async <T = unknown>(): Promise<{ rows: T[] }> => ({ rows: [] }),
      };
      const builder = createDeferredDimensionIndexBuilder({
        getDb: () => fakeDb,
        onError: () => {
          throw new Error('Index build must not fail in this test.');
        },
      });

      builder.schedule(768);
      // Flush microtasks WITHOUT advancing timers: on PGlite's single
      // connection, dispatching the CREATE INDEX in the same turn would queue
      // the caller's own follow-up queries (create set -> immediately search)
      // behind a 5-30s build. The start delay gives that flow first access.
      await Promise.resolve();
      await Promise.resolve();
      expect(statements).toHaveLength(0);

      // A follow-up query issued during the window lands first.
      await fakeDb.query();

      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await builder.whenSettled();
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('CREATE INDEX');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-dispatch a build for a dimension that already succeeded this session', async () => {
    vi.useFakeTimers();
    try {
      let execCalls = 0;
      const fakeDb = {
        exec: async (): Promise<void> => {
          execCalls += 1;
        },
        query: async <T = unknown>(): Promise<{ rows: T[] }> => ({ rows: [] }),
      };
      const builder = createDeferredDimensionIndexBuilder({
        getDb: () => fakeDb,
        onError: () => {
          throw new Error('Index build must not fail in this test.');
        },
      });

      builder.schedule(768);
      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await builder.whenSettled();
      expect(execCalls).toBe(1);

      // Read-path re-arms (e.g. getById) call schedule() frequently; a
      // dimension that already built this session must be a no-op, not a
      // recurring CREATE INDEX IF NOT EXISTS round-trip on the connection.
      builder.schedule(768);
      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await builder.whenSettled();
      expect(execCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms a dimension whose build failed, so the next schedule retries', async () => {
    vi.useFakeTimers();
    try {
      let execCalls = 0;
      let failFirst = true;
      const errors: unknown[] = [];
      const fakeDb = {
        exec: async (): Promise<void> => {
          execCalls += 1;
          if (failFirst) {
            failFirst = false;
            throw new Error('transient build failure');
          }
        },
        query: async <T = unknown>(): Promise<{ rows: T[] }> => ({ rows: [] }),
      };
      const builder = createDeferredDimensionIndexBuilder({
        getDb: () => fakeDb,
        onError: (_dimension, error) => {
          errors.push(error);
        },
      });

      builder.schedule(384);
      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await builder.whenSettled();
      expect(execCalls).toBe(1);
      expect(errors).toHaveLength(1);

      // A failed build must NOT be memoized as done: the next schedule retries.
      builder.schedule(384);
      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await builder.whenSettled();
      expect(execCalls).toBe(2);
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('whenSettled awaits builds that are still inside the start delay', async () => {
    vi.useFakeTimers();
    try {
      let built = false;
      const fakeDb = {
        exec: async (): Promise<void> => {
          built = true;
        },
        query: async <T = unknown>(): Promise<{ rows: T[] }> => ({ rows: [] }),
      };
      const builder = createDeferredDimensionIndexBuilder({
        getDb: () => fakeDb,
        onError: () => {
          throw new Error('Index build must not fail in this test.');
        },
      });

      builder.schedule(384);
      const settled = builder.whenSettled().then(() => built);

      await vi.advanceTimersByTimeAsync(DIMENSION_INDEX_BUILD_START_DELAY_MS);
      await expect(settled).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
