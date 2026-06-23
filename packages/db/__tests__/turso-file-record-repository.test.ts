import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import type { FileRecord } from '../src/models/file-record.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoFileRecordRepository', () => {
  let client: TursoOwnerClient;
  let repository: TursoFileRecordRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-file-records-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    repository = new TursoFileRecordRepository(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('creates and reads file records through the Turso schema shape', async () => {
    const record = createRecord({
      content: 'const answer = 42;',
      contentHash: 'hash-answer',
      embeddingSetId: 'set-a',
      processedAt: '2026-06-23T07:00:00.000Z',
      tokenCount: 5,
    });

    await repository.createWithContent(record);

    await expect(repository.findById(record.id)).resolves.toMatchObject({
      content: 'const answer = 42;',
      contentHash: 'hash-answer',
      embeddingSetId: 'set-a',
      id: record.id,
      tokenCount: 5,
    });
    await expect(repository.findByContentHash('hash-answer')).resolves.toMatchObject({
      id: record.id,
    });
    await expect(repository.findByIds([record.id, record.id, 'missing'])).resolves.toHaveLength(1);
    await expect(repository.findAllWithContent()).resolves.toHaveLength(1);
    await expect(repository.count()).resolves.toBe(1);
    await expect(repository.countWithContent()).resolves.toBe(1);
  });

  it('updates content and nullable metadata without Postgres casts', async () => {
    const record = createRecord({ content: 'old', contentHash: 'old-hash', tokenCount: 1 });
    await repository.createWithContent(record);

    await repository.update(record.id, {
      chunksCount: 3,
      chunksProcessedAt: '2026-06-23T07:01:00.000Z',
      chunkingStrategy: 'markdown',
      content: null,
      contentHash: null,
      embeddingSetId: null,
      processedAt: null,
      tokenCount: null,
    });
    await repository.updateContent(record.id, 'updated', 'new-hash', 2);

    await expect(repository.findById(record.id)).resolves.toMatchObject({
      chunksCount: 3,
      chunksProcessedAt: '2026-06-23T07:01:00.000Z',
      chunkingStrategy: 'markdown',
      content: 'updated',
      contentHash: 'new-hash',
      tokenCount: 2,
    });
  });

  it('rejects invalid update dates before Turso can store unreadable rows', async () => {
    const record = createRecord({ id: 'invalid-date-record' });
    await repository.createWithContent(record);

    await expect(
      repository.update(record.id, {
        updatedAt: 'not-a-date',
      })
    ).rejects.toThrow('Invalid file record updatedAt date: not-a-date');

    await expect(repository.findById(record.id)).resolves.toMatchObject({
      id: record.id,
      updatedAt: record.updatedAt,
    });
  });

  it('lists and stamps managed-cache metadata by root identity', async () => {
    await seedRoot('root-a', 'Root A');
    const record = createRecord({
      content: 'export const value = 1;',
      contentHash: 'hash-managed',
      embeddingSetId: 'set-managed',
      id: 'managed-record',
      path: 'src/index.ts',
    });
    await repository.createWithContent(record);
    await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', record.id]);

    await expect(
      repository.findByManagedCacheIdentity('set-managed', 'root-a', 'src/index.ts')
    ).resolves.toMatchObject({ id: record.id });

    await repository.updateStatMetadata([{ fileRecordId: record.id, mtimeMs: 1234.9, size: 88 }]);

    await expect(repository.listManagedCacheEntryMetadata('set-managed')).resolves.toEqual([
      expect.objectContaining({
        contentHash: 'hash-managed',
        fileRecordId: record.id,
        mtimeMs: 1234,
        relativePath: 'src/index.ts',
        rootId: 'root-a',
        size: 88,
      }),
    ]);
  });

  it('bulk imports with content-hash dedupe scoped by embedding set', async () => {
    const shared = 'const shared = true;';
    const results = await repository.bulkImport([
      { content: shared, embeddingSetId: 'set-a', name: 'a.ts', path: 'src/a.ts', size: 10 },
      {
        content: shared,
        embeddingSetId: 'set-a',
        name: 'a-copy.ts',
        path: 'src/a-copy.ts',
        size: 10,
      },
      { content: shared, embeddingSetId: 'set-b', name: 'b.ts', path: 'src/b.ts', size: 10 },
    ]);

    expect(results).toEqual([
      expect.objectContaining({ existed: false, imported: true }),
      expect.objectContaining({ existed: true, imported: false }),
      expect.objectContaining({ existed: false, imported: true }),
    ]);
    await expect(repository.count()).resolves.toBe(2);
  });

  it('rejects null-byte content before writing to Turso', async () => {
    await expect(
      repository.createWithContent(
        createRecord({
          content: `valid-prefix${String.fromCharCode(0)}invalid`,
          contentHash: 'null-byte',
        })
      )
    ).rejects.toThrow('File record content cannot contain null bytes.');
    await expect(repository.count()).resolves.toBe(0);
  });

  it('deletes and clears records with row counts from Turso statements', async () => {
    await repository.create(createRecord({ id: 'delete-me' }));
    await repository.create(createRecord({ id: 'clear-me' }));

    await repository.delete('delete-me');
    await expect(repository.findById('delete-me')).resolves.toBeNull();
    await expect(repository.clearAll()).resolves.toBe(1);
    await expect(repository.count()).resolves.toBe(0);
  });

  it('clears records without materializing deleted row ids', async () => {
    const sqlCalls: string[] = [];
    const fakeDb: BrainstrikeDbExecutionClient = {
      exec: vi.fn(async (sql: string) => {
        sqlCalls.push(sql);
      }),
      query: vi.fn(async (sql: string) => {
        sqlCalls.push(sql);
        return { rows: [{ count: 2 }] };
      }),
      transaction: vi.fn(async () => {
        throw new Error('clearAll should not need a transaction.');
      }),
    };
    const fakeRepository = new TursoFileRecordRepository(fakeDb);

    await expect(fakeRepository.clearAll()).resolves.toBe(2);

    expect(fakeDb.exec).toHaveBeenCalledWith('DELETE FROM file_records');
    expect(sqlCalls.join('\n')).not.toContain('RETURNING');
  });

  async function seedRoot(id: string, displayName: string): Promise<void> {
    await client.exec('INSERT INTO roots (id, kind, display_name) VALUES (?, ?, ?)', [
      id,
      'path',
      displayName,
    ]);
  }
});

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    createdAt: '2026-06-23T06:00:00.000Z',
    id: 'record-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    updatedAt: '2026-06-23T06:00:00.000Z',
    ...overrides,
  };
}
