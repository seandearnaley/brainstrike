import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedCacheBatch,
  invalidateManagedCacheEntriesByIdentity,
  parseManagedCacheBatchArgs,
} from '../src/managed-cache/apply-managed-cache-batch.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { getCollectionIndexingStats } from '../src/services/collection-indexing-stats.js';
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
    // file_records.root_id has an FK to roots(id); managed-cache imports now
    // require a non-null root_id (source_root_path retired), so seed a fixture
    // root every import batch can reference.
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fixture', 'path', 'fixture', '/workspace/root')`
    );
    fileRecordRepository = new FileRecordRepository(db);
    fileChunkRepository = new FileChunkRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedEmbeddingSet(embeddingSetId: string): Promise<void> {
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions)
       VALUES ($1, $2, $3, 3)
       ON CONFLICT (id) DO NOTHING`,
      [embeddingSetId, `${embeddingSetId}-model-key`, `${embeddingSetId}-model-id`]
    );
  }

  async function seedRoot(id: string, path: string): Promise<void> {
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ($1, 'path', $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, id, path]
    );
  }

  async function importManagedCacheFile(args: {
    readonly embeddingSetId?: string;
    readonly fileRecordId: string;
    readonly relativePath: string;
    readonly rootId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const pathParts = args.relativePath.split('/');
    await applyManagedCacheBatch(db, {
      embeddingSetId: args.embeddingSetId ?? 'set-1',
      rootId: args.rootId ?? 'root-fixture',
      changes: [
        {
          mode: 'import',
          record: {
            id: args.fileRecordId,
            name: pathParts.pop() ?? args.fileRecordId,
            path: args.relativePath,
            size: 12,
            createdAt: now,
            updatedAt: now,
            processedAt: now,
            content: `export const file = ${JSON.stringify(args.fileRecordId)};`,
            contentHash: `${args.fileRecordId}-hash`,
            tokenCount: 5,
          },
        },
      ],
    });
  }

  async function insertChunk(args: {
    readonly chunkId: string;
    readonly chunkIndex?: number;
    readonly embeddingSetId?: string;
    readonly fileRecordId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await fileChunkRepository.insert({
      id: args.chunkId,
      fileRecordId: args.fileRecordId,
      chunkIndex: args.chunkIndex ?? 0,
      content: `${args.chunkId} content`,
      contentHash: `${args.chunkId}-hash`,
      tokenCount: 4,
      chunkType: 'sentence',
      chunkSize: 16,
      embeddingSetId: args.embeddingSetId ?? 'set-1',
      createdAt: now,
      updatedAt: now,
    });
  }

  async function insertEmbeddingJob(args: {
    readonly chunkId: string;
    readonly error?: string | null;
    readonly id: string;
    readonly leaseToken?: string | null;
    readonly leasedUntil?: string | null;
    readonly state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';
    readonly workerId?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO job_queue (
         id, queue, job_type, payload, state, run_at,
         lease_token, leased_until, worker_id, error, created_at, updated_at
       )
       VALUES ($1, 'embeddings', 'embed_chunk', $2::jsonb, $3, $4, $5, $6, $7, $8, $4, $4)`,
      [
        args.id,
        JSON.stringify({ chunkId: args.chunkId }),
        args.state ?? 'queued',
        now,
        args.leaseToken ?? null,
        args.leasedUntil ?? null,
        args.workerId ?? null,
        args.error ?? null,
      ]
    );
  }

  async function listJobStates(): Promise<
    Array<{
      chunk_id: string | null;
      error: string | null;
      id: string;
      lease_token: string | null;
      leased_until: string | null;
      state: string;
      worker_id: string | null;
    }>
  > {
    const result = await db.query<{
      chunk_id: string | null;
      error: string | null;
      id: string;
      lease_token: string | null;
      leased_until: string | null;
      state: string;
      worker_id: string | null;
    }>(
      `SELECT
         id,
         state,
         payload->>'chunkId' AS chunk_id,
         lease_token,
         leased_until,
         worker_id,
         error
       FROM job_queue
       ORDER BY id`
    );
    return result.rows;
  }

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
      rootId: 'root-fixture',
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
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-transactionless',
              name: 'file.ts',
              path: 'src/file.ts',
              size: 1,
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

  it('rejects null bytes in managed-cache content before reaching PGlite', async () => {
    const now = new Date().toISOString();
    const querySpy = vi.spyOn(db, 'query');

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-null-byte',
              name: 'late-null.txt',
              path: 'src/late-null.txt',
              size: 620,
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
              contentHash: 'hash-null-byte',
              tokenCount: 155,
            },
          },
        ],
      })
    ).rejects.toThrow('Managed cache content cannot contain null bytes.');

    expect(querySpy).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO file_records'));
  });

  it('invalidates only the exact managed-cache identity and leaves the same relative path in another root', async () => {
    await seedRoot('root-other', '/workspace/other');
    await importManagedCacheFile({
      fileRecordId: 'exact-root-fixture-file',
      relativePath: 'src/shared.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'exact-root-other-file',
      relativePath: 'src/shared.ts',
      rootId: 'root-other',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          rootId: 'root-fixture',
          relativePath: 'src/shared.ts',
        },
      ],
    });

    expect(result).toEqual({
      canceledEmbeddingJobCount: 0,
      deletedChunkIds: [],
      deletedFileRecordIds: ['exact-root-fixture-file'],
    });
    await expect(fileRecordRepository.findById('exact-root-fixture-file')).resolves.toBeNull();
    await expect(fileRecordRepository.findById('exact-root-other-file')).resolves.toEqual(
      expect.objectContaining({
        id: 'exact-root-other-file',
        path: 'src/shared.ts',
      })
    );
  });

  it('does not invalidate root_id null legacy rows that share the target path', async () => {
    const now = new Date().toISOString();
    await fileRecordRepository.createWithContent({
      id: 'legacy-null-root-file',
      name: 'legacy.ts',
      path: 'src/legacy.ts',
      size: 10,
      createdAt: now,
      updatedAt: now,
      content: 'export const legacy = true;',
      contentHash: 'legacy-null-root-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });
    await importManagedCacheFile({
      fileRecordId: 'root-bound-legacy-path-file',
      relativePath: 'src/legacy.ts',
      rootId: 'root-fixture',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          rootId: 'root-fixture',
          relativePath: 'src/legacy.ts',
        },
      ],
    });

    expect(result.deletedFileRecordIds).toEqual(['root-bound-legacy-path-file']);
    await expect(fileRecordRepository.findById('root-bound-legacy-path-file')).resolves.toBeNull();
    await expect(fileRecordRepository.findById('legacy-null-root-file')).resolves.toEqual(
      expect.objectContaining({
        id: 'legacy-null-root-file',
        path: 'src/legacy.ts',
      })
    );
  });

  it('prefix invalidation deletes descendants under one root while leaving sibling prefixes and other roots', async () => {
    await seedRoot('root-prefix-other', '/workspace/prefix-other');
    await importManagedCacheFile({
      fileRecordId: 'prefix-src-index',
      relativePath: 'src/index.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-src-nested',
      relativePath: 'src/nested/view.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-src-old-sibling',
      relativePath: 'src-old/index.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-other-root-src',
      relativePath: 'src/other-root.ts',
      rootId: 'root-prefix-other',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          rootId: 'root-fixture',
          relativePathPrefix: 'src',
        },
      ],
    });

    expect(result.deletedFileRecordIds).toEqual(['prefix-src-index', 'prefix-src-nested']);
    await expect(fileRecordRepository.findById('prefix-src-index')).resolves.toBeNull();
    await expect(fileRecordRepository.findById('prefix-src-nested')).resolves.toBeNull();
    await expect(fileRecordRepository.findById('prefix-src-old-sibling')).resolves.toEqual(
      expect.objectContaining({
        id: 'prefix-src-old-sibling',
        path: 'src-old/index.ts',
      })
    );
    await expect(fileRecordRepository.findById('prefix-other-root-src')).resolves.toEqual(
      expect.objectContaining({
        id: 'prefix-other-root-src',
        path: 'src/other-root.ts',
      })
    );
  });

  it('prefix invalidation treats SQL wildcard characters as literal path characters', async () => {
    await importManagedCacheFile({
      fileRecordId: 'prefix-literal-underscore',
      relativePath: 'src/a_b/index.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-wildcard-would-match-underscore',
      relativePath: 'src/aXb/index.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-literal-percent',
      relativePath: 'src/a%b/index.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'prefix-wildcard-would-match-percent',
      relativePath: 'src/aXYZb/index.ts',
      rootId: 'root-fixture',
    });

    const underscoreResult = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          rootId: 'root-fixture',
          relativePathPrefix: 'src/a_b',
        },
      ],
    });

    expect(underscoreResult.deletedFileRecordIds).toEqual(['prefix-literal-underscore']);
    await expect(fileRecordRepository.findById('prefix-literal-underscore')).resolves.toBeNull();
    await expect(
      fileRecordRepository.findById('prefix-wildcard-would-match-underscore')
    ).resolves.not.toBeNull();

    const percentResult = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          rootId: 'root-fixture',
          relativePathPrefix: 'src/a%b',
        },
      ],
    });

    expect(percentResult.deletedFileRecordIds).toEqual(['prefix-literal-percent']);
    await expect(fileRecordRepository.findById('prefix-literal-percent')).resolves.toBeNull();
    await expect(
      fileRecordRepository.findById('prefix-wildcard-would-match-percent')
    ).resolves.not.toBeNull();
  });

  it('prefix invalidation normalizes trailing slashes before matching descendants', async () => {
    await importManagedCacheFile({
      fileRecordId: 'prefix-trailing-slash-child',
      relativePath: 'src/index.ts',
      rootId: 'root-fixture',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'prefix',
          rootId: 'root-fixture',
          relativePathPrefix: 'src/',
        },
      ],
    });

    expect(result.deletedFileRecordIds).toEqual(['prefix-trailing-slash-child']);
    await expect(fileRecordRepository.findById('prefix-trailing-slash-child')).resolves.toBeNull();
  });

  it('rejects invalidation batches that exceed the PostgreSQL parameter limit', async () => {
    const tooManyTargets = Array.from({ length: 16_384 }, (_, index) => ({
      rootId: 'root-fixture',
      relativePath: `src/${index}.ts`,
    }));

    await expect(
      invalidateManagedCacheEntriesByIdentity(db, {
        embeddingSetId: 'set-1',
        targets: tooManyTargets,
      })
    ).rejects.toThrow(
      'Managed cache invalidation exceeds the PostgreSQL parameter limit. Received 16384 targets; maximum supported invalidation target count is 16383.'
    );
  });

  it('invalidates file records, cascades chunk deletion, refreshes stats, and returns deleted ids', async () => {
    await seedEmbeddingSet('set-stats');
    await importManagedCacheFile({
      embeddingSetId: 'set-stats',
      fileRecordId: 'stats-delete-file',
      relativePath: 'src/delete.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      embeddingSetId: 'set-stats',
      fileRecordId: 'stats-keep-file',
      relativePath: 'src/keep.ts',
      rootId: 'root-fixture',
    });
    await insertChunk({
      chunkId: 'stats-delete-chunk-b',
      chunkIndex: 1,
      embeddingSetId: 'set-stats',
      fileRecordId: 'stats-delete-file',
    });
    await insertChunk({
      chunkId: 'stats-delete-chunk-a',
      chunkIndex: 0,
      embeddingSetId: 'set-stats',
      fileRecordId: 'stats-delete-file',
    });
    await insertChunk({
      chunkId: 'stats-keep-chunk',
      embeddingSetId: 'set-stats',
      fileRecordId: 'stats-keep-file',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-stats',
      targets: [
        {
          expectedFileRecordId: 'stats-delete-file',
          rootId: 'root-fixture',
          relativePath: 'src/delete.ts',
        },
      ],
    });

    expect(result).toEqual({
      canceledEmbeddingJobCount: 0,
      deletedChunkIds: ['stats-delete-chunk-a', 'stats-delete-chunk-b'],
      deletedFileRecordIds: ['stats-delete-file'],
    });
    await expect(fileChunkRepository.findByFileRecordId('stats-delete-file')).resolves.toEqual([]);
    await expect(fileChunkRepository.findByFileRecordId('stats-keep-file')).resolves.toEqual([
      expect.objectContaining({
        id: 'stats-keep-chunk',
      }),
    ]);
    await expect(getCollectionIndexingStats(db, 'set-stats')).resolves.toEqual(
      expect.objectContaining({
        chunkCount: 1,
        dirty: false,
        embeddedChunkCount: 0,
        fileCount: 1,
        pendingChunkCount: 1,
      })
    );
  });

  it('invalidations cancel queued and running embed jobs for deleted chunks and leave unrelated jobs intact', async () => {
    await importManagedCacheFile({
      fileRecordId: 'job-delete-file',
      relativePath: 'src/job-delete.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'job-keep-file',
      relativePath: 'src/job-keep.ts',
      rootId: 'root-fixture',
    });
    await insertChunk({
      chunkId: 'job-delete-queued-chunk',
      fileRecordId: 'job-delete-file',
    });
    await insertChunk({
      chunkId: 'job-delete-running-chunk',
      chunkIndex: 1,
      fileRecordId: 'job-delete-file',
    });
    await insertChunk({
      chunkId: 'job-keep-chunk',
      fileRecordId: 'job-keep-file',
    });
    await insertEmbeddingJob({
      chunkId: 'job-delete-queued-chunk',
      id: 'job-delete-queued',
      state: 'queued',
    });
    await insertEmbeddingJob({
      chunkId: 'job-delete-running-chunk',
      id: 'job-delete-running',
      leaseToken: 'lease-delete-running',
      leasedUntil: '2999-01-01T00:00:00.000Z',
      state: 'running',
      workerId: 'worker-delete-running',
    });
    await insertEmbeddingJob({
      chunkId: 'job-delete-running-chunk',
      id: 'job-delete-succeeded',
      state: 'succeeded',
    });
    await insertEmbeddingJob({
      chunkId: 'job-keep-chunk',
      id: 'job-keep-queued',
      state: 'queued',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        {
          rootId: 'root-fixture',
          relativePath: 'src/job-delete.ts',
        },
      ],
    });

    expect(result.canceledEmbeddingJobCount).toBe(2);
    expect(await listJobStates()).toEqual([
      {
        chunk_id: 'job-delete-queued-chunk',
        error: 'Managed-cache invalidation deleted chunk job-delete-queued-chunk before embedding.',
        id: 'job-delete-queued',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        chunk_id: 'job-delete-running-chunk',
        error:
          'Managed-cache invalidation deleted chunk job-delete-running-chunk before embedding.',
        id: 'job-delete-running',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        chunk_id: 'job-delete-running-chunk',
        error: null,
        id: 'job-delete-succeeded',
        lease_token: null,
        leased_until: null,
        state: 'succeeded',
        worker_id: null,
      },
      {
        chunk_id: 'job-keep-chunk',
        error: null,
        id: 'job-keep-queued',
        lease_token: null,
        leased_until: null,
        state: 'queued',
        worker_id: null,
      },
    ]);
  });

  it('replacement cancels queued and running embed jobs for old chunks before deleting chunks', async () => {
    const now = new Date().toISOString();
    await fileRecordRepository.createWithContent({
      id: 'replace-job-file',
      name: 'replace-job.ts',
      path: 'src/replace-job.ts',
      size: 10,
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-job-old-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
      chunksCount: 2,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });
    await insertChunk({
      chunkId: 'replace-job-old-queued-chunk',
      fileRecordId: 'replace-job-file',
    });
    await insertChunk({
      chunkId: 'replace-job-old-running-chunk',
      chunkIndex: 1,
      fileRecordId: 'replace-job-file',
    });
    await insertEmbeddingJob({
      chunkId: 'replace-job-old-queued-chunk',
      id: 'replace-job-old-queued',
      state: 'queued',
    });
    await insertEmbeddingJob({
      chunkId: 'replace-job-old-running-chunk',
      id: 'replace-job-old-running',
      leaseToken: 'replace-job-running-lease',
      leasedUntil: '2999-01-01T00:00:00.000Z',
      state: 'running',
      workerId: 'replace-job-worker',
    });
    await insertEmbeddingJob({
      chunkId: 'unrelated-replace-job-chunk',
      id: 'replace-job-unrelated',
      state: 'queued',
    });

    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-job-file',
            name: 'replace-job.ts',
            path: 'src/replace-job.ts',
            size: 11,
            updatedAt: now,
            processedAt: now,
            content: 'export const version = 2;',
            contentHash: 'replace-job-new-hash',
            tokenCount: 6,
          },
        },
      ],
    });

    await expect(fileChunkRepository.findByFileRecordId('replace-job-file')).resolves.toEqual([]);
    expect(await listJobStates()).toEqual([
      {
        chunk_id: 'replace-job-old-queued-chunk',
        error:
          'Managed-cache replacement deleted chunk replace-job-old-queued-chunk before embedding.',
        id: 'replace-job-old-queued',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        chunk_id: 'replace-job-old-running-chunk',
        error:
          'Managed-cache replacement deleted chunk replace-job-old-running-chunk before embedding.',
        id: 'replace-job-old-running',
        lease_token: null,
        leased_until: null,
        state: 'canceled',
        worker_id: null,
      },
      {
        chunk_id: 'unrelated-replace-job-chunk',
        error: null,
        id: 'replace-job-unrelated',
        lease_token: null,
        leased_until: null,
        state: 'queued',
        worker_id: null,
      },
    ]);
  });

  it('rolls back replacement chunk deletion when a later import in the batch fails', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      id: 'replace-file',
      name: 'replace.ts',
      path: 'src/replace.ts',
      size: 10,
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
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'replace-file',
              name: 'replace.ts',
              path: 'src/replace.ts',
              size: 11,
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
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'stats-failure-import',
              name: 'stats-failure.ts',
              path: 'src/stats-failure.ts',
              size: 12,
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
        rootId: 'root-fixture',
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
        rootId: 'root-fixture',
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
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'duplicate-id',
              name: 'first.ts',
              path: 'src/first.ts',
              size: 10,
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
      rootId: 'root-fixture',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-only-file',
            name: 'replace-only.ts',
            path: 'src/replace-only.ts',
            size: 11,
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
      rootId: 'root-fixture',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'import-only-file',
            name: 'import-only.ts',
            path: 'src/import-only.ts',
            size: 12,
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
      rootId: 'root-fixture',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'stat-cache-file',
            name: 'stat.ts',
            path: 'src/stat.ts',
            size: 128,
            mtimeMs,
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
        rootId: 'root-fixture',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'fractional-mtime-file',
              name: 'frac.ts',
              path: 'src/frac.ts',
              size: 64,
              mtimeMs: fractionalMtimeMs,
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
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'old-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });
    // Stamp the managed-cache identity (root_id) — createWithContent does not
    // set it, and listManagedCacheEntryMetadata only returns root_id-bearing rows.
    await db.query(
      "UPDATE file_records SET root_id = 'root-fixture' WHERE id = 'replace-stat-file'"
    );

    const newMtimeMs = 1_800_000_000_000;
    await applyManagedCacheBatch(db, {
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'replace-stat-file',
            name: 'stat.ts',
            path: 'src/stat.ts',
            size: 20,
            mtimeMs: newMtimeMs,
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

  it('THROWS on import when rootId is omitted (no null-root_id cache identity)', async () => {
    // Managed-cache identity is root_id since the source_root_path retirement.
    // An import with no root_id has no stable identity and would be re-imported
    // every sync, so the batch is refused rather than writing an orphan row.
    const now = new Date().toISOString();

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'no-root-id-import-file',
              name: 'no-root-id.ts',
              path: 'src/no-root-id.ts',
              size: 10,
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const noRootId = true;',
              contentHash: 'no-root-id-hash',
              tokenCount: 5,
            },
          },
        ],
      })
    ).rejects.toThrow(/requires a non-null rootId/);

    const result = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_records WHERE id = $1',
      ['no-root-id-import-file']
    );
    expect(result.rows[0]?.count).toBe('0');
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
