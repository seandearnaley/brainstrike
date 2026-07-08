import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileRecord } from '../src/models/file-record';
import { FileRecordRepository } from '../src/repositories/file-record-repository';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

function createTestRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    chunkingStrategy: overrides.chunkingStrategy ?? 'sentence',
    chunksCount: overrides.chunksCount ?? 0,
    createdAt: overrides.createdAt ?? now,
    id: overrides.id ?? `test-id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test-file.txt',
    path: overrides.path ?? '/tmp/test-file.txt',
    size: overrides.size ?? 1234,
    tokenCount: overrides.tokenCount ?? 0,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

// Managed-cache identity is root_id since the source_root_path retirement.
// repo.create/createWithContent never write root_id (only applyManagedCacheBatch
// does), so seed a roots row and stamp root_id directly for these fixtures.
async function seedManagedCacheEntry(
  db: PGlite,
  repo: FileRecordRepository,
  args: {
    id: string;
    embeddingSetId: string;
    path: string;
    rootId: string;
    content?: string;
    contentHash?: string;
    tokenCount?: number;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO roots (id, kind, display_name) VALUES ($1, 'path', 'fixture') ON CONFLICT (id) DO NOTHING`,
    [args.rootId]
  );
  const now = new Date().toISOString();
  await repo.createWithContent({
    ...createTestRecord({ embeddingSetId: args.embeddingSetId, id: args.id, path: args.path }),
    content: args.content ?? 'export const value = 1;',
    contentHash: args.contentHash ?? 'hash-1',
    processedAt: now,
    tokenCount: args.tokenCount ?? 5,
  });
  await db.query('UPDATE file_records SET root_id = $1 WHERE id = $2', [args.rootId, args.id]);
}

