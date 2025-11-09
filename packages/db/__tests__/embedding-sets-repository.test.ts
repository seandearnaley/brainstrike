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
    const set1 = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    const set2 = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    expect(set1.id).not.toBe(set2.id);
    expect(set1.dimensions).toBe(1024);
    expect(set2.dimensions).toBe(1024);
    expect(set1.distance).toBe('cosine');
    expect(set2.distance).toBe('cosine');
  });

  it('getByModelKey lists sets for a key', async () => {
    await repo.getOrCreateSet('miniLM', 'Xenova/all-MiniLM-L6-v2', 384, 'cosine');
    await repo.getOrCreateSet('miniLM', 'Xenova/all-MiniLM-L6-v2', 384, 'ip');
    const sets = await repo.getByModelKey('miniLM');
    const distances = new Set(sets.map((s) => s.distance));
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(distances.has('cosine')).toBe(true);
    expect(distances.has('ip')).toBe(true);
  });

  it('getById returns specific set', async () => {
    const created = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    const fetched = await repo.getById(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  describe('metadata', () => {
    it('creates set with default name when metadata not provided', async () => {
      const set = await repo.getOrCreateSet(
        'jina-code',
        'jinaai/jina-embeddings-v2-base-code',
        768,
        'cosine'
      );
      expect(set.name).toBe('jina-code (768D)');
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
        'jina-code',
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
      const set = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
      expect(set.name).toBe('bge-m3 (1024D)');

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
      const set = await repo.getOrCreateSet('miniLM', 'Xenova/all-MiniLM-L6-v2', 384, 'cosine', {
        name: 'Original Name',
        description: 'Original Description',
      });

      const updated = await repo.updateMetadata(set.id, {
        description: 'Updated Description',
      });

      expect(updated?.name).toBe('Original Name');
      expect(updated?.description).toBe('Updated Description');
    });

    it('getById returns metadata fields', async () => {
      const created = await repo.getOrCreateSet('test', 'test-model', 512, 'l2', {
        name: 'Test Embeddings',
        description: 'Test description',
        tags: 'test,example',
        category: 'testing',
      });

      const fetched = await repo.getById(created.id);
      expect(fetched?.name).toBe('Test Embeddings');
      expect(fetched?.description).toBe('Test description');
      expect(fetched?.tags).toBe('test,example');
      expect(fetched?.category).toBe('testing');
    });
  });
});
