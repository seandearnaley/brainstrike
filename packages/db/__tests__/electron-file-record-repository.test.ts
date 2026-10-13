import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRecord } from '../src/models/file-record';
import { ElectronFileRecordRepository } from '../src/repositories/electron-file-record-repository';

function createTestRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    createdAt: overrides.createdAt ?? now,
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test.txt',
    path: overrides.path ?? '/tmp/test.txt',
    size: overrides.size ?? 1,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

describe('ElectronFileRecordRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let exec: ReturnType<typeof vi.fn>;
  let repo: ElectronFileRecordRepository;

  beforeEach(() => {
    query = vi.fn().mockResolvedValue({ rows: [] });
    exec = vi.fn().mockResolvedValue(undefined);
    repo = new ElectronFileRecordRepository({ exec, query });
  });

  it('create uses correct SQL', async () => {
    const record = createTestRecord();
    await repo.create(record);
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO file_records (id, name, path, size, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [record.id, record.name, record.path, record.size, record.createdAt, record.updatedAt]
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects null bytes in createWithContent before IPC query', async () => {
    const record = createTestRecord({
      content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
      contentHash: 'hash-null-create',
      processedAt: new Date().toISOString(),
      tokenCount: 1,
    });

    await expect(repo.createWithContent(record)).rejects.toThrow(
      'File record content cannot contain null bytes.'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects null bytes in updateContent before IPC query', async () => {
    await expect(
      repo.updateContent(
        'record-1',
        `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        'hash-null-update',
        1
      )
    ).rejects.toThrow('File record content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('findById maps row to record', async () => {
    const record = createTestRecord();
    query.mockResolvedValueOnce({
      rows: [
        {
          created_at: record.createdAt,
          id: record.id,
          name: record.name,
          path: record.path,
          size: record.size,
          updated_at: record.updatedAt,
        },
      ],
    });
    const result = await repo.findById(record.id);
    expect(query).toHaveBeenCalledWith('SELECT * FROM file_records WHERE id = $1', [record.id]);
    expect(result).toEqual(record);
  });

  it('findAll returns mapped records', async () => {
    const r1 = createTestRecord();
    const r2 = createTestRecord();
    query.mockResolvedValueOnce({
      rows: [
        {
          created_at: r1.createdAt,
          id: r1.id,
          name: r1.name,
          path: r1.path,
          size: r1.size,
          updated_at: r1.updatedAt,
        },
        {
          created_at: r2.createdAt,
          id: r2.id,
          name: r2.name,
          path: r2.path,
          size: r2.size,
          updated_at: r2.updatedAt,
        },
      ],
    });
    const result = await repo.findAll();
    expect(query).toHaveBeenCalledWith('SELECT * FROM file_records ORDER BY updated_at DESC');
    expect(result).toEqual([r1, r2]);
  });

  it('findByIds uses text[] matching for text primary keys', async () => {
    const r1 = createTestRecord({ id: 'id-1' });
    const r2 = createTestRecord({ id: 'id-2' });
    query.mockResolvedValueOnce({
      rows: [
        {
          created_at: r1.createdAt,
          id: r1.id,
          name: r1.name,
          path: r1.path,
          size: r1.size,
          updated_at: r1.updatedAt,
        },
        {
          created_at: r2.createdAt,
          id: r2.id,
          name: r2.name,
          path: r2.path,
          size: r2.size,
          updated_at: r2.updatedAt,
        },
      ],
    });

    const result = await repo.findByIds([r1.id, r2.id]);

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM file_records WHERE id::text = ANY($1::text[])',
      [[r1.id, r2.id]]
    );
    expect(result).toEqual([r1, r2]);
  });

  it('update generates proper SQL', async () => {
    await repo.update('123', { createdAt: 'd1', name: 'new' });
    expect(query).toHaveBeenCalledWith(
      'UPDATE file_records SET name = $1, created_at = $2 WHERE id = $3',
      ['new', 'd1', '123']
    );
  });

  it('rejects null bytes in generic content updates before IPC query', async () => {
    await expect(
      repo.update('record-1', {
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
      })
    ).rejects.toThrow('File record content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('createWithContent preserves empty string content for chunking-host reads', async () => {
    const record = createTestRecord({
      content: '',
      contentHash: 'hash-empty',
      processedAt: '2026-04-14T00:00:00.000Z',
      tokenCount: 0,
    });

    await repo.createWithContent(record);

    expect(query).toHaveBeenCalledWith(
      'INSERT INTO file_records (id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [
        record.id,
        record.name,
        record.path,
        record.size,
        record.createdAt,
        record.updatedAt,
        '',
        'hash-empty',
        0,
        '2026-04-14T00:00:00.000Z',
      ]
    );
  });

  it('delete uses correct SQL', async () => {
    await repo.delete('abc');
    expect(query).toHaveBeenCalledWith('DELETE FROM file_records WHERE id = $1', ['abc']);
  });

  it('count returns numeric value', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const result = await repo.count();
    expect(query).toHaveBeenCalledWith('SELECT COUNT(*) as count FROM file_records');
    expect(result).toBe(2);
  });

  it('findByManagedCacheIdentity uses cache identity SQL', async () => {
    await repo.findByManagedCacheIdentity('set-1', 'root-a', 'src/index.ts');

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM file_records WHERE embedding_set_id = $1 AND root_id = $2 AND path = $3 ORDER BY updated_at DESC LIMIT 1',
      ['set-1', 'root-a', 'src/index.ts']
    );
  });

  it('findByManagedCacheIdentity selects only the TEXT partition for a null set', async () => {
    await repo.findByManagedCacheIdentity(null, 'root-a', 'src/index.ts');

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM file_records WHERE embedding_set_id IS NULL AND root_id = $1 AND path = $2 ORDER BY updated_at DESC LIMIT 1',
      ['root-a', 'src/index.ts']
    );
  });

  it('listManagedCacheEntries filters by embedding set and root id metadata', async () => {
    await repo.listManagedCacheEntries('set-1');

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM file_records WHERE embedding_set_id = $1 AND root_id IS NOT NULL ORDER BY updated_at DESC',
      ['set-1']
    );
  });

  it('listManagedCacheEntryMetadata uses metadata-only SQL', async () => {
    await repo.listManagedCacheEntryMetadata('set-1');

    expect(query).toHaveBeenCalledWith(
      'SELECT id, embedding_set_id, root_id, path, content_hash, size, mtime_ms, chunks_count, chunks_processed_at, updated_at FROM file_records WHERE embedding_set_id = $1 AND root_id IS NOT NULL ORDER BY updated_at DESC',
      ['set-1']
    );
  });
});