describe('FileRecordRepository', () => {
  let db: PGlite;
  let repo: FileRecordRepository;

  // October 2025: Fresh database per test - WASM pre-loaded in vitest.setup.ts
  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-file-record');
    db = await wasmLoader.createPGlite(dataDir);
    await migrate(db);
    repo = new FileRecordRepository(db);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  it('creates and finds a record by id', async () => {
    const record = createTestRecord();
    await repo.create(record);
    const found = await repo.findById(record.id);
    expect(found).toEqual(record);
  });

  it('returns null for missing id', async () => {
    const found = await repo.findById('nonexistent-id');
    expect(found).toBeNull();
  });

  it('finds all records', async () => {
    const record1 = createTestRecord();
    const record2 = createTestRecord();
    await repo.create(record1);
    await repo.create(record2);
    const all = await repo.findAll();
    expect(all).toContainEqual(record1);
    expect(all).toContainEqual(record2);
    expect(all.length).toBe(2);
  });

  it('updates a record', async () => {
    const record = createTestRecord();
    await repo.create(record);
    const newName = 'updated.txt';
    await repo.update(record.id, { name: newName });
    const updated = await repo.findById(record.id);
    expect(updated?.name).toBe(newName);
    // unchanged fields remain
    expect(updated?.path).toBe(record.path);
  });

  it('updates createdAt and updatedAt', async () => {
    const record = createTestRecord();
    await repo.create(record);
    const newCreatedAt = new Date(Date.now() - 1000).toISOString();
    const newUpdatedAt = new Date(Date.now() + 1000).toISOString();
    await repo.update(record.id, { createdAt: newCreatedAt, updatedAt: newUpdatedAt });
    const updated = await repo.findById(record.id);
    expect(updated?.createdAt).toBe(newCreatedAt);
    expect(updated?.updatedAt).toBe(newUpdatedAt);
  });

  it('deletes a record', async () => {
    const record = createTestRecord();
    await repo.create(record);
    await repo.delete(record.id);
    const found = await repo.findById(record.id);
    expect(found).toBeNull();
  });

  it('update with no fields does nothing', async () => {
    const record = createTestRecord();
    await repo.create(record);
    await repo.update(record.id, {});
    const found = await repo.findById(record.id);
    expect(found).toEqual(record);
  });

  it('ignores disallowed update fields', async () => {
    const record = createTestRecord();
    await repo.create(record);
    await repo.update(record.id, {
      bogus: 'ignored',
      id: 'other',
      name: 'changed',
    } as Partial<FileRecord> & { bogus: string });
    const found = await repo.findById(record.id);
    expect(found).toEqual({ ...record, name: 'changed' });
  });

  it('round-trips root_id metadata for managed cache entries', async () => {
    const chunkedAt = '2026-06-16T18:00:00.000Z';
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'roundtrip-a',
      path: 'src/index.ts',
      rootId: 'root-a',
    });
    await db.query(
      'UPDATE file_records SET chunks_count = $1, chunks_processed_at = $2 WHERE id = $3',
      [3, chunkedAt, 'roundtrip-a']
    );

    const entries = await repo.listManagedCacheEntryMetadata(
      '00000000-0000-0000-0000-000000000101'
    );
    expect(entries).toEqual([
      expect.objectContaining({
        chunksCount: 3,
        chunksProcessedAt: chunkedAt,
        fileRecordId: 'roundtrip-a',
        rootId: 'root-a',
      }),
    ]);
  });

  it('preserves empty file content when creating managed cache entries', async () => {
    const record = createTestRecord({
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'empty-cache',
      path: 'src/empty.ts',
    });

    await repo.createWithContent({
      ...record,
      content: '',
      contentHash: 'hash-empty',
      processedAt: record.createdAt,
      tokenCount: 0,
    });

    const found = await repo.findById(record.id);
    expect(found?.content).toBe('');
    expect(found?.tokenCount).toBe(0);
  });

  it('rejects null bytes in file content before creating records', async () => {
    const record = createTestRecord({
      content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
      contentHash: 'hash-null-create',
      id: 'null-create',
      processedAt: new Date().toISOString(),
      tokenCount: 1,
    });

    await expect(repo.createWithContent(record)).rejects.toThrow(
      'File record content cannot contain null bytes.'
    );
  });

  it('rejects null bytes in file content before updating records', async () => {
    const record = createTestRecord({ id: 'null-update' });
    await repo.create(record);

    await expect(
      repo.updateContent(
        record.id,
        `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        'hash-null-update',
        1
      )
    ).rejects.toThrow('File record content cannot contain null bytes.');
  });

  it('finds managed cache entries by embedding set, root id, and relative path', async () => {
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'cache-a',
      path: 'src/index.ts',
      rootId: 'root-a',
    });
    // Same relative path under a DIFFERENT root — must stay distinct.
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'cache-b',
      path: 'src/index.ts',
      rootId: 'root-b',
    });

    const found = await repo.findByManagedCacheIdentity(
      '00000000-0000-0000-0000-000000000101',
      'root-a',
      'src/index.ts'
    );

    expect(found?.id).toBe('cache-a');
  });

  it('lists managed cache entries for a collection across roots', async () => {
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'cache-a',
      path: 'src/index.ts',
      rootId: 'root-a',
    });
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'cache-b',
      path: 'src/index.ts',
      rootId: 'root-b',
    });
    await seedManagedCacheEntry(db, repo, {
      embeddingSetId: '00000000-0000-0000-0000-000000000202',
      id: 'other-set',
      path: 'src/index.ts',
      rootId: 'root-a',
    });

    const entries = await repo.listManagedCacheEntries('00000000-0000-0000-0000-000000000101');

    expect(entries.map((entry) => entry.id).sort()).toEqual(['cache-a', 'cache-b']);
  });

  it('stamps stat metadata in batch so hash-unchanged rows can join the stat-cache', async () => {
    await seedManagedCacheEntry(db, repo, {
      contentHash: 'hash-a',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'stamp-a',
      path: 'src/a.ts',
      rootId: 'root-a',
    });

    // Pre-migration rows have NULL mtime_ms; the stamp gives them the scanned
    // stats without rewriting content.
    await repo.updateStatMetadata([
      { fileRecordId: 'stamp-a', mtimeMs: 1_700_000_000_000, size: 64 },
    ]);

    const entries = await repo.listManagedCacheEntryMetadata(
      '00000000-0000-0000-0000-000000000101'
    );
    expect(entries).toEqual([
      expect.objectContaining({
        contentHash: 'hash-a',
        fileRecordId: 'stamp-a',
        mtimeMs: 1_700_000_000_000,
        size: 64,
      }),
    ]);
  });

  it('updateStatMetadata floors fractional mtimes and no-ops on an empty batch', async () => {
    await seedManagedCacheEntry(db, repo, {
      contentHash: 'hash-b',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'stamp-b',
      path: 'src/b.ts',
      rootId: 'root-a',
    });

    await repo.updateStatMetadata([]);
    await repo.updateStatMetadata([
      { fileRecordId: 'stamp-b', mtimeMs: 1_757_381_225_844.767, size: 32 },
    ]);

    const entries = await repo.listManagedCacheEntryMetadata(
      '00000000-0000-0000-0000-000000000101'
    );
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'stamp-b',
        mtimeMs: 1_757_381_225_844,
        size: 32,
      }),
    ]);
  });

  it('lists managed cache metadata without hydrating file content', async () => {
    await seedManagedCacheEntry(db, repo, {
      contentHash: 'hash-1',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      id: 'cache-a',
      path: 'src/index.ts',
      rootId: 'root-a',
    });

    const entries = await repo.listManagedCacheEntryMetadata(
      '00000000-0000-0000-0000-000000000101'
    );

    expect(entries).toEqual([
      expect.objectContaining({
        contentHash: 'hash-1',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        fileRecordId: 'cache-a',
        relativePath: 'src/index.ts',
        rootId: 'root-a',
      }),
    ]);
  });
});
