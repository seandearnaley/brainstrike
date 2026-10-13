import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyManagedCacheBatch,
  invalidateManagedCacheEntriesByIdentity,
  type ManagedCachePartitionId,
} from '../src/managed-cache/apply-managed-cache-batch.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { getCollectionIndexingStats } from '../src/services/collection-indexing-stats.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const ROOT = 'root-text-partition';
const PATH = 'src/shared.ts';

/**
 * BST-1988: a NULL embedding set is the native TEXT partition alone. A TEXT row
 * and a collection row for the same root and path never collide, and neither
 * is ever read or invalidated as the other.
 */
describe('managed-cache TEXT partition', () => {
  let db: PGlite;
  let files: FileRecordRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path) VALUES ($1, 'path', 'workspace', '/workspace')`,
      [ROOT]
    );
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions)
       VALUES ('set-a', 'local::model-a', 'model-a', 3)`
    );
    files = new FileRecordRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function importFile(partition: ManagedCachePartitionId, id: string): Promise<void> {
    const now = new Date().toISOString();
    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'import',
          record: {
            content: `export const owner = ${JSON.stringify(id)};`,
            contentHash: `${id}-hash`,
            createdAt: now,
            id,
            name: 'shared.ts',
            path: PATH,
            processedAt: now,
            size: 32,
            tokenCount: 8,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: partition,
      rootId: ROOT,
    });
  }

  async function invalidate(partition: ManagedCachePartitionId): Promise<string[]> {
    return (
      await invalidateManagedCacheEntriesByIdentity(db, {
        embeddingSetId: partition,
        targets: [{ relativePath: PATH, rootId: ROOT }],
      })
    ).deletedFileRecordIds;
  }

  async function storedIds(): Promise<{ id: string; set: string | null }[]> {
    return (
      await db.query<{ id: string; set: string | null }>(
        'SELECT id, embedding_set_id AS set FROM file_records ORDER BY id'
      )
    ).rows;
  }

  it('holds a TEXT row and a collection row for the same root and path apart', async () => {
    await importFile('set-a', 'collection-file');
    await importFile(null, 'text-file');

    expect(await storedIds()).toEqual([
      { id: 'collection-file', set: 'set-a' },
      { id: 'text-file', set: null },
    ]);
    expect((await files.findByManagedCacheIdentity(null, ROOT, PATH))?.id).toBe('text-file');
    expect((await files.findByManagedCacheIdentity('set-a', ROOT, PATH))?.id).toBe(
      'collection-file'
    );
  });

  it('invalidates only the named partition, in both directions', async () => {
    await importFile('set-a', 'collection-file');
    await importFile(null, 'text-file');

    expect(await invalidate(null)).toEqual(['text-file']);
    expect(await storedIds()).toEqual([{ id: 'collection-file', set: 'set-a' }]);

    await importFile(null, 'text-file-2');
    expect(await invalidate('set-a')).toEqual(['collection-file']);
    expect(await storedIds()).toEqual([{ id: 'text-file-2', set: null }]);
  });

  it('keeps one TEXT row per root and path', async () => {
    await importFile(null, 'text-file');
    await expect(importFile(null, 'text-file-duplicate')).rejects.toThrow(
      /idx_file_records_text_partition_identity|duplicate key/
    );
  });

  it('refuses a blank collection id rather than reading it as the TEXT partition', async () => {
    await expect(importFile('', 'blank-file')).rejects.toThrow(
      'Managed cache batch mutation requires a collection id or the TEXT partition (null).'
    );
    await expect(invalidate('')).rejects.toThrow(
      'Managed cache invalidation requires a collection id or the TEXT partition (null).'
    );
  });

  it('counts TEXT rows in no collection', async () => {
    await importFile('set-a', 'collection-file');
    await importFile(null, 'text-file');

    expect(await getCollectionIndexingStats(db, 'set-a')).toMatchObject({ fileCount: 1 });
  });
});
