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
    id: overrides.id ?? `test-id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test-file.txt',
    path: overrides.path ?? '/tmp/test-file.txt',
    size: overrides.size ?? 1234,
    chunksCount: overrides.chunksCount ?? 0,
    chunkingStrategy: overrides.chunkingStrategy ?? 'sentence',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    tokenCount: overrides.tokenCount ?? 0,
    ...overrides,
  };
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
      id: 'other',
      name: 'changed',
      bogus: 'ignored',
    } as Partial<FileRecord> & { bogus: string });
    const found = await repo.findById(record.id);
    expect(found).toEqual({ ...record, name: 'changed' });
  });

  it('round-trips sourceRootPath metadata for managed cache entries', async () => {
    const record = createTestRecord({
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/index.ts',
      sourceRootPath: '/workspace/a',
    });

    await repo.createWithContent({
      ...record,
      content: 'export const value = 1;',
      contentHash: 'hash-1',
      processedAt: record.createdAt,
      tokenCount: 5,
    });

    const found = await repo.findById(record.id);
    expect(found?.sourceRootPath).toBe('/workspace/a');
  });

  it('preserves empty file content when creating managed cache entries', async () => {
    const record = createTestRecord({
      id: 'empty-cache',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/empty.ts',
      sourceRootPath: '/workspace/a',
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

  it('finds managed cache entries by embedding set, root path, and relative path', async () => {
    const primary = createTestRecord({
      id: 'cache-a',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/index.ts',
      sourceRootPath: '/workspace/a',
    });
    const sameRelativePathDifferentRoot = createTestRecord({
      id: 'cache-b',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/index.ts',
      sourceRootPath: '/workspace/b',
    });

    await repo.create(primary);
    await repo.create(sameRelativePathDifferentRoot);

    const found = await repo.findByManagedCacheIdentity(
      '00000000-0000-0000-0000-000000000101',
      '/workspace/a',
      'src/index.ts'
    );

    expect(found?.id).toBe('cache-a');
    expect(found?.sourceRootPath).toBe('/workspace/a');
  });

  it('lists managed cache entries for a collection across roots', async () => {
    await repo.create(
      createTestRecord({
        id: 'cache-a',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/a',
      })
    );
    await repo.create(
      createTestRecord({
        id: 'cache-b',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/b',
      })
    );
    await repo.create(
      createTestRecord({
        id: 'other-set',
        embeddingSetId: '00000000-0000-0000-0000-000000000202',
        path: 'src/index.ts',
        sourceRootPath: '/workspace/a',
      })
    );

    const entries = await repo.listManagedCacheEntries('00000000-0000-0000-0000-000000000101');

    expect(entries.map((entry) => entry.id).sort()).toEqual(['cache-a', 'cache-b']);
  });

  it('stamps stat metadata in batch so hash-unchanged rows can join the stat-cache', async () => {
    const record = createTestRecord({
      id: 'stamp-a',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/a.ts',
      sourceRootPath: '/workspace/a',
    });
    await repo.createWithContent({
      ...record,
      content: 'export const value = 1;',
      contentHash: 'hash-a',
      processedAt: record.createdAt,
      tokenCount: 5,
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
        fileRecordId: 'stamp-a',
        mtimeMs: 1_700_000_000_000,
        size: 64,
        contentHash: 'hash-a',
      }),
    ]);
  });

  it('updateStatMetadata floors fractional mtimes and no-ops on an empty batch', async () => {
    const record = createTestRecord({
      id: 'stamp-b',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/b.ts',
      sourceRootPath: '/workspace/a',
    });
    await repo.createWithContent({
      ...record,
      content: 'export const value = 2;',
      contentHash: 'hash-b',
      processedAt: record.createdAt,
      tokenCount: 5,
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
    const record = createTestRecord({
      id: 'cache-a',
      embeddingSetId: '00000000-0000-0000-0000-000000000101',
      path: 'src/index.ts',
      sourceRootPath: '/workspace/a',
    });

    await repo.createWithContent({
      ...record,
      content: 'export const value = 1;',
      contentHash: 'hash-1',
      processedAt: record.createdAt,
      tokenCount: 5,
    });

    const entries = await repo.listManagedCacheEntryMetadata(
      '00000000-0000-0000-0000-000000000101'
    );

    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'cache-a',
        embeddingSetId: '00000000-0000-0000-0000-000000000101',
        sourceRootPath: '/workspace/a',
        relativePath: 'src/index.ts',
        contentHash: 'hash-1',
      }),
    ]);
  });
});
