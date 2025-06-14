import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { FileRecordRepository } from '../src/repositories/file-record-repository';
import { migrate } from '../src/migrations/bootstrap';
import type { FileRecord } from '../src/models/file-record';

function createTestRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `test-id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test-file.txt',
    path: overrides.path ?? '/tmp/test-file.txt',
    size: overrides.size ?? 1234,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

describe('FileRecordRepository', () => {
  let db: PGlite;
  let repo: FileRecordRepository;

  beforeEach(async () => {
    db = new PGlite(':memory:');
    await migrate(db);
    await db.query('DELETE FROM file_records');
    repo = new FileRecordRepository(db);
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
});
