import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
