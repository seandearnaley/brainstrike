import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('EmbeddingSetsRepository', () => {
  let db: PGlite;
  let repo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://embedding-sets');
    await migrate(db);
    repo = new EmbeddingSetsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('always creates a new set even for the same composite key', async () => {
    const set1 = await repo.getOrCreateSet(
      'transformers::Xenova/bge-base-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      768,
      'cosine'
    );
    const set2 = await repo.getOrCreateSet(
      'transformers::Xenova/bge-base-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      768,
      'cosine'
    );
    expect(set1.id).not.toBe(set2.id);
    expect(set1.dimensions).toBe(768);
    expect(set2.dimensions).toBe(768);
    expect(set1.distance).toBe('cosine');
    expect(set2.distance).toBe('cosine');
  });

  it('creates the embedding set and stats row without manual transaction statements', async () => {
    const statements: string[] = [];
    const trackedDb = {
      exec: db.exec.bind(db),
      query: async <T = unknown>(sql: string, params?: unknown): Promise<{ rows: T[] }> => {
        statements.push(sql);
        return await db.query<T>(sql, params as never);
      },
    };
    const trackedRepo = new EmbeddingSetsRepository(trackedDb);

    const set = await trackedRepo.getOrCreateSet(
      'transformers::Xenova/tracked',
      'Xenova/tracked',
      384,
      'cosine'
    );

    const stats = await db.query<{ embedding_set_id: string }>(
      'SELECT embedding_set_id FROM collection_indexing_stats WHERE embedding_set_id = $1',
      [set.id]
    );
    expect(stats.rows).toHaveLength(1);
    expect(
      statements.some((statement) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement))
    ).toBe(false);
  });

  it('getByModelKey lists sets for a key', async () => {
    await repo.getOrCreateSet(
      'transformers::Xenova/all-MiniLM-L6-v2',
      'Xenova/all-MiniLM-L6-v2',
      384,
      'cosine'
    );
    await repo.getOrCreateSet(
      'transformers::Xenova/all-MiniLM-L6-v2',
      'Xenova/all-MiniLM-L6-v2',
      384,
      'ip'
    );
    const sets = await repo.getByModelKey('transformers::Xenova/all-MiniLM-L6-v2');
    const distances = new Set(sets.map((s) => s.distance));
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(distances.has('cosine')).toBe(true);
    expect(distances.has('ip')).toBe(true);
  });

  it('getById returns specific set', async () => {
    const created = await repo.getOrCreateSet(
      'transformers::Xenova/bge-base-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      768,
      'cosine'
    );
    const fetched = await repo.getById(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('lists embedding spaces with live file, chunk, embedded chunk, and token stats', async () => {
    const embeddingSet = await repo.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      { name: 'Workspace Index' }
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, token_count, embedding_set_id)
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        'file-1',
        'one.ts',
        '/src/one.ts',
        100,
        11,
        embeddingSet.id,
        'file-2',
        'two.ts',
        '/src/two.ts',
        200,
        17,
        embeddingSet.id,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (
        id,
        file_record_id,
        chunk_index,
        content,
        token_count,
        embedding,
        embedding_set_id
      )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7),
        ($8, $9, $10, $11, $12, $13, $14),
        ($15, $16, $17, $18, $19, $20, $21),
        ($22, $23, $24, $25, $26, $27, $28)`,
      [
        'chunk-1',
        'file-1',
        0,
        'one',
        5,
        '[0.1,0.2,0.3]',
        embeddingSet.id,
        'chunk-2',
        'file-1',
        1,
        'two',
        7,
        null,
        embeddingSet.id,
        'chunk-3',
        'file-2',
        0,
        'three',
        13,
        '[0.3,0.2,0.1]',
        embeddingSet.id,
        'chunk-4',
        'file-2',
        1,
        'untokenized',
        null,
        null,
        embeddingSet.id,
      ]
    );

    const spaces = await repo.listEmbeddingSpaces({ includeStats: true });

    expect(spaces).toEqual([
      expect.objectContaining({
        id: embeddingSet.id,
        modelKey: embeddingSet.modelKey,
        modelId: 'text-embedding-3-small',
        dimensions: 1536,
        stats: expect.objectContaining({
          embeddedChunks: 2,
          fileCount: 2,
          tokenizedChunkCount: 3,
          totalChunks: 4,
          totalTokens: 25,
          averageTokensPerChunk: 25 / 3,
        }),
      }),
    ]);
  });

  it('lists embedding spaces without stats when includeStats is false', async () => {
    const embeddingSet = await repo.getOrCreateSet(
      'openai:text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      { name: 'Workspace Index' }
    );

    const spaces = await repo.listEmbeddingSpaces({ includeStats: false });

    expect(spaces).toEqual([
      expect.objectContaining({
        id: embeddingSet.id,
        modelKey: embeddingSet.modelKey,
        modelId: 'text-embedding-3-small',
        dimensions: 1536,
      }),
    ]);
    expect(spaces[0]?.stats).toBeUndefined();
  });

  it('defaults missing numeric stats to zero when listing embedding spaces with stats', async () => {
    const statements: string[] = [];
    const trackedRepo = new EmbeddingSetsRepository({
      exec: db.exec.bind(db),
      query: async <T = unknown>(sql: string): Promise<{ rows: T[] }> => {
        statements.push(sql);
        return {
          rows: [
            {
              averageTokensPerChunk: null,
              createdAt: '2026-05-15T00:00:00.000Z',
              description: null,
              dimensions: '384',
              distance: 'cosine',
              embeddedChunks: undefined,
              fileCount: null,
              id: 'set-without-stats',
              modelId: 'Xenova/all-MiniLM-L6-v2',
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              name: null,
              tokenizedChunkCount: null,
              totalChunks: undefined,
              totalTokens: null,
            },
          ] as T[],
        };
      },
    });

    await expect(trackedRepo.listEmbeddingSpaces({ includeStats: true })).resolves.toEqual([
      expect.objectContaining({
        dimensions: 384,
        stats: {
          averageTokensPerChunk: 0,
          embeddedChunks: 0,
          fileCount: 0,
          tokenizedChunkCount: 0,
          totalChunks: 0,
          totalTokens: 0,
        },
      }),
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('COUNT(token_count)::text AS tokenized_chunk_count');
  });

  it('creates one protected workspace index set with the default local embedding model', async () => {
    const first = await repo.getOrCreateWorkspaceIndexSet();
    const second = await repo.getOrCreateWorkspaceIndexSet();

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      name: 'Workspace Index',
      description: 'System-managed workspace index for assistant retrieval.',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      distance: 'cosine',
      systemRole: 'workspace-index',
    });

    const stats = await db.query<{ embedding_set_id: string }>(
      'SELECT embedding_set_id FROM collection_indexing_stats WHERE embedding_set_id = $1',
      [first.id]
    );
    expect(stats.rows).toHaveLength(1);
  });

  it('keeps workspace index bootstrap usable when dimension index creation fails', async () => {
    const trackedDb = {
      exec: vi.fn(async (sql: string): Promise<void> => {
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          throw new Error('transient index creation failure');
        }
        await db.exec(sql);
      }),
      query: db.query.bind(db),
    };
    const trackedRepo = new EmbeddingSetsRepository(trackedDb);

    const created = await trackedRepo.getOrCreateWorkspaceIndexSet();

    expect(created.systemRole).toBe('workspace-index');
    await expect(repo.getById(created.id)).resolves.toEqual(
      expect.objectContaining({ id: created.id })
    );
    // The build dispatch is deferred off the creation flow; drain it before
    // asserting the (failing) CREATE INDEX was attempted.
    await trackedRepo.waitForPendingDimensionIndexBuilds();
    expect(trackedDb.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')
    );
  });

  it('returns from set creation without waiting for the dimension index build', async () => {
    let releaseIndexBuild: (() => void) | null = null;
    const indexBuildStarted = vi.fn();
    const indexBuildGate = new Promise<void>((resolve) => {
      releaseIndexBuild = resolve;
    });
    const trackedDb = {
      exec: vi.fn(async (sql: string): Promise<void> => {
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_')) {
          indexBuildStarted();
          await indexBuildGate; // hangs until the test releases it
          return;
        }
        await db.exec(sql);
      }),
      query: db.query.bind(db),
    };
    const trackedRepo = new EmbeddingSetsRepository(trackedDb);

    // getOrCreateSet must resolve even though the HNSW build is still hanging.
    // A blocking implementation would await the gated index statement and deadlock.
    const created = await Promise.race([
      trackedRepo.getOrCreateSet('local::bge-m3', 'bge-m3', 384, 'cosine'),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('getOrCreateSet blocked on the dimension index build')),
          2000
        )
      ),
    ]);
    expect(created.dimensions).toBe(384);
    // Dispatch is deferred (DIMENSION_INDEX_BUILD_START_DELAY_MS) so the
    // creation flow's own follow-up queries reach PGlite's single connection
    // before the long CREATE INDEX: nothing has been dispatched yet here.
    expect(indexBuildStarted).not.toHaveBeenCalled();

    // Release the gate and drain via the public awaitable; the build (including
    // its start delay) must then run exactly once.
    if (!releaseIndexBuild) {
      throw new Error('Index build gate was not initialized.');
    }
    (releaseIndexBuild as () => void)();
    await trackedRepo.waitForPendingDimensionIndexBuilds();
    expect(indexBuildStarted).toHaveBeenCalledTimes(1);
  });

  it('re-arms a lost dimension index build when an existing set is read by a fresh session', async () => {
    // A set created just before app quit can lose its deferred build (250ms
    // delay + a 5-30s CREATE INDEX window on a populated table). Re-opening
    // the set must re-arm the build, or a unique-dimension set's searches
    // seq-scan indefinitely (only same-dimension creates re-schedule).
    const created = await repo.getOrCreateSet('local::bge-m3', 'bge-m3', 512, 'cosine');
    await repo.waitForPendingDimensionIndexBuilds();

    const trackedDb = {
      exec: vi.fn(async (sql: string): Promise<void> => {
        await db.exec(sql);
      }),
      query: db.query.bind(db),
    };
    // Fresh repo simulates a new app session (no in-memory builder state).
    const reopenedRepo = new EmbeddingSetsRepository(trackedDb);
    const fetched = await reopenedRepo.getById(created.id);
    expect(fetched?.dimensions).toBe(512);

    await reopenedRepo.waitForPendingDimensionIndexBuilds();
    expect(trackedDb.exec).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_512')
    );
  });

  it('keeps regular user-created sets user-owned', async () => {
    const set = await repo.getOrCreateSet(
      'openai::text-embedding-3-small',
      'text-embedding-3-small',
      1536,
      'cosine',
      { name: 'User Search Collection' }
    );

    expect(set.systemRole).toBeUndefined();

    const fetched = await repo.getById(set.id);
    expect(fetched?.systemRole).toBeUndefined();
  });

  it('enforces a single workspace index system role at the database level', async () => {
    await repo.getOrCreateWorkspaceIndexSet();

    await expect(
      db.query(
        `INSERT INTO embedding_sets (
          id,
          model_key,
          model_id,
          dimensions,
          distance,
          created_at,
          name,
          system_role
        )
        VALUES (
          'duplicate-workspace-index',
          'openai::text-embedding-3-small',
          'text-embedding-3-small',
          1536,
          'cosine',
          CURRENT_TIMESTAMP,
          'Duplicate Workspace Index',
          'workspace-index'
        )`
      )
    ).rejects.toThrow();
  });

  it('rejects invalid numeric values when listing embedding spaces', async () => {
    const trackedRepo = new EmbeddingSetsRepository({
      exec: db.exec.bind(db),
      query: async <T = unknown>(): Promise<{ rows: T[] }> => ({
        rows: [
          {
            averageTokensPerChunk: '0',
            createdAt: '2026-05-15T00:00:00.000Z',
            description: null,
            dimensions: 'not-a-number',
            distance: 'cosine',
            embeddedChunks: '0',
            fileCount: '0',
            id: 'invalid-dimensions',
            modelId: 'Xenova/all-MiniLM-L6-v2',
            modelKey: 'local::Xenova/all-MiniLM-L6-v2',
            name: null,
            tokenizedChunkCount: '0',
            totalChunks: '0',
            totalTokens: '0',
          },
        ] as T[],
      }),
    });

    await expect(trackedRepo.listEmbeddingSpaces({ includeStats: true })).rejects.toThrow(
      'Invalid embedding space dimensions: not-a-number'
    );
  });

  describe('metadata', () => {
    it('creates set with default name when metadata not provided', async () => {
      const set = await repo.getOrCreateSet(
        'transformers::jinaai/jina-embeddings-v2-base-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine'
      );
      expect(set.name).toBe('jinaai/jina-embeddings-v2-base-code (768D)');
      expect(set.description).toBeUndefined();
      expect(set.tags).toBeUndefined();
      expect(set.category).toBeUndefined();
    });

    it('creates set with custom metadata', async () => {
      const metadata = {
        name: 'Code Embeddings',
        description: 'For code search and analysis',
        tags: 'code,programming',
        category: 'development',
      };
      const set = await repo.getOrCreateSet(
        'transformers::jinaai/jina-embeddings-v2-base-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine',
        metadata
      );
      expect(set.name).toBe('Code Embeddings');
      expect(set.description).toBe('For code search and analysis');
      expect(set.tags).toBe('code,programming');
      expect(set.category).toBe('development');
    });

    it('updates set metadata', async () => {
      const set = await repo.getOrCreateSet(
        'transformers::Xenova/bge-base-en-v1.5',
        'Xenova/bge-base-en-v1.5',
        768,
        'cosine'
      );
      expect(set.name).toBe('Xenova/bge-base-en-v1.5 (768D)');

      const updated = await repo.updateMetadata(set.id, {
        name: 'General Purpose Embeddings',
        description: 'Multi-lingual general purpose model',
        tags: 'multilingual,general',
        category: 'general-text',
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('General Purpose Embeddings');
      expect(updated?.description).toBe('Multi-lingual general purpose model');
      expect(updated?.tags).toBe('multilingual,general');
      expect(updated?.category).toBe('general-text');
    });

    it('updates partial metadata', async () => {
      const set = await repo.getOrCreateSet(
        'transformers::Xenova/all-MiniLM-L6-v2',
        'Xenova/all-MiniLM-L6-v2',
        384,
        'cosine',
        {
          name: 'Original Name',
          description: 'Original Description',
        }
      );

      const updated = await repo.updateMetadata(set.id, {
        description: 'Updated Description',
      });

      expect(updated?.name).toBe('Original Name');
      expect(updated?.description).toBe('Updated Description');
    });

    it('getById returns metadata fields', async () => {
      const created = await repo.getOrCreateSet(
        'voyage::voyage-3-lite',
        'voyage-3-lite',
        512,
        'l2',
        {
          name: 'Test Embeddings',
          description: 'Test description',
          tags: 'test,example',
          category: 'testing',
        }
      );

      const fetched = await repo.getById(created.id);
      expect(fetched?.name).toBe('Test Embeddings');
      expect(fetched?.description).toBe('Test description');
      expect(fetched?.tags).toBe('test,example');
      expect(fetched?.category).toBe('testing');
    });

    it('repairs legacy malformed metadata using the model registry', async () => {
      const insert = await db.query<{ id: string }>(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
         VALUES ('legacy-set', 'Xenova/all-MiniLM-L6-v2', 'all-MiniLM-L6-v2', 384, 'cosine', CURRENT_TIMESTAMP)
         RETURNING id`
      );
      expect(insert.rows[0]?.id).toBe('legacy-set');

      const fetched = await repo.getById('legacy-set');

      expect(fetched).toMatchObject({
        id: 'legacy-set',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        modelId: 'Xenova/all-MiniLM-L6-v2',
      });

      const repaired = await db.query<{ model_id: string; model_key: string }>(
        'SELECT model_key, model_id FROM embedding_sets WHERE id = $1',
        ['legacy-set']
      );
      expect(repaired.rows[0]).toEqual({
        model_key: 'local::Xenova/all-MiniLM-L6-v2',
        model_id: 'Xenova/all-MiniLM-L6-v2',
      });
    });
  });
});
