/**
 * Drizzle FileRecord Repository Tests
 *
 * Tests the Drizzle-based FileRecordRepository implementation.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseQueryTelemetry } from '../src/database-query-telemetry.js';
import { DrizzleFileRecordRepository } from '../src/repositories/drizzle/file-record-repository.js';
import * as schema from '../src/schema/index.js';
import {
  QUICK_OPEN_MAX_LIMIT,
  QUICK_OPEN_NAME_SEARCH_SQL,
  type QuickOpenFileRow,
} from '../src/search/quick-open-query.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('DrizzleFileRecordRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleFileRecordRepository;

  beforeEach(async () => {
    client = await createMigratedTestDb();

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleFileRecordRepository(db);
  });

  // Managed-cache identity is root_id since the source_root_path retirement.
  // repository.create never writes root_id (only applyManagedCacheBatch does),
  // so seed a roots row and stamp root_id via the raw PGlite client.
  async function seedManagedCacheEntry(args: {
    id: string;
    embeddingSetId: string;
    path: string;
    rootId: string;
    contentHash?: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO roots (id, kind, display_name) VALUES ($1, 'path', 'fixture') ON CONFLICT (id) DO NOTHING`,
      [args.rootId]
    );
    const now = new Date().toISOString();
    await repository.createWithContent({
      content: 'export const value = 1;',
      contentHash: args.contentHash ?? 'hash-1',
      createdAt: now,
      embeddingSetId: args.embeddingSetId,
      id: args.id,
      name: 'index.ts',
      path: args.path,
      processedAt: now,
      size: 100,
      tokenCount: 5,
      updatedAt: now,
    });
    await client.query('UPDATE file_records SET root_id = $1 WHERE id = $2', [
      args.rootId,
      args.id,
    ]);
  }

  afterEach(async () => {
    await client.close();
  });

  describe('create and find', () => {
    it('should create a file record and find it by id', async () => {
      const now = new Date().toISOString();
      const record = {
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'test.ts',
        path: '/src/test.ts',
        size: 1024,
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
        content: 'const hello = "world";',
        contentHash: 'abc123hash',
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'content.ts',
        path: '/src/content.ts',
        processedAt: now,
        size: 100,
        tokenCount: 5,
        updatedAt: now,
      };

      await repository.createWithContent(record);
      const found = await repository.findByContentHash('abc123hash');

      expect(found).toBeDefined();
      expect(found?.contentHash).toBe('abc123hash');
      expect(found?.content).toBe('const hello = "world";');
      expect(found?.tokenCount).toBe(5);
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
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        updatedAt: now,
      });

      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'file2.ts',
        path: '/src/file2.ts',
        size: 200,
        updatedAt: now,
      });

      const all = await repository.findAll();
      expect(all).toHaveLength(2);
    });

    it('should return records with content when using findAllWithContent', async () => {
      const now = new Date().toISOString();

      // Record with content
      await repository.createWithContent({
        content: 'const x = 1;',
        contentHash: 'hash1',
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'with-content.ts',
        path: '/src/with-content.ts',
        processedAt: now,
        size: 100,
        tokenCount: 3,
        updatedAt: now,
      });

      // Record without content
      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'no-content.ts',
        path: '/src/no-content.ts',
        size: 50,
        updatedAt: now,
      });

      const withContent = await repository.findAllWithContent();
      expect(withContent).toHaveLength(1);
      expect(withContent[0]?.name).toBe('with-content.ts');
    });
  });

  describe('managed cache identity', () => {
    it('should find a managed cache entry by collection, root id, and relative path', async () => {
      await seedManagedCacheEntry({
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        id: '00000000-0000-0000-0000-000000000011',
        path: 'src/index.ts',
        rootId: 'root-a',
      });
      // Same relative path under a DIFFERENT root — must stay distinct.
      await seedManagedCacheEntry({
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        id: '00000000-0000-0000-0000-000000000012',
        path: 'src/index.ts',
        rootId: 'root-b',
      });

      const found = await repository.findByManagedCacheIdentity(
        '00000000-0000-0000-0000-000000000101',
        'root-a',
        'src/index.ts'
      );

      expect(found?.id).toBe('00000000-0000-0000-0000-000000000011');
    });

    it('should list managed cache entries across roots for a collection', async () => {
      await seedManagedCacheEntry({
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        id: '00000000-0000-0000-0000-000000000021',
        path: 'src/index.ts',
        rootId: 'root-a',
      });
      await seedManagedCacheEntry({
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        id: '00000000-0000-0000-0000-000000000022',
        path: 'src/index.ts',
        rootId: 'root-b',
      });
      await seedManagedCacheEntry({
        embeddingSetId: '00000000-0000-0000-0000-000000000202',
        id: '00000000-0000-0000-0000-000000000023',
        path: 'src/index.ts',
        rootId: 'root-c',
      });

      const telemetryBefore = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      const entries = await repository.listManagedCacheEntries(
        '00000000-0000-0000-0000-000000000101'
      );

      expect(entries.map((entry) => entry.id).sort()).toEqual([
        '00000000-0000-0000-0000-000000000021',
        '00000000-0000-0000-0000-000000000022',
      ]);
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(
        telemetryBefore + 1
      );
    });

    it('should list managed cache metadata without selecting content', async () => {
      await seedManagedCacheEntry({
        contentHash: 'hash-1',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        id: '00000000-0000-0000-0000-000000000031',
        path: 'src/index.ts',
        rootId: 'root-a',
      });

      const telemetryBefore = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      const entries = await repository.listManagedCacheEntryMetadata(
        '00000000-0000-0000-0000-000000000101'
      );

      expect(entries).toEqual([
        expect.objectContaining({
          contentHash: 'hash-1',
          embeddingSetId: '00000000-0000-0000-0000-000000000101',
          fileRecordId: '00000000-0000-0000-0000-000000000031',
          relativePath: 'src/index.ts',
          rootId: 'root-a',
        }),
      ]);
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(
        telemetryBefore + 1
      );
    });
  });

  describe('updateStatMetadata', () => {
    it('stamps stats for many rows in a single batched statement', async () => {
      const now = new Date().toISOString();
      for (const suffix of ['a', 'b', 'c']) {
        await repository.createWithContent({
          content: `export const ${suffix} = 1;`,
          contentHash: `hash-${suffix}`,
          createdAt: now,
          embeddingSetId: '00000000-0000-0000-0000-000000000101',
          id: `00000000-0000-0000-0000-00000000004${suffix}`,
          name: `${suffix}.ts`,
          path: `src/${suffix}.ts`,
          size: 10,
          tokenCount: 5,
          updatedAt: now,
        });
      }
      // Stamp the managed-cache identity (root_id) — createWithContent doesn't
      // set it, and listManagedCacheEntryMetadata only returns root_id rows.
      await client.query(
        `INSERT INTO roots (id, kind, display_name) VALUES ('root-stamp', 'path', 'fixture')`
      );
      await client.query(
        "UPDATE file_records SET root_id = 'root-stamp' WHERE embedding_set_id = '00000000-0000-0000-0000-000000000101'"
      );

      // The stamp fires for EVERY pre-migration row on the first post-upgrade
      // sync — thousands of rows on PGlite's single connection — so it must be
      // one batched statement, not N serial round-trips.
      const querySpy = vi.spyOn(client, 'query');
      await repository.updateStatMetadata([
        { fileRecordId: '00000000-0000-0000-0000-00000000004a', mtimeMs: 1000.7, size: 11 },
        { fileRecordId: '00000000-0000-0000-0000-00000000004b', mtimeMs: 2000, size: 12 },
        { fileRecordId: '00000000-0000-0000-0000-00000000004c', mtimeMs: 3000, size: 13 },
      ]);
      expect(querySpy).toHaveBeenCalledTimes(1);
      querySpy.mockRestore();

      const entries = await repository.listManagedCacheEntryMetadata(
        '00000000-0000-0000-0000-000000000101'
      );
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileRecordId: '00000000-0000-0000-0000-00000000004a',
            mtimeMs: 1000,
            size: 11,
          }),
          expect.objectContaining({
            fileRecordId: '00000000-0000-0000-0000-00000000004b',
            mtimeMs: 2000,
            size: 12,
          }),
          expect.objectContaining({
            fileRecordId: '00000000-0000-0000-0000-00000000004c',
            mtimeMs: 3000,
            size: 13,
          }),
        ])
      );
    });

    it('no-ops on an empty batch', async () => {
      await expect(repository.updateStatMetadata([])).resolves.toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update file record fields', async () => {
      const now = new Date().toISOString();
      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'original.ts',
        path: '/src/original.ts',
        size: 100,
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
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file.ts',
        path: '/src/file.ts',
        size: 100,
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

    it('rejects null bytes in content updates before PGlite', async () => {
      const now = new Date().toISOString();
      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000099',
        name: 'file.ts',
        path: '/src/file.ts',
        size: 100,
        updatedAt: now,
      });

      await expect(
        repository.updateContent(
          '00000000-0000-0000-0000-000000000099',
          `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
          'hash-null-update',
          1
        )
      ).rejects.toThrow('File record content cannot contain null bytes.');
    });
  });

  describe('delete', () => {
    it('should delete a file record', async () => {
      const now = new Date().toISOString();
      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'to-delete.ts',
        path: '/src/to-delete.ts',
        size: 100,
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
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        updatedAt: now,
      });

      expect(await repository.count()).toBe(1);
    });

    it('should count records with content', async () => {
      const now = new Date().toISOString();

      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'no-content.ts',
        path: '/src/no-content.ts',
        size: 100,
        updatedAt: now,
      });

      await repository.createWithContent({
        content: 'const x = 1;',
        contentHash: 'hash1',
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'with-content.ts',
        path: '/src/with-content.ts',
        processedAt: now,
        size: 100,
        tokenCount: 3,
        updatedAt: now,
      });

      const telemetryBefore = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      expect(await repository.count()).toBe(2);
      expect(await repository.countWithContent()).toBe(1);
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(
        telemetryBefore + 2
      );
    });
  });

  describe('bulkImport', () => {
    it('should import multiple files', async () => {
      const requests = [
        { content: 'const a = 1;', name: 'file1.ts', path: '/src/file1.ts', size: 100 },
        { content: 'const b = 2;', name: 'file2.ts', path: '/src/file2.ts', size: 200 },
        { content: 'const c = 3;', name: 'file3.ts', path: '/src/file3.ts', size: 300 },
      ];

      const before = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      const results = await repository.bulkImport(requests);
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(before + 1);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.imported)).toBe(true);
      expect(await repository.count()).toBe(3);
    });

    it('reports null-byte content as batch errors before records reach PGlite', async () => {
      const results = await repository.bulkImport([
        { content: 'const clean = true;', name: 'clean.ts', path: '/src/clean.ts', size: 10 },
        {
          content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
          name: 'late-null.ts',
          path: '/src/late-null.ts',
          size: 620,
        },
      ]);

      expect(results.map((result) => result.error)).toEqual([
        'Batch failed: File record content cannot contain null bytes.',
        'Batch failed: File record content cannot contain null bytes.',
      ]);
      expect(await repository.count()).toBe(0);
    });

    it('should detect duplicates by content hash', async () => {
      const content = 'const same = true;';
      const requests = [
        { content, name: 'file1.ts', path: '/src/file1.ts', size: 100 },
        { content, name: 'file2.ts', path: '/src/file2.ts', size: 100 }, // Same content
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
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000001',
        name: 'file1.ts',
        path: '/src/file1.ts',
        size: 100,
        updatedAt: now,
      });

      await repository.create({
        createdAt: now,
        id: '00000000-0000-0000-0000-000000000002',
        name: 'file2.ts',
        path: '/src/file2.ts',
        size: 200,
        updatedAt: now,
      });

      const telemetryBefore = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      const cleared = await repository.clearAll();
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(
        telemetryBefore + 1
      );
      expect(cleared).toBe(2);
      expect(await repository.count()).toBe(0);
    });
  });

  describe('findByNameSubstring (quick-open)', () => {
    // Seeds a roots row + a file_records row stamped with that root_id. Mirrors
    // the managed-cache identity: repository.create never writes root_id, so we
    // stamp it via the raw client (the same approach as seedManagedCacheEntry).
    async function seedFile(args: {
      id: string;
      name: string;
      path: string;
      rootId?: string;
      rootDisplayName?: string;
    }): Promise<void> {
      if (args.rootId) {
        await client.query(
          `INSERT INTO roots (id, kind, display_name) VALUES ($1, 'path', $2)
           ON CONFLICT (id) DO NOTHING`,
          [args.rootId, args.rootDisplayName ?? args.rootId]
        );
      }
      const now = new Date().toISOString();
      await repository.create({
        createdAt: now,
        id: args.id,
        name: args.name,
        path: args.path,
        size: 100,
        updatedAt: now,
      });
      if (args.rootId) {
        await client.query('UPDATE file_records SET root_id = $1 WHERE id = $2', [
          args.rootId,
          args.id,
        ]);
      }
    }

    it('returns substring name matches ranked by shortest name then path', async () => {
      await seedFile({
        id: 'r1',
        name: 'readme.md',
        path: 'docs/readme.md',
        rootDisplayName: 'Alpha',
        rootId: 'root-a',
      });
      await seedFile({
        id: 'r2',
        name: 'read-stream.ts',
        path: 'src/read-stream.ts',
        rootDisplayName: 'Alpha',
        rootId: 'root-a',
      });
      await seedFile({
        id: 'r3',
        name: 'unrelated.ts',
        path: 'src/unrelated.ts',
        rootDisplayName: 'Alpha',
        rootId: 'root-a',
      });

      const telemetryBefore = databaseQueryTelemetry.snapshot().features['file-tree'].queryCount;
      const results = await repository.findByNameSubstring('read', 50);

      // Only the two 'read*' rows match; 'readme.md' (9 chars) sorts before
      // 'read-stream.ts' (14 chars).
      expect(results.map((row) => row.name)).toEqual(['readme.md', 'read-stream.ts']);
      expect(results[0]?.display_name).toBe('Alpha');
      expect(results[0]?.root_id).toBe('root-a');
      expect(databaseQueryTelemetry.snapshot().features['file-tree'].queryCount).toBe(
        telemetryBefore + 1
      );
    });

    it('returns TWO distinct rows for the same relative path in two roots', async () => {
      // Multi-root correctness: identical name + relative path under two roots
      // must come back as two rows with distinct root_id / display_name.
      await seedFile({
        id: 'a-index',
        name: 'index.ts',
        path: 'src/index.ts',
        rootDisplayName: 'Alpha',
        rootId: 'root-a',
      });
      await seedFile({
        id: 'b-index',
        name: 'index.ts',
        path: 'src/index.ts',
        rootDisplayName: 'Beta',
        rootId: 'root-b',
      });

      const results = await repository.findByNameSubstring('index', 50);

      expect(results).toHaveLength(2);
      const byRoot = new Map(results.map((row) => [row.root_id, row]));
      expect(byRoot.get('root-a')?.display_name).toBe('Alpha');
      expect(byRoot.get('root-b')?.display_name).toBe('Beta');
      // Distinct file_records ids — the open path can disambiguate by root.
      expect(new Set(results.map((row) => row.id)).size).toBe(2);
    });

    it('labels legacy NULL root_id rows with a NULL display_name (honest)', async () => {
      await seedFile({ id: 'legacy', name: 'legacy.ts', path: 'legacy.ts' });

      const results = await repository.findByNameSubstring('legacy', 50);

      expect(results).toHaveLength(1);
      expect(results[0]?.root_id).toBeNull();
      expect(results[0]?.display_name).toBeNull();
    });

    it('returns an empty list when nothing matches', async () => {
      await seedFile({
        id: 'only',
        name: 'only.ts',
        path: 'only.ts',
        rootId: 'root-a',
      });

      const results = await repository.findByNameSubstring('zzz-no-match', 50);
      expect(results).toEqual([]);
    });

    it('clamps the limit to the bounded maximum', async () => {
      for (let i = 0; i < 60; i++) {
        await seedFile({
          id: `bulk-${i}`,
          name: `match-${i}.ts`,
          path: `src/match-${i}.ts`,
          rootId: 'root-a',
        });
      }

      const results = await repository.findByNameSubstring('match', 1000);
      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('uses the trigram index created by migration 048', async () => {
      const index = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'file_records'`
      );
      expect(index.rows.map((row) => row.indexname)).toContain('idx_file_records_name_trgm');
    });

    it('matches the renderer raw SQL row-for-row (drift guard between the two impls)', async () => {
      // The repo rebuilds the shared SQL with the Drizzle builder; the renderer
      // runs QUICK_OPEN_NAME_SEARCH_SQL verbatim. Assert they agree so the two
      // implementations can never silently diverge.
      await seedFile({
        id: 'q1',
        name: 'query.ts',
        path: 'src/query.ts',
        rootDisplayName: 'Alpha',
        rootId: 'root-a',
      });
      await seedFile({
        id: 'q2',
        name: 'query-builder.ts',
        path: 'src/query-builder.ts',
        rootDisplayName: 'Beta',
        rootId: 'root-b',
      });
      await seedFile({ id: 'q3', name: 'unmatched.ts', path: 'src/unmatched.ts' });

      const viaRepo = await repository.findByNameSubstring('query', QUICK_OPEN_MAX_LIMIT);
      const viaRawSql = await client.query<QuickOpenFileRow>(QUICK_OPEN_NAME_SEARCH_SQL, [
        'query',
        QUICK_OPEN_MAX_LIMIT,
      ]);

      expect(viaRepo).toEqual(viaRawSql.rows);
    });
  });
});
