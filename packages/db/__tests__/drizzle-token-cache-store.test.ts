/**
 * Drizzle TokenCacheStore Tests
 *
 * Tests the Drizzle-based TokenCacheStore implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import {
  DrizzleTokenCacheStore,
  type TokenCacheEntry,
} from '../src/repositories/drizzle/token-cache-store.js';
import * as schema from '../src/schema/index.js';

describe('DrizzleTokenCacheStore', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: DrizzleTokenCacheStore;

  const testFolderId = 'test-folder-001';

  function createEntry(overrides: Partial<TokenCacheEntry> = {}): TokenCacheEntry {
    return {
      contentHash: 'abc123',
      countingMode: 'accurate',
      createdAt: new Date().toISOString(),
      filePath: 'src/test.ts',
      fileSize: 1024,
      folderId: testFolderId,
      modelEncoding: 'o200k_base',
      mtimeMs: Date.now(),
      tokenCount: 100,
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    client = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });

    const migrationResult = await runMigrations(client);
    if (!migrationResult.success) {
      throw new Error(`Migrations failed: ${migrationResult.error}`);
    }
    db = drizzle(client, { schema });
    store = new DrizzleTokenCacheStore(db);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('get and set', () => {
    it('should set and get a single entry', async () => {
      const entry = createEntry({ filePath: 'src/file1.ts' });

      await store.set(entry);
      const found = await store.get(testFolderId, 'src/file1.ts');

      expect(found).toBeDefined();
      expect(found?.filePath).toBe('src/file1.ts');
      expect(found?.tokenCount).toBe(100);
      expect(found?.countingMode).toBe('accurate');
    });

    it('should return null for non-existent entry', async () => {
      const found = await store.get(testFolderId, 'non-existent.ts');
      expect(found).toBeNull();
    });

    it('should upsert on conflict', async () => {
      const entry1 = createEntry({ filePath: 'src/file.ts', tokenCount: 100 });
      await store.set(entry1);

      const entry2 = createEntry({ filePath: 'src/file.ts', tokenCount: 200 });
      await store.set(entry2);

      const found = await store.get(testFolderId, 'src/file.ts');
      expect(found?.tokenCount).toBe(200);
    });

    it('returns ISO UTC text timestamps after insert and conflict update', async () => {
      const isoUtcTextTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

      await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 100 }));
      const inserted = await store.get(testFolderId, 'src/file.ts');

      expect(inserted?.createdAt).toMatch(isoUtcTextTimestamp);
      expect(inserted?.updatedAt).toMatch(isoUtcTextTimestamp);

      await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 200 }));
      const updated = await store.get(testFolderId, 'src/file.ts');

      expect(updated?.createdAt).toMatch(isoUtcTextTimestamp);
      expect(updated?.updatedAt).toMatch(isoUtcTextTimestamp);
    });

    it('rejects malformed stored text timestamps when reading rows', async () => {
      await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 100 }));
      await client.query(
        `UPDATE file_token_cache SET created_at = 'CURRENT_TIMESTAMP' WHERE folder_id = $1 AND file_path = $2`,
        [testFolderId, 'src/file.ts']
      );

      await expect(store.get(testFolderId, 'src/file.ts')).rejects.toThrow(
        'textTimestamp: invalid stored value "CURRENT_TIMESTAMP"'
      );
    });
  });

  describe('file path validation', () => {
    it('rejects unsafe file paths before writes', async () => {
      const invalidPaths = [
        '',
        '   ',
        '/absolute/path.ts',
        '../escape.ts',
        'src/../escape.ts',
        'src//double-slash.ts',
        'src/folder/',
        './relative-dot.ts',
        'C:\\secret.ts',
        '\\\\server\\share\\payload.ts',
        'src/\0null-byte.ts',
        'src/foo\tbar.ts',
      ];

      for (const invalidPath of invalidPaths) {
        await expect(store.set(createEntry({ filePath: invalidPath }))).rejects.toThrow();
      }

      const entries = await store.getAllForFolder(testFolderId);
      expect(entries).toHaveLength(0);
    });

    it('rejects unsafe paths for reads and aggregates', async () => {
      await store.set(createEntry({ filePath: 'src/valid.ts', tokenCount: 100 }));

      await expect(store.get(testFolderId, '../escape.ts')).rejects.toThrow(
        'Token cache file path must not contain relative traversal segments'
      );
      await expect(store.getBatch(testFolderId, ['src/valid.ts', '/absolute.ts'])).rejects.toThrow(
        'Token cache file path must be relative'
      );
      await expect(
        store.getTotalTokens(testFolderId, ['src/valid.ts', 'src/foo\tbar.ts'])
      ).rejects.toThrow('Token cache file path must not contain control characters');
      await expect(store.delete(testFolderId, 'C:\\windows\\abs.ts')).rejects.toThrow(
        'Token cache file path must be relative'
      );

      const stillPresent = await store.get(testFolderId, 'src/valid.ts');
      expect(stillPresent).not.toBeNull();
    });

    it('does not persist setBatch entries when any path is invalid', async () => {
      const entries = [
        createEntry({ filePath: 'src/valid.ts', tokenCount: 100 }),
        createEntry({ filePath: '../escape.ts', tokenCount: 200 }),
      ];

      await expect(store.setBatch(entries)).rejects.toThrow(
        'Token cache file path must not contain relative traversal segments'
      );

      const validEntry = await store.get(testFolderId, 'src/valid.ts');
      expect(validEntry).toBeNull();
    });
  });

  describe('getBatch', () => {
    it('should get multiple entries in one query', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts', tokenCount: 100 }));
      await store.set(createEntry({ filePath: 'src/file2.ts', tokenCount: 200 }));
      await store.set(createEntry({ filePath: 'src/file3.ts', tokenCount: 300 }));

      const result = await store.getBatch(testFolderId, ['src/file1.ts', 'src/file3.ts']);

      expect(result.size).toBe(2);
      expect(result.get('src/file1.ts')?.tokenCount).toBe(100);
      expect(result.get('src/file3.ts')?.tokenCount).toBe(300);
    });

    it('should return empty map for empty paths', async () => {
      const result = await store.getBatch(testFolderId, []);
      expect(result.size).toBe(0);
    });
  });

  describe('getAllForFolder', () => {
    it('should get all entries for a folder', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts' }));
      await store.set(createEntry({ filePath: 'src/file2.ts' }));
      await store.set(createEntry({ filePath: 'src/file3.ts', folderId: 'other-folder' }));

      const entries = await store.getAllForFolder(testFolderId);

      expect(entries).toHaveLength(2);
    });
  });

  describe('setBatch', () => {
    it('should set multiple entries atomically', async () => {
      const entries = [
        createEntry({ filePath: 'src/file1.ts', tokenCount: 100 }),
        createEntry({ filePath: 'src/file2.ts', tokenCount: 200 }),
      ];

      await store.setBatch(entries);

      const all = await store.getAllForFolder(testFolderId);
      expect(all).toHaveLength(2);
    });

    it('should handle empty batch', async () => {
      await store.setBatch([]);
      const all = await store.getAllForFolder(testFolderId);
      expect(all).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('should delete a single entry', async () => {
      await store.set(createEntry({ filePath: 'src/file.ts' }));

      const deleted = await store.delete(testFolderId, 'src/file.ts');

      expect(deleted).toBe(true);
      const found = await store.get(testFolderId, 'src/file.ts');
      expect(found).toBeNull();
    });

    it('should return false for non-existent entry', async () => {
      const deleted = await store.delete(testFolderId, 'non-existent.ts');
      expect(deleted).toBe(false);
    });
  });

  describe('clearFolder', () => {
    it('should clear all entries for a folder', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts' }));
      await store.set(createEntry({ filePath: 'src/file2.ts' }));
      await store.set(createEntry({ filePath: 'src/file3.ts', folderId: 'other-folder' }));

      const cleared = await store.clearFolder(testFolderId);

      expect(cleared).toBe(2);

      const remaining = await store.getAllForFolder(testFolderId);
      expect(remaining).toHaveLength(0);

      const otherRemaining = await store.getAllForFolder('other-folder');
      expect(otherRemaining).toHaveLength(1);
    });
  });

  describe('clearAll', () => {
    it('should clear all entries and return count', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts' }));
      await store.set(createEntry({ filePath: 'src/file2.ts', folderId: 'other-folder' }));

      const cleared = await store.clearAll();

      expect(cleared).toBe(2);
    });
  });

  describe('getTotalTokens', () => {
    it('should sum tokens for selected files', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts', tokenCount: 100 }));
      await store.set(createEntry({ filePath: 'src/file2.ts', tokenCount: 200 }));
      await store.set(createEntry({ filePath: 'src/file3.ts', tokenCount: 300 }));

      const total = await store.getTotalTokens(testFolderId, ['src/file1.ts', 'src/file2.ts']);

      expect(total).toBe(300);
    });

    it('should return 0 for empty paths', async () => {
      const total = await store.getTotalTokens(testFolderId, []);
      expect(total).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return statistics for folder', async () => {
      await store.set(
        createEntry({ countingMode: 'accurate', filePath: 'src/file1.ts', tokenCount: 100 })
      );
      await store.set(
        createEntry({ countingMode: 'heuristic', filePath: 'src/file2.ts', tokenCount: 200 })
      );

      const stats = await store.getStats(testFolderId);

      expect(stats.entryCount).toBe(2);
      expect(stats.totalTokens).toBe(300);
      expect(stats.accurateCount).toBe(1);
      expect(stats.heuristicCount).toBe(1);
    });

    it('should return global statistics when no folder specified', async () => {
      await store.set(createEntry({ filePath: 'src/file1.ts', tokenCount: 100 }));
      await store.set(
        createEntry({ filePath: 'src/file2.ts', folderId: 'other-folder', tokenCount: 200 })
      );

      const stats = await store.getStats();

      expect(stats.entryCount).toBe(2);
      expect(stats.totalTokens).toBe(300);
    });
  });

  describe('findByCountingMode', () => {
    it('should find entries by counting mode', async () => {
      await store.set(createEntry({ countingMode: 'accurate', filePath: 'src/file1.ts' }));
      await store.set(createEntry({ countingMode: 'heuristic', filePath: 'src/file2.ts' }));
      await store.set(createEntry({ countingMode: 'heuristic', filePath: 'src/file3.ts' }));

      const heuristic = await store.findByCountingMode(testFolderId, 'heuristic');

      expect(heuristic).toHaveLength(2);
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.set(createEntry({ countingMode: 'heuristic', filePath: `src/file${i}.ts` }));
      }

      const limited = await store.findByCountingMode(testFolderId, 'heuristic', 3);

      expect(limited).toHaveLength(3);
    });
  });

  describe('vacuum', () => {
    it('should run without error', async () => {
      await store.set(createEntry({ filePath: 'src/file.ts' }));
      await store.delete(testFolderId, 'src/file.ts');

      await expect(store.vacuum()).resolves.not.toThrow();
    });
  });
});
