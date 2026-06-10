import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedCacheBatch,
  parseManagedCacheBatchArgs,
} from '../src/managed-cache/apply-managed-cache-batch.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('applyManagedCacheBatch', () => {
  let db: PGlite;
  let fileRecordRepository: FileRecordRepository;
  let fileChunkRepository: FileChunkRepository;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-managed-cache-batch');
    db = await wasmLoader.createPGlite(dataDir);
    await migrate(db);
    fileRecordRepository = new FileRecordRepository(db);
    fileChunkRepository = new FileChunkRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('parses and validates managed-cache batch payloads from a single source of truth', () => {
    expect(
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              size: 12,
              sourceRootPath: '/workspace/root',
              createdAt: '2026-04-16T00:00:00.000Z',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 1;',
              contentHash: 'hash-1',
              tokenCount: 5,
            },
          },
        ],
      })
    ).toEqual({
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'file-1',
            mtimeMs: null,
            name: 'index.ts',
            path: 'src/index.ts',
            size: 12,
            sourceRootPath: '/workspace/root',
            createdAt: '2026-04-16T00:00:00.000Z',
            updatedAt: '2026-04-16T00:00:00.000Z',
            processedAt: '2026-04-16T00:00:00.000Z',
            content: 'export const value = 1;',
            contentHash: 'hash-1',
            tokenCount: 5,
          },
        },
      ],
    });

    expect(
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-2',
              name: 'replace.ts',
              path: 'src/replace.ts',
              size: 16,
              sourceRootPath: '/workspace/root',
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 3;',
              contentHash: 'hash-3',
              tokenCount: 6,
            },
          },
        ],
      })
    ).toEqual({
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'file-2',
            mtimeMs: null,
            name: 'replace.ts',
            path: 'src/replace.ts',
            size: 16,
            sourceRootPath: '/workspace/root',
            updatedAt: '2026-04-16T00:00:00.000Z',
            processedAt: '2026-04-16T00:00:00.000Z',
            content: 'export const value = 3;',
            contentHash: 'hash-3',
            tokenCount: 6,
          },
        },
      ],
    });

    expect(
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [],
      })
    ).toEqual({
      embeddingSetId: 'set-1',
      changes: [],
    });

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              size: -1,
              sourceRootPath: '/workspace/root',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 2;',
              contentHash: 'hash-2',
              tokenCount: 5,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-3',
              name: 'bad-size.ts',
              path: 'src/bad-size.ts',
              size: 1.5,
              sourceRootPath: '/workspace/root',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 4;',
              contentHash: 'hash-4',
              tokenCount: 4,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-4',
              name: 'empty-hash.ts',
              path: 'src/empty-hash.ts',
              size: 1,
              sourceRootPath: '/workspace/root',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: '',
              contentHash: '',
              tokenCount: 0,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-5',
              name: 'bad-date.ts',
              path: 'src/bad-date.ts',
              size: 1,
              sourceRootPath: '/workspace/root',
              createdAt: 'not-a-date',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 5;',
              contentHash: 'hash-5',
              tokenCount: 1,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: null,
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-6',
              name: 'bad-updated-at.ts',
              path: 'src/bad-updated-at.ts',
              size: 1,
              sourceRootPath: '/workspace/root',
              updatedAt: '',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 6;',
              contentHash: 'hash-6',
              tokenCount: 1,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');
  });

  it('returns immediately when a managed-cache batch is empty', async () => {
    const transactionMock = vi.fn(db.transaction?.bind(db));
    const transactionalDb = {
      ...db,
      transaction: transactionMock,
    };

    await applyManagedCacheBatch(transactionalDb as unknown as PGlite, {
      embeddingSetId: 'set-1',
      changes: [],
    });

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects managed-cache batches when transactional database support is unavailable', async () => {
    const nonTransactionalDb = {
      ...db,
      transaction: undefined,
    };

    await expect(
      applyManagedCacheBatch(nonTransactionalDb as unknown as PGlite, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-transactionless',
              name: 'file.ts',
              path: 'src/file.ts',
              size: 1,
              sourceRootPath: '/workspace/root',
              createdAt: '2026-04-16T00:00:00.000Z',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = true;',
              contentHash: 'hash-transactionless',
              tokenCount: 1,
            },
          },
        ],
      })
    ).rejects.toThrow('Managed cache batch mutation requires transactional database support.');
  });

  it('rolls back replacement chunk deletion when a later import in the batch fails', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      id: 'replace-file',
      name: 'replace.ts',
      path: 'src/replace.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'old-content-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
      chunksCount: 1,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });

    await fileChunkRepository.insert({
      id: 'chunk-old',
      fileRecordId: 'replace-file',
      chunkIndex: 0,
      content: 'old chunk',
      contentHash: 'chunk-old-hash',
      tokenCount: 4,
      chunkType: 'sentence',
      chunkSize: 16,
      embeddingSetId: 'set-1',
      createdAt: now,
      updatedAt: now,
    });

    await fileRecordRepository.createWithContent({
      id: 'duplicate-import',
      name: 'existing.ts',
      path: 'src/existing.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const existing = true;',
      contentHash: 'existing-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });

    await fileRecordRepository.update('replace-file', {
      chunksCount: 1,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'replace-file',
              name: 'replace.ts',
              path: 'src/replace.ts',
              size: 11,
              sourceRootPath: '/workspace/root',
              updatedAt: now,
              processedAt: now,
              content: 'export const version = 2;',
              contentHash: 'new-content-hash',
              tokenCount: 6,
            },
          },
          {
            mode: 'import',
            record: {
              id: 'duplicate-import',
              name: 'new.ts',
              path: 'src/new.ts',
              size: 12,
              sourceRootPath: '/workspace/root',
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const shouldFail = true;',
              contentHash: 'duplicate-hash',
              tokenCount: 7,
            },
          },
        ],
      })
    ).rejects.toThrow();

    const restoredRecord = await fileRecordRepository.findById('replace-file');
    const restoredChunks = await fileChunkRepository.findByFileRecordId('replace-file');

    expect(restoredRecord).toEqual(
      expect.objectContaining({
        id: 'replace-file',
        content: 'export const version = 1;',
        contentHash: 'old-content-hash',
        chunksCount: 1,
        chunkingStrategy: 'sentence',
      })
    );
    expect(restoredChunks).toHaveLength(1);
    expect(restoredChunks[0]).toEqual(
      expect.objectContaining({
        id: 'chunk-old',
        content: 'old chunk',
      })
    );
  });

  it('rolls back managed-cache mutations when collection stats refresh fails', async () => {
    const now = new Date().toISOString();
    const queryWithFailingStatsRefresh = async <TRow = unknown>(
      sql: string,
      params?: unknown[]
    ): Promise<{ rows: TRow[] }> => {
      if (sql.includes('collection_indexing_stats')) {
        throw new Error('simulated stats refresh failure');
      }
      return await db.query<TRow>(sql, params);
    };
    const failingStatsDb = {
      exec: db.exec.bind(db),
      query: queryWithFailingStatsRefresh,
      transaction: async <T>(callback: (tx: PGlite) => Promise<T>): Promise<T> =>
        await db.transaction(async (tx) => {
          const txWithFailingStatsRefresh = {
            exec: tx.exec.bind(tx),
            query: async <TRow = unknown>(
              sql: string,
              params?: unknown[]
            ): Promise<{ rows: TRow[] }> => {
              if (sql.includes('collection_indexing_stats')) {
                throw new Error('simulated stats refresh failure');
              }
              return await tx.query<TRow>(sql, params);
            },
          };
          return await callback(txWithFailingStatsRefresh as PGlite);
        }),
    };

    await expect(
      applyManagedCacheBatch(failingStatsDb as unknown as PGlite, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'stats-failure-import',
              name: 'stats-failure.ts',
              path: 'src/stats-failure.ts',
              size: 12,
              sourceRootPath: '/workspace/root',
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const shouldRollback = true;',
              contentHash: 'stats-failure-hash',
              tokenCount: 4,
            },
          },
        ],
      })
    ).rejects.toThrow('simulated stats refresh failure');

    await expect(fileRecordRepository.findById('stats-failure-import')).resolves.toBeNull();
  });

  it('rejects oversized public batches before issuing parameter-heavy SQL', async () => {
    const now = new Date().toISOString();

    const oversizedImports = Array.from({ length: 5462 }, (_, index) => ({
      mode: 'import' as const,
      record: {
        id: `import-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        size: 10,
        sourceRootPath: '/workspace/root',
        createdAt: now,
        updatedAt: now,
        processedAt: now,
        content: 'export const value = 1;',
        contentHash: `hash-${index}`,
        tokenCount: 5,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: oversizedImports,
      })
    ).rejects.toThrow('Managed cache batch import exceeds the PostgreSQL parameter limit.');

    const oversizedReplacements = Array.from({ length: 6554 }, (_, index) => ({
      mode: 'replace' as const,
      record: {
        id: `replace-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        size: 10,
        sourceRootPath: '/workspace/root',
        updatedAt: now,
        processedAt: now,
        content: 'export const value = 2;',
        contentHash: `replace-hash-${index}`,
        tokenCount: 5,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: oversizedReplacements,
      })
    ).rejects.toThrow('Managed cache batch replace exceeds the PostgreSQL parameter limit.');
  });

  it('rejects oversized total mutation counts before batching into SQL statements', async () => {
    const now = new Date().toISOString();
    const oversizedCombinedBatch = Array.from({ length: 12_015 }, (_, index) => ({
      mode: 'replace' as const,
      record: {
        id: `replace-total-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        size: 10,
        sourceRootPath: '/workspace/root',
        updatedAt: now,
        processedAt: now,
        content: 'export const value = 2;',
        contentHash: `replace-total-hash-${index}`,
        tokenCount: 5,
      },
    }));

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: oversizedCombinedBatch,
      })
    ).toThrow('Managed cache batch exceeds the maximum supported total size.');
  });

  it('rejects duplicate file record ids in a single batch with a clear error', async () => {
    const now = new Date().toISOString();

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'duplicate-id',
              name: 'first.ts',
              path: 'src/first.ts',
              size: 10,
              sourceRootPath: '/workspace/root',
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const first = true;',
              contentHash: 'hash-first',
              tokenCount: 5,
            },
          },
          {
            mode: 'replace',
            record: {
              id: 'duplicate-id',
              name: 'second.ts',
              path: 'src/second.ts',
              size: 10,
              sourceRootPath: '/workspace/root',
              updatedAt: now,
              processedAt: now,
              content: 'export const second = true;',
              contentHash: 'hash-second',
              tokenCount: 5,
            },
          },
        ],
      })
    ).rejects.toThrow('Managed cache batch contains duplicate file record id duplicate-id.');
  });

  it('applies replacement-only batches with numeric file metadata successfully', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      id: 'replace-only-file',
      name: 'replace-only.ts',
      path: 'src/replace-only.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-only-old-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
      chunksCount: 1,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });

    await fileChunkRepository.insert({
      id: 'replace-only-chunk',
      fileRecordId: 'replace-only-file',
      chunkIndex: 0,
      content: 'old chunk',
      contentHash: 'replace-only-chunk-hash',
      tokenCount: 4,
      chunkType: 'sentence',
      chunkSize: 16,
      embeddingSetId: 'set-1',
      createdAt: now,
      updatedAt: now,
    });

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-only-file',
            name: 'replace-only.ts',
            path: 'src/replace-only.ts',
            size: 11,
            sourceRootPath: '/workspace/root',
            updatedAt: now,
            processedAt: now,
            content: 'export const version = 2;',
            contentHash: 'replace-only-new-hash',
            tokenCount: 6,
          },
        },
      ],
    });

    const replacedRecord = await fileRecordRepository.findById('replace-only-file');
    const replacementChunks = await fileChunkRepository.findByFileRecordId('replace-only-file');
    const resetState = await db.query<{
      chunking_strategy: string | null;
      chunks_count: number | null;
      chunks_processed_at: string | null;
    }>(
      'SELECT chunks_count, chunks_processed_at, chunking_strategy FROM file_records WHERE id = $1',
      ['replace-only-file']
    );

    expect(replacedRecord).toEqual(
      expect.objectContaining({
        id: 'replace-only-file',
        size: 11,
        content: 'export const version = 2;',
        contentHash: 'replace-only-new-hash',
        tokenCount: 6,
      })
    );
    expect(resetState.rows[0]).toEqual({
      chunking_strategy: null,
      chunks_count: 0,
      chunks_processed_at: null,
    });
    expect(replacementChunks).toHaveLength(0);
  });

  it('applies import-only batches successfully', async () => {
    const now = new Date().toISOString();

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'import-only-file',
            name: 'import-only.ts',
            path: 'src/import-only.ts',
            size: 12,
            sourceRootPath: '/workspace/root',
            createdAt: now,
            updatedAt: now,
            processedAt: now,
            content: 'export const imported = true;',
            contentHash: 'import-only-hash',
            tokenCount: 4,
          },
        },
      ],
    });

    const insertedRecord = await fileRecordRepository.findById('import-only-file');
    expect(insertedRecord).toEqual(
      expect.objectContaining({
        id: 'import-only-file',
        embeddingSetId: 'set-1',
        contentHash: 'import-only-hash',
      })
    );
  });

  it('persists mtimeMs on import and surfaces it with size for the stat-cache fast-path', async () => {
    const now = new Date().toISOString();
    const mtimeMs = 1_700_000_000_000;

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'stat-cache-file',
            name: 'stat.ts',
            path: 'src/stat.ts',
            size: 128,
            mtimeMs,
            sourceRootPath: '/workspace/root',
            createdAt: now,
            updatedAt: now,
            processedAt: now,
            content: 'export const value = 1;',
            contentHash: 'stat-hash',
            tokenCount: 5,
          },
        },
      ],
    });

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'stat-cache-file',
        relativePath: 'src/stat.ts',
        size: 128,
        mtimeMs,
      }),
    ]);
  });

  it('floors a fractional filesystem mtime before writing to the BIGINT column', async () => {
    const now = new Date().toISOString();
    // Electron's stat.mtimeMs (-> IFileNode.lastModified) carries sub-millisecond
    // fractional precision. A BIGINT column rejects "1757381225844.767" with
    // 22P02, which broke every managed-cache batch write (regression repro).
    const fractionalMtimeMs = 1_757_381_225_844.767;

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'fractional-mtime-file',
              name: 'frac.ts',
              path: 'src/frac.ts',
              size: 64,
              mtimeMs: fractionalMtimeMs,
              sourceRootPath: '/workspace/root',
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const value = 1;',
              contentHash: 'frac-hash',
              tokenCount: 5,
            },
          },
        ],
      })
    ).resolves.toBeUndefined();

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'fractional-mtime-file',
        relativePath: 'src/frac.ts',
        mtimeMs: Math.floor(fractionalMtimeMs),
      }),
    ]);
  });

  it('persists mtimeMs on replace so an in-place edit refreshes the stat-cache', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      id: 'replace-stat-file',
      name: 'stat.ts',
      path: 'src/stat.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'old-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });

    const newMtimeMs = 1_800_000_000_000;
    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-stat-file',
            name: 'stat.ts',
            path: 'src/stat.ts',
            size: 20,
            mtimeMs: newMtimeMs,
            sourceRootPath: '/workspace/root',
            updatedAt: now,
            processedAt: now,
            content: 'export const version = 2;',
            contentHash: 'new-hash',
            tokenCount: 6,
          },
        },
      ],
    });

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'replace-stat-file',
        relativePath: 'src/stat.ts',
        size: 20,
        mtimeMs: newMtimeMs,
      }),
    ]);
  });

  it('writes root_id on import when rootId is provided in the batch args', async () => {
    const now = new Date().toISOString();

    // Insert a roots row first — file_records.root_id has an FK reference.
    await db.query(
      `INSERT INTO roots (id, kind, display_name) VALUES ('root-db-1', 'path', 'fixture')`
    );

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      rootId: 'root-db-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'root-id-import-file',
            name: 'root-id-import.ts',
            path: 'src/root-id-import.ts',
            size: 10,
            sourceRootPath: '/workspace/root',
            createdAt: now,
            updatedAt: now,
            processedAt: now,
            content: 'export const rootId = true;',
            contentHash: 'root-id-import-hash',
            tokenCount: 5,
          },
        },
      ],
    });

    const result = await db.query<{ root_id: string | null }>(
      'SELECT root_id FROM file_records WHERE id = $1',
      ['root-id-import-file']
    );
    expect(result.rows[0]?.root_id).toBe('root-db-1');
  });

  it('writes root_id as NULL on import when rootId is omitted from the batch args', async () => {
    const now = new Date().toISOString();

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'no-root-id-import-file',
            name: 'no-root-id.ts',
            path: 'src/no-root-id.ts',
            size: 10,
            sourceRootPath: '/workspace/root',
            createdAt: now,
            updatedAt: now,
            processedAt: now,
            content: 'export const noRootId = true;',
            contentHash: 'no-root-id-hash',
            tokenCount: 5,
          },
        },
      ],
    });

    const result = await db.query<{ root_id: string | null }>(
      'SELECT root_id FROM file_records WHERE id = $1',
      ['no-root-id-import-file']
    );
    expect(result.rows[0]?.root_id).toBeNull();
  });

  it('does not change root_id on replacement (UPDATE by id; root never changes on replace)', async () => {
    const now = new Date().toISOString();

    // Insert a roots row and a file record pre-assigned to that root.
    await db.query(
      `INSERT INTO roots (id, kind, display_name) VALUES ('root-db-replace', 'path', 'fixture-replace')`
    );
    await fileRecordRepository.createWithContent({
      id: 'replace-with-root-file',
      name: 'replace-with-root.ts',
      path: 'src/replace-with-root.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-with-root-old-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });
    await db.query(
      `UPDATE file_records SET root_id = 'root-db-replace' WHERE id = 'replace-with-root-file'`
    );

    // Apply a replace batch — root_id must NOT be cleared or changed.
    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      rootId: 'root-db-replace',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-with-root-file',
            name: 'replace-with-root.ts',
            path: 'src/replace-with-root.ts',
            size: 20,
            sourceRootPath: '/workspace/root',
            updatedAt: now,
            processedAt: now,
            content: 'export const version = 2;',
            contentHash: 'replace-with-root-new-hash',
            tokenCount: 6,
          },
        },
      ],
    });

    const result = await db.query<{ root_id: string | null }>(
      'SELECT root_id FROM file_records WHERE id = $1',
      ['replace-with-root-file']
    );
    expect(result.rows[0]?.root_id).toBe('root-db-replace');
  });

  it('parseManagedCacheBatchArgs accepts rootId as a non-empty string', () => {
    const parsed = parseManagedCacheBatchArgs({
      embeddingSetId: 'set-1',
      rootId: 'root-db-1',
      changes: [],
    });
    expect(parsed.rootId).toBe('root-db-1');
  });

  it('parseManagedCacheBatchArgs accepts absent rootId (back-compat)', () => {
    const parsed = parseManagedCacheBatchArgs({
      embeddingSetId: 'set-1',
      changes: [],
    });
    expect(parsed.rootId).toBeUndefined();
  });

  it('parseManagedCacheBatchArgs accepts null rootId', () => {
    const parsed = parseManagedCacheBatchArgs({
      embeddingSetId: 'set-1',
      rootId: null,
      changes: [],
    });
    expect(parsed.rootId).toBeNull();
  });

  it('parseManagedCacheBatchArgs rejects a non-string non-null rootId with a thrown error', () => {
    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        rootId: 42,
        changes: [],
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        rootId: true,
        changes: [],
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        rootId: [],
        changes: [],
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    // '' would pass a bare typeof check and reach the DB as a doomed FK lookup.
    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        rootId: '',
        changes: [],
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');
  });
});
