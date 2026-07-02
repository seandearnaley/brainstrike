import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import {
  applyTursoManagedCacheBatch,
  invalidateTursoManagedCacheEntriesByIdentity,
} from '../src/managed-cache/index.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import {
  markTursoCollectionIndexingStatsDirty,
  refreshTursoCollectionIndexingStats,
} from '../src/services/turso-collection-indexing-stats.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('Turso managed-cache batch', () => {
  let client: TursoOwnerClient;
  let embeddingSetId: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-managed-cache-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    await client.exec(
      "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-1', 'path', 'Root 1', '/tmp/root-1')"
    );
    const embeddingSets = new TursoEmbeddingSetsRepository(client);
    const embeddingSet = await embeddingSets.getOrCreateSet(
      'local::managed-cache-test',
      'managed-cache-test',
      384,
      'cosine'
    );
    embeddingSetId = embeddingSet.id;
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('imports records and refreshes collection stats with SQLite-compatible SQL', async () => {
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-1', path: 'src/file-1.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(readFileRecord('file-1')).resolves.toMatchObject({
      content: 'export const value = 1;',
      embedding_set_id: embeddingSetId,
      id: 'file-1',
      path: 'src/file-1.ts',
      root_id: 'root-1',
    });
    await expect(readStats()).resolves.toMatchObject({
      chunk_count: 0,
      dirty: 0,
      file_count: 1,
      pending_chunk_count: 0,
    });
  });

  it('chunks large import batches instead of rejecting them at the SQLite parameter limit', async () => {
    const importCount = 70;

    await applyTursoManagedCacheBatch(client, {
      changes: Array.from({ length: importCount }, (_, index) => ({
        mode: 'import' as const,
        record: createImportRecord({
          id: `file-${index}`,
          path: `src/import-${index}.ts`,
        }),
      })),
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(countFileRecords()).resolves.toBe(importCount);
    await expect(readStats()).resolves.toMatchObject({ file_count: importCount });
  });

  it('refreshes Turso collection stats with inherited file-record chunk ownership', async () => {
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-1', path: 'src/file-1.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });
    const chunks = new TursoFileChunkRepository(client);
    await chunks.insert({
      chunkIndex: 0,
      chunkSize: 24,
      chunkType: 'text',
      content: 'export const pending = 1;',
      contentHash: 'chunk-hash-pending',
      createdAt: '2026-06-23T12:00:00.000Z',
      fileRecordId: 'file-1',
      id: 'chunk-pending',
      tokenCount: 5,
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
    await client.exec(
      `INSERT INTO file_chunks (
         id,
         file_record_id,
         chunk_index,
         content,
         content_hash,
         token_count,
         chunk_type,
         chunk_size,
         embedding,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?)`,
      [
        'chunk-embedded',
        'file-1',
        1,
        'export const embedded = 1;',
        'chunk-hash-embedded',
        7,
        'text',
        26,
        '[0.1,0.2,0.3]',
        '2026-06-23T12:00:00.000Z',
        '2026-06-23T12:00:00.000Z',
      ]
    );

    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-2', path: 'src/file-2.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(readStats()).resolves.toMatchObject({
      chunk_count: 2,
      embedded_chunk_count: 1,
      file_count: 2,
      pending_chunk_count: 1,
    });
  });

  it('marks unique Turso collection stats rows dirty', async () => {
    const embeddingSets = new TursoEmbeddingSetsRepository(client);
    const otherSet = await embeddingSets.getOrCreateSet(
      'local::managed-cache-other',
      'managed-cache-other',
      384,
      'cosine'
    );

    await markTursoCollectionIndexingStatsDirty(client, []);
    await markTursoCollectionIndexingStatsDirty(client, [
      embeddingSetId,
      embeddingSetId,
      otherSet.id,
    ]);

    await expect(readStats()).resolves.toMatchObject({ dirty: 1 });
    await expect(readStatsForSet(otherSet.id)).resolves.toMatchObject({ dirty: 1 });
  });

  it('refreshes Turso collection stats directly and recreates missing rows', async () => {
    await refreshTursoCollectionIndexingStats(client, []);
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-1', path: 'src/file-1.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });
    const chunks = new TursoFileChunkRepository(client);
    await chunks.insert({
      chunkIndex: 0,
      chunkSize: 24,
      chunkType: 'text',
      content: 'export const pending = 1;',
      contentHash: 'chunk-hash-pending',
      createdAt: '2026-06-23T12:00:00.000Z',
      fileRecordId: 'file-1',
      id: 'chunk-pending',
      tokenCount: 5,
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
    await client.exec(
      `INSERT INTO file_chunks (
         id,
         file_record_id,
         chunk_index,
         content,
         content_hash,
         token_count,
         chunk_type,
         chunk_size,
         embedding,
         embedding_set_id,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?, ?, ?)`,
      [
        'chunk-embedded',
        'file-1',
        1,
        'export const embedded = 1;',
        'chunk-hash-embedded',
        7,
        'text',
        26,
        '[0.1,0.2,0.3]',
        embeddingSetId,
        '2026-06-23T12:00:00.000Z',
        '2026-06-23T12:00:00.000Z',
      ]
    );
    await client.exec('DELETE FROM collection_indexing_stats WHERE embedding_set_id = ?', [
      embeddingSetId,
    ]);

    await refreshTursoCollectionIndexingStats(client, [embeddingSetId, embeddingSetId]);

    await expect(readStats()).resolves.toMatchObject({
      chunk_count: 2,
      dirty: 0,
      embedded_chunk_count: 1,
      file_count: 1,
      pending_chunk_count: 1,
    });
  });

  it('replaces records, clears stale chunks and cancels active embedding jobs atomically', async () => {
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-1', path: 'src/file-1.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });
    const chunks = new TursoFileChunkRepository(client);
    await chunks.insert({
      chunkIndex: 0,
      chunkSize: 24,
      chunkType: 'text',
      content: 'export const value = 1;',
      contentHash: 'chunk-hash-1',
      createdAt: '2026-06-23T12:00:00.000Z',
      fileRecordId: 'file-1',
      id: 'chunk-1',
      tokenCount: 5,
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
    await client.exec(
      `INSERT INTO job_queue (
         id, queue, job_type, payload, chunk_id, embedding_set_id, state, dedupe_key
       )
       VALUES (
         'job-1', 'embeddings', 'embed_chunk', '{"chunkId":"chunk-1"}',
         'chunk-1', ?, 'queued', 'chunk-1:managed-cache'
       )`,
      [embeddingSetId]
    );

    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'replace',
          record: createReplaceRecord({
            content: 'export const value = 2;',
            contentHash: 'hash-2',
            id: 'file-1',
            path: 'src/file-1.ts',
          }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(readFileRecord('file-1')).resolves.toMatchObject({
      chunks_count: 0,
      chunks_processed_at: null,
      content: 'export const value = 2;',
      content_hash: 'hash-2',
    });
    await expect(countRows('file_chunks')).resolves.toBe(0);
    await expect(readJob('job-1')).resolves.toMatchObject({
      error: 'Managed-cache replacement deleted chunk chunk-1 before embedding.',
      state: 'canceled',
    });
  });

  it('allows large replacement batches because Turso replacements update one row at a time', async () => {
    const replacementCount = 91;

    await applyTursoManagedCacheBatch(client, {
      changes: Array.from({ length: replacementCount }, (_, index) => ({
        mode: 'import' as const,
        record: createImportRecord({
          id: `file-${index}`,
          path: `src/replace-${index}.ts`,
        }),
      })),
      embeddingSetId,
      rootId: 'root-1',
    });

    await applyTursoManagedCacheBatch(client, {
      changes: Array.from({ length: replacementCount }, (_, index) => ({
        mode: 'replace' as const,
        record: createReplaceRecord({
          content: `export const value = ${index};`,
          contentHash: `hash-replaced-${index}`,
          id: `file-${index}`,
          path: `src/replace-${index}.ts`,
        }),
      })),
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(countFileRecords()).resolves.toBe(replacementCount);
    await expect(readFileRecord('file-90')).resolves.toMatchObject({
      content: 'export const value = 90;',
      content_hash: 'hash-replaced-90',
    });
  });

  it('invalidates exact and prefix targets through the Turso managed-cache path', async () => {
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-1', path: 'src/file-1.ts' }),
        },
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-2', path: 'src/nested/file-2.ts' }),
        },
        {
          mode: 'import',
          record: createImportRecord({ id: 'file-3', path: 'docs/readme.md' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });
    const chunks = new TursoFileChunkRepository(client);
    await chunks.insert({
      chunkIndex: 0,
      chunkSize: 24,
      chunkType: 'text',
      content: 'export const nested = 1;',
      contentHash: 'chunk-hash-2',
      createdAt: '2026-06-23T12:00:00.000Z',
      fileRecordId: 'file-2',
      id: 'chunk-2',
      tokenCount: 5,
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
    await client.exec(
      `INSERT INTO job_queue (
         id, queue, job_type, payload, chunk_id, embedding_set_id, state, dedupe_key
       )
       VALUES (
         'job-2', 'embeddings', 'embed_chunk', '{"chunkId":"chunk-2"}',
         'chunk-2', ?, 'running', 'chunk-2:managed-cache'
       )`,
      [embeddingSetId]
    );

    const result = await invalidateTursoManagedCacheEntriesByIdentity(client, {
      embeddingSetId,
      targets: [
        {
          expectedFileRecordId: 'file-3',
          mode: 'exact',
          relativePath: 'docs/readme.md',
          rootId: 'root-1',
        },
        { mode: 'prefix', relativePathPrefix: 'src/nested', rootId: 'root-1' },
      ],
    });

    expect(result).toEqual({
      canceledEmbeddingJobCount: 1,
      deletedChunkIds: ['chunk-2'],
      deletedFileRecordIds: ['file-2', 'file-3'],
    });
    await expect(readFileRecord('file-1')).resolves.toMatchObject({ id: 'file-1' });
    await expect(readFileRecord('file-2')).resolves.toBeUndefined();
    await expect(readFileRecord('file-3')).resolves.toBeUndefined();
    await expect(readJob('job-2')).resolves.toMatchObject({
      error: 'Managed-cache invalidation deleted chunk chunk-2 before embedding.',
      state: 'canceled',
    });
    await expect(readStats()).resolves.toMatchObject({ file_count: 1 });
  });

  it('applies remove mutations inside the Turso managed-cache batch transaction', async () => {
    await client.exec(
      "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-2', 'path', 'Root 2', '/tmp/root-2')"
    );
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'remove-target', path: 'src/shared.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });
    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({ id: 'same-path-other-root', path: 'src/shared.ts' }),
        },
      ],
      embeddingSetId,
      rootId: 'root-2',
    });

    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'remove',
          target: {
            expectedFileRecordId: 'remove-target',
            mode: 'exact',
            relativePath: 'src/shared.ts',
            rootId: 'root-1',
          },
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(readFileRecord('remove-target')).resolves.toBeUndefined();
    await expect(readFileRecord('same-path-other-root')).resolves.toMatchObject({
      id: 'same-path-other-root',
      path: 'src/shared.ts',
      root_id: 'root-2',
    });
    await expect(readStats()).resolves.toMatchObject({ file_count: 1 });
  });

  it('does not count remove mutations toward the Turso record-backed batch limit', async () => {
    let removalQueryCount = 0;
    let execCount = 0;
    const tx = {
      exec: async () => {
        execCount += 1;
      },
      query: async (sql) => {
        if (sql.includes('SELECT DISTINCT')) {
          removalQueryCount += 1;
        }
        if (sql.includes('RETURNING id')) {
          return { rows: [{ id: 'large-removal-import' }] };
        }
        return { rows: [] };
      },
    } satisfies BrainstrikeDbTransactionClient;
    const fakeClient = {
      ...tx,
      transaction: async (callback) => callback(tx),
    } satisfies BrainstrikeDbExecutionClient;
    const manyRemovals = Array.from({ length: 12_015 }, (_, index) => ({
      mode: 'remove' as const,
      target: {
        mode: 'exact' as const,
        relativePath: `deleted/file-${index}.ts`,
        rootId: 'root-1',
      },
    }));

    await expect(
      applyTursoManagedCacheBatch(fakeClient, {
        changes: [
          ...manyRemovals,
          {
            mode: 'import',
            record: createImportRecord({ id: 'large-removal-import', path: 'src/import.ts' }),
          },
        ],
        embeddingSetId,
        rootId: 'root-1',
      })
    ).resolves.toBeUndefined();
    expect(removalQueryCount).toBe(manyRemovals.length);
    expect(execCount).toBeGreaterThan(0);
  });

  it('keeps quick-open name grams searchable across Turso managed-cache writes', async () => {
    const fileRecords = new TursoFileRecordRepository(client);

    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'import',
          record: createImportRecord({
            id: 'file-1',
            name: 'Alpha.ts',
            path: 'src/alpha.ts',
          }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(fileRecords.findByNameSubstring('alpha', 50)).resolves.toEqual([
      expect.objectContaining({ id: 'file-1', name: 'Alpha.ts' }),
    ]);

    await applyTursoManagedCacheBatch(client, {
      changes: [
        {
          mode: 'replace',
          record: createReplaceRecord({
            id: 'file-1',
            name: 'Beta.ts',
            path: 'src/beta.ts',
          }),
        },
      ],
      embeddingSetId,
      rootId: 'root-1',
    });

    await expect(fileRecords.findByNameSubstring('alpha', 50)).resolves.toEqual([]);
    await expect(fileRecords.findByNameSubstring('beta', 50)).resolves.toEqual([
      expect.objectContaining({ id: 'file-1', name: 'Beta.ts' }),
    ]);

    await invalidateTursoManagedCacheEntriesByIdentity(client, {
      embeddingSetId,
      targets: [
        {
          expectedFileRecordId: 'file-1',
          mode: 'exact',
          relativePath: 'src/beta.ts',
          rootId: 'root-1',
        },
      ],
    });

    await expect(fileRecords.findByNameSubstring('beta', 50)).resolves.toEqual([]);
  });

  function createImportRecord(overrides: Partial<Parameters<typeof createReplaceRecord>[0]> = {}) {
    return {
      ...createReplaceRecord(overrides),
      createdAt: '2026-06-23T12:00:00.000Z',
    };
  }

  function createReplaceRecord(
    overrides: Partial<{
      content: string;
      contentHash: string;
      id: string;
      name: string;
      path: string;
    }> = {}
  ) {
    return {
      content: overrides.content ?? 'export const value = 1;',
      contentHash: overrides.contentHash ?? 'hash-1',
      id: overrides.id ?? 'file-1',
      mtimeMs: 1234.75,
      name: overrides.name ?? 'file.ts',
      path: overrides.path ?? 'src/file.ts',
      processedAt: '2026-06-23T12:00:00.000Z',
      size: 24,
      tokenCount: 5,
      updatedAt: '2026-06-23T12:00:00.000Z',
    };
  }

  async function readFileRecord(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>(
      'SELECT * FROM file_records WHERE id = ?',
      [id]
    );
    return result.rows[0];
  }

  async function readStats(): Promise<Record<string, unknown> | undefined> {
    return readStatsForSet(embeddingSetId);
  }

  async function readStatsForSet(setId: string): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>(
      'SELECT * FROM collection_indexing_stats WHERE embedding_set_id = ?',
      [setId]
    );
    return result.rows[0];
  }

  async function countFileRecords(): Promise<number> {
    const result = await client.query<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM file_records'
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function readJob(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<Record<string, unknown>>(
      'SELECT state, error FROM job_queue WHERE id = ?',
      [id]
    );
    return result.rows[0];
  }

  async function countRows(tableName: 'file_chunks'): Promise<number> {
    const result = await client.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    );
    return Number(result.rows[0]?.count ?? 0);
  }
});
