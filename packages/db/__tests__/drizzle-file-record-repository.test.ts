/**
 * Drizzle FileRecord Repository Tests
 *
 * Tests the Drizzle-based FileRecordRepository implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleFileRecordRepository } from '../src/repositories/drizzle/file-record-repository.js';
import * as schema from '../src/schema/index.js';

describe('DrizzleFileRecordRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleFileRecordRepository;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector },
    });

    // Run migrations to set up schema
    await runMigrations(client);

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleFileRecordRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('create and find', () => {
    it('should create a file record and find it by id', async () => {
      const now = new Date().toISOString();
      const record = {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'test.ts',
        path: '/src/test.ts',
        size: 1024,
        createdAt: now,
        updatedAt: now,
      };

      await repository.create(record);
      const found = await repository.findById(record.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(record.id);
      expect(found?.name).toBe('test.ts');
      expect(found?.path).toBe('/src/test.ts');
      expect(found?.size).toBe(1024);
    });

    it('should create with content and find by content hash', async () => {
      const now = new Date().toISOString();
      const record = {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'content.ts',
        path: '/src/content.ts',
        sourceRootPath: '/workspace/a',
        size: 100,
        createdAt: now,
        updatedAt: now,
        content: 'const hello = "world";',
        contentHash: 'abc123hash',
        tokenCount: 5,
        processedAt: now,
      };

      await repository.createWithContent(record);
      const found = await repository.findByContentHash('abc123hash');

      expect(found).toBeDefined();
      expect(found?.contentHash).toBe('abc123hash');
      expect(found?.content).toBe('const hello = "world";');
      expect(found?.tokenCount).toBe(5);
      expect(found?.sourceRootPath).toBe('/workspace/a');
    });

    it('should return null for non-existent id', async () => {
      const found = await repository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all file records', async () => {
      const now = new Date().toISOString();

      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'file2.ts',
        path: '/src/file2.ts',
        size: 200,
        createdAt: now,
        updatedAt: now,
      });

      const all = await repository.findAll();
      expect(all).toHaveLength(2);
    });

    it('should return records with content when using findAllWithContent', async () => {
      const now = new Date().toISOString();

      // Record with content
      await repository.createWithContent({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'with-content.ts',
        path: '/src/with-content.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
        content: 'const x = 1;',
        contentHash: 'hash1',
        tokenCount: 3,
        processedAt: now,
      });

      // Record without content
      await repository.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'no-content.ts',
        path: '/src/no-content.ts',
        size: 50,
        createdAt: now,
        updatedAt: now,
      });

      const withContent = await repository.findAllWithContent();
      expect(withContent).toHaveLength(1);
      expect(withContent[0]?.name).toBe('with-content.ts');
    });
  });

  describe('managed cache identity', () => {
    it('should find a managed cache entry by collection, root, and relative path', async () => {
      const now = new Date().toISOString();

      await repository.create({
        id: '00000000-0000-0000-0000-000000000011',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/a',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.create({
        id: '00000000-0000-0000-0000-000000000012',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/b',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      const found = await repository.findByManagedCacheIdentity(
        '00000000-0000-0000-0000-000000000101',
        '/workspace/a',
        'src/index.ts'
      );

      expect(found?.id).toBe('00000000-0000-0000-0000-000000000011');
      expect(found?.sourceRootPath).toBe('/workspace/a');
    });

    it('should list managed cache entries across roots for a collection', async () => {
      const now = new Date().toISOString();

      await repository.create({
        id: '00000000-0000-0000-0000-000000000021',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/a',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.create({
        id: '00000000-0000-0000-0000-000000000022',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/b',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.create({
        id: '00000000-0000-0000-0000-000000000023',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/c',
        embeddingSetId: '00000000-0000-0000-0000-000000000202',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      const entries = await repository.listManagedCacheEntries(
        '00000000-0000-0000-0000-000000000101'
      );

      expect(entries.map((entry) => entry.id).sort()).toEqual([
        '00000000-0000-0000-0000-000000000021',
        '00000000-0000-0000-0000-000000000022',
      ]);
    });

    it('should list managed cache metadata without selecting content', async () => {
      const now = new Date().toISOString();

      await repository.createWithContent({
        id: '00000000-0000-0000-0000-000000000031',
        name: 'index.ts',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/a',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        size: 100,
        createdAt: now,
        updatedAt: now,
        content: 'export const value = 1;',
        contentHash: 'hash-1',
        tokenCount: 5,
        processedAt: now,
      });

      const entries = await repository.listManagedCacheEntryMetadata(
        '00000000-0000-0000-0000-000000000101'
      );

      expect(entries).toEqual([
        expect.objectContaining({
          fileRecordId: '00000000-0000-0000-0000-000000000031',
          embeddingSetId: '00000000-0000-0000-0000-000000000101',
          sourceRootPath: '/workspace/a',
          relativePath: 'src/index.ts',
          contentHash: 'hash-1',
        }),
      ]);
    });
  });

  describe('update', () => {
    it('should update file record fields', async () => {
      const now = new Date().toISOString();
      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'original.ts',
        path: '/src/original.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.update('00000000-0000-0000-0000-000000000001', {
        name: 'renamed.ts',
        size: 200,
      });

      const updated = await repository.findById('00000000-0000-0000-0000-000000000001');
      expect(updated?.name).toBe('renamed.ts');
      expect(updated?.size).toBe(200);
    });

    it('should update content via updateContent', async () => {
      const now = new Date().toISOString();
      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file.ts',
        path: '/src/file.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.updateContent(
        '00000000-0000-0000-0000-000000000001',
        'const updated = true;',
        'newhash123',
        4
      );

      const updated = await repository.findById('00000000-0000-0000-0000-000000000001');
      expect(updated?.content).toBe('const updated = true;');
      expect(updated?.contentHash).toBe('newhash123');
      expect(updated?.tokenCount).toBe(4);
      expect(updated?.processedAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete a file record', async () => {
      const now = new Date().toISOString();
      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'to-delete.ts',
        path: '/src/to-delete.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.delete('00000000-0000-0000-0000-000000000001');
      const found = await repository.findById('00000000-0000-0000-0000-000000000001');
      expect(found).toBeNull();
    });
  });

  describe('count', () => {
    it('should count all records', async () => {
      const now = new Date().toISOString();

      expect(await repository.count()).toBe(0);

      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      expect(await repository.count()).toBe(1);
    });

    it('should count records with content', async () => {
      const now = new Date().toISOString();

      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'no-content.ts',
        path: '/src/no-content.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.createWithContent({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'with-content.ts',
        path: '/src/with-content.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
        content: 'const x = 1;',
        contentHash: 'hash1',
        tokenCount: 3,
        processedAt: now,
      });

      expect(await repository.count()).toBe(2);
      expect(await repository.countWithContent()).toBe(1);
    });
  });

  describe('bulkImport', () => {
    it('should import multiple files', async () => {
      const requests = [
        { name: 'file1.ts', path: '/src/file1.ts', size: 100, content: 'const a = 1;' },
        { name: 'file2.ts', path: '/src/file2.ts', size: 200, content: 'const b = 2;' },
        { name: 'file3.ts', path: '/src/file3.ts', size: 300, content: 'const c = 3;' },
      ];

      const results = await repository.bulkImport(requests);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.imported)).toBe(true);
      expect(await repository.count()).toBe(3);
    });

    it('should detect duplicates by content hash', async () => {
      const content = 'const same = true;';
      const requests = [
        { name: 'file1.ts', path: '/src/file1.ts', size: 100, content },
        { name: 'file2.ts', path: '/src/file2.ts', size: 100, content }, // Same content
      ];

      const results = await repository.bulkImport(requests);

      expect(results[0]?.imported).toBe(true);
      expect(results[1]?.existed).toBe(true);
      expect(await repository.count()).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all records and return count', async () => {
      const now = new Date().toISOString();

      await repository.create({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        createdAt: now,
        updatedAt: now,
      });

      await repository.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'file2.ts',
        path: '/src/file2.ts',
        size: 200,
        createdAt: now,
        updatedAt: now,
      });

      const cleared = await repository.clearAll();
      expect(cleared).toBe(2);
      expect(await repository.count()).toBe(0);
    });
  });
});
