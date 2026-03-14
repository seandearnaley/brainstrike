import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileRecord } from '../src/models/file-record';
import { FileRecordRepository } from '../src/repositories/file-record-repository';
import { wasmLoader } from '../src/wasm-loader.js';

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
    const dataDir = `/tmp/pglite-test-file-record-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
});
