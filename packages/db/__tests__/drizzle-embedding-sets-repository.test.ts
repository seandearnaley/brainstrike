/**
 * Drizzle EmbeddingSets Repository Tests
 *
 * Tests the Drizzle-based EmbeddingSetsRepository implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleEmbeddingSetsRepository } from '../src/repositories/drizzle/embedding-sets-repository.js';
import * as schema from '../src/schema/index.js';

describe('DrizzleEmbeddingSetsRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleEmbeddingSetsRepository;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector },
    });

    // Run migrations to set up schema
    await runMigrations(client);

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleEmbeddingSetsRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('getOrCreateSet', () => {
    it('should create a new embedding set', async () => {
      const result = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.modelKey).toBe('openai');
      expect(result.modelId).toBe('text-embedding-3-small');
      expect(result.dimensions).toBe(1536);
      expect(result.distance).toBe('cosine');
      expect(result.name).toBe('openai (1536D)');
    });

    it('should create with custom metadata', async () => {
      const result = await repository.getOrCreateSet('voyage', 'voyage-2', 1024, 'cosine', {
        name: 'My Custom Set',
        description: 'Test description',
        tags: 'test,voyage',
        category: 'testing',
      });

      expect(result.name).toBe('My Custom Set');
      expect(result.description).toBe('Test description');
      expect(result.tags).toBe('test,voyage');
      expect(result.category).toBe('testing');
    });

    it('should always create a new set (no dedupe)', async () => {
      const first = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      const second = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      expect(first.id).not.toBe(second.id);
    });
  });

  describe('getById', () => {
    it('should find set by id', async () => {
      const created = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const found = await repository.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.modelKey).toBe('openai');
    });

    it('should return null for non-existent id', async () => {
      const found = await repository.getById('00000000-0000-0000-0000-000000000000');

      expect(found).toBeNull();
    });
  });

  describe('getByModelKey', () => {
    it('should find sets by model key', async () => {
      await repository.getOrCreateSet('openai', 'text-embedding-3-small', 1536, 'cosine');
      await repository.getOrCreateSet('openai', 'text-embedding-3-large', 3072, 'cosine');
      await repository.getOrCreateSet('voyage', 'voyage-2', 1024, 'cosine');

      const openaiSets = await repository.getByModelKey('openai');

      expect(openaiSets).toHaveLength(2);
      expect(openaiSets.every((s) => s.modelKey === 'openai')).toBe(true);
    });

    it('should return empty array for unknown model key', async () => {
      const sets = await repository.getByModelKey('unknown');

      expect(sets).toHaveLength(0);
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata fields', async () => {
      const created = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const updated = await repository.updateMetadata(created.id, {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.description).toBe('Updated description');
    });

    it('should return null for non-existent id', async () => {
      const result = await repository.updateMetadata('00000000-0000-0000-0000-000000000000', {
        name: 'Test',
      });

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all embedding sets', async () => {
      await repository.getOrCreateSet('openai', 'text-embedding-3-small', 1536, 'cosine');
      await repository.getOrCreateSet('voyage', 'voyage-2', 1024, 'cosine');

      const all = await repository.findAll();

      expect(all).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete set by id', async () => {
      const created = await repository.getOrCreateSet(
        'openai',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const deleted = await repository.delete(created.id);

      expect(deleted).toBe(true);

      const found = await repository.getById(created.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent id', async () => {
      const deleted = await repository.delete('00000000-0000-0000-0000-000000000000');

      expect(deleted).toBe(false);
    });
  });
});
