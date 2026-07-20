import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedCacheBatch,
  invalidateManagedCacheEntriesByIdentity,
  parseManagedCacheBatchArgs,
} from '../src/managed-cache/apply-managed-cache-batch.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { getCollectionIndexingStats } from '../src/services/collection-indexing-stats.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('applyManagedCacheBatch', () => {
  let db: PGlite;
  let fileRecordRepository: FileRecordRepository;
  let fileChunkRepository: FileChunkRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
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
      changes: [
        {
          mode: 'import',
          record: {
            content: `export const file = ${JSON.stringify(args.fileRecordId)};`,
            contentHash: `${args.fileRecordId}-hash`,
            createdAt: now,
            id: args.fileRecordId,
            name: pathParts.pop() ?? args.fileRecordId,
            path: args.relativePath,
            processedAt: now,
            size: 12,
            tokenCount: 5,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: args.embeddingSetId ?? 'set-1',
      rootId: args.rootId ?? 'root-fixture',
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
      chunkIndex: args.chunkIndex ?? 0,
      chunkSize: 16,
      chunkType: 'sentence',
      content: `${args.chunkId} content`,
      contentHash: `${args.chunkId}-hash`,
      createdAt: now,
      embeddingSetId: args.embeddingSetId ?? 'set-1',
      fileRecordId: args.fileRecordId,
      id: args.chunkId,
      tokenCount: 4,
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
         id, queue, job_type, payload, chunk_id, state, run_at,
         lease_token, leased_until, worker_id, error, created_at, updated_at
       )
       VALUES ($1, 'embeddings', 'embed_chunk', $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $5, $5)`,
      [
        args.id,
        JSON.stringify({ chunkId: args.chunkId }),
        args.chunkId,
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
         chunk_id,
         lease_token,
         leased_until,
         worker_id,
         error
       FROM job_queue
       ORDER BY id`
    );
    return result.rows;
  }

  async function readCanceledTotal(queue: string): Promise<number | null> {
    const result = await db.query<{ canceled_total: string | number }>(
      'SELECT canceled_total FROM job_queue_metrics WHERE queue = $1',
      [queue]
    );
    const value = result.rows[0]?.canceled_total;
    return value === undefined ? null : Number(value);
  }

  it('parses and validates managed-cache batch payloads from a single source of truth', () => {
    expect(
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const value = 1;',
              contentHash: 'hash-1',
              createdAt: '2026-04-16T00:00:00.000Z',
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 12,
              tokenCount: 5,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toEqual({
      changes: [
        {
          mode: 'import',
          record: {
            content: 'export const value = 1;',
            contentHash: 'hash-1',
            createdAt: '2026-04-16T00:00:00.000Z',
            id: 'file-1',
            mtimeMs: null,
            name: 'index.ts',
            path: 'src/index.ts',
            processedAt: '2026-04-16T00:00:00.000Z',
            size: 12,
            tokenCount: 5,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      ],
      embeddingSetId: 'set-1',
    });

    expect(
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export const value = 3;',
              contentHash: 'hash-3',
              createdAt: '2026-04-15T00:00:00.000Z',
              id: 'file-2',
              name: 'replace.ts',
              path: 'src/replace.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 16,
              tokenCount: 6,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toEqual({
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const value = 3;',
            contentHash: 'hash-3',
            id: 'file-2',
            mtimeMs: null,
            name: 'replace.ts',
            path: 'src/replace.ts',
            processedAt: '2026-04-16T00:00:00.000Z',
            size: 16,
            tokenCount: 6,
            updatedAt: '2026-04-16T00:00:00.000Z',
          },
        },
      ],
      embeddingSetId: 'set-1',
    });

    expect(
      parseManagedCacheBatchArgs({
        changes: [],
        embeddingSetId: 'set-1',
      })
    ).toEqual({
      changes: [],
      embeddingSetId: 'set-1',
    });

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export const value = 2;',
              contentHash: 'hash-2',
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: -1,
              tokenCount: 5,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export const value = 4;',
              contentHash: 'hash-4',
              id: 'file-3',
              name: 'bad-size.ts',
              path: 'src/bad-size.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 1.5,
              tokenCount: 4,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: {
              content: '',
              contentHash: '',
              id: 'file-4',
              name: 'empty-hash.ts',
              path: 'src/empty-hash.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 1,
              tokenCount: 0,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const value = 5;',
              contentHash: 'hash-5',
              createdAt: 'not-a-date',
              id: 'file-5',
              name: 'bad-date.ts',
              path: 'src/bad-date.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 1,
              tokenCount: 1,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: null,
          },
        ],
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export const value = 6;',
              contentHash: 'hash-6',
              id: 'file-6',
              name: 'bad-updated-at.ts',
              path: 'src/bad-updated-at.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 1,
              tokenCount: 1,
              updatedAt: '',
            },
          },
        ],
        embeddingSetId: 'set-1',
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
      changes: [],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
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
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const value = true;',
              contentHash: 'hash-transactionless',
              createdAt: '2026-04-16T00:00:00.000Z',
              id: 'file-transactionless',
              name: 'file.ts',
              path: 'src/file.ts',
              processedAt: '2026-04-16T00:00:00.000Z',
              size: 1,
              tokenCount: 1,
              updatedAt: '2026-04-16T00:00:00.000Z',
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow('Managed cache batch mutation requires transactional database support.');
  });

  it('rejects null bytes in managed-cache content before reaching PGlite', async () => {
    const now = new Date().toISOString();
    const querySpy = vi.spyOn(db, 'query');

    await expect(
      applyManagedCacheBatch(db, {
        changes: [
          {
            mode: 'import',
            record: {
              content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
              contentHash: 'hash-null-byte',
              createdAt: now,
              id: 'file-null-byte',
              name: 'late-null.txt',
              path: 'src/late-null.txt',
              processedAt: now,
              size: 620,
              tokenCount: 155,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
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
          relativePath: 'src/shared.ts',
          rootId: 'root-fixture',
        },
      ],
    });

    expect(result).toEqual({
      canceledEmbeddingJobCount: 0,
      deletedChunkIds: [],
      deletedFileRecordIds: ['exact-root-fixture-file'],
    });
    // No cancellations → the counter INSERT selects zero rows and must not
    // create a spurious job_queue_metrics row.
    expect(await readCanceledTotal('embeddings')).toBeNull();
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
      content: 'export const legacy = true;',
      contentHash: 'legacy-null-root-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'legacy-null-root-file',
      name: 'legacy.ts',
      path: 'src/legacy.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
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
          relativePath: 'src/legacy.ts',
          rootId: 'root-fixture',
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
          relativePathPrefix: 'src',
          rootId: 'root-fixture',
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
          relativePathPrefix: 'src/a_b',
          rootId: 'root-fixture',
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
          relativePathPrefix: 'src/a%b',
          rootId: 'root-fixture',
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
          relativePathPrefix: 'src/',
          rootId: 'root-fixture',
        },
      ],
    });

    expect(result.deletedFileRecordIds).toEqual(['prefix-trailing-slash-child']);
    await expect(fileRecordRepository.findById('prefix-trailing-slash-child')).resolves.toBeNull();
  });

  it('splits large invalidation batches into bounded target queries', async () => {
    const queryMock = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const fakeDb = {
      query: queryMock,
      transaction: async (callback: (tx: { query: typeof queryMock }) => Promise<unknown>) =>
        await callback({ query: queryMock }),
    };
    const targets = Array.from({ length: 20_000 }, (_, index) => ({
      relativePath: `src/${index}.ts`,
      rootId: 'root-fixture',
    }));

    await expect(
      invalidateManagedCacheEntriesByIdentity(fakeDb, {
        embeddingSetId: 'set-1',
        targets,
      })
    ).resolves.toEqual({
      canceledEmbeddingJobCount: 0,
      deletedChunkIds: [],
      deletedFileRecordIds: [],
    });

    const targetMatchQueries = queryMock.mock.calls.filter(([sql]) =>
      sql.includes('WITH targets(root_id, relative_path, expected_file_record_id)')
    );
    expect(targetMatchQueries.length).toBeGreaterThan(1);
    for (const [, params] of targetMatchQueries) {
      expect(params?.length ?? 0).toBeLessThanOrEqual(1 + 250 * 3);
    }
  });

  it('matches invalidation targets through a path index condition instead of a per-target root scan', async () => {
    // Regression guard for the 673K-chunk scale collapse: the legacy match
    // query OR-ed exact/prefix modes together, so the planner could only push
    // root_id into the index condition and re-filtered EVERY file under the
    // root once per target (11s per 250-target batch on a real 88K-file
    // corpus). The path predicate must appear in an Index Cond.
    await importManagedCacheFile({
      fileRecordId: 'plan-exact-file',
      relativePath: 'src/plan/exact.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'plan-prefix-file',
      relativePath: 'src/plan/dir/child.ts',
      rootId: 'root-fixture',
    });
    // Enough rows under the same root that the planner has a real choice
    // between "scan everything under the root" and a path index seek — on a
    // near-empty table every plan degenerates to the same trivial scan.
    await db.query(
      `INSERT INTO file_records (id, embedding_set_id, root_id, path, name, size)
       SELECT 'plan-bulk-' || i, 'set-1', 'root-fixture', 'src/plan/bulk/' || i || '.ts', i || '.ts', 10
         FROM generate_series(1, 500) AS g(i)`
    );

    const capturedMatchQueries: Array<{ params: unknown[]; sql: string }> = [];
    const capturingDb = {
      query: async (sql: string, params?: unknown[]) => await db.query(sql, params),
      transaction: async (callback: (tx: { query: typeof db.query }) => Promise<unknown>) =>
        await db.transaction(async (tx) =>
          callback({
            query: (async (sql: string, params?: unknown[]) => {
              if (sql.includes('WITH targets(')) {
                capturedMatchQueries.push({ params: params ?? [], sql });
              }
              return await tx.query(sql, params);
            }) as typeof db.query,
          })
        ),
    };

    await invalidateManagedCacheEntriesByIdentity(capturingDb, {
      embeddingSetId: 'set-1',
      targets: [
        { relativePath: 'src/plan/exact.ts', rootId: 'root-fixture' },
        { mode: 'prefix', relativePathPrefix: 'src/plan/dir', rootId: 'root-fixture' },
      ],
    });

    expect(capturedMatchQueries.length).toBeGreaterThan(0);
    await db.query('ANALYZE file_records');
    // Force index paths so the plan shape is deterministic on a tiny table.
    await db.query('SET enable_seqscan = off');
    try {
      for (const { params, sql } of capturedMatchQueries) {
        const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
        const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        const pathIndexCondLines = planText
          .split('\n')
          .filter((line) => line.includes('Index Cond:') && line.includes('path'));
        expect(
          pathIndexCondLines.length,
          `path not in any Index Cond:\n${planText}`
        ).toBeGreaterThan(0);
      }
    } finally {
      await db.query('RESET enable_seqscan');
    }
  });

  it('commits each invalidation target batch independently so a later batch failure keeps earlier deletions and leaves stats dirty', async () => {
    // One long transaction across all batches blocks every other query on the
    // single-statement-at-a-time engine for the whole invalidation (observed:
    // 30s db-host timeouts). Each batch must commit on its own; the stats
    // dirty flag records that the final refresh never ran.
    await seedEmbeddingSet('set-1');
    await importManagedCacheFile({
      fileRecordId: 'batch1-file',
      relativePath: 'batch/0.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'batch2-file',
      relativePath: 'batch/299.ts',
      rootId: 'root-fixture',
    });

    const targets = Array.from({ length: 300 }, (_, index) => ({
      relativePath: `batch/${index}.ts`,
      rootId: 'root-fixture',
    }));

    let transactionCalls = 0;
    const failingDb = {
      query: async (sql: string, params?: unknown[]) => await db.query(sql, params),
      transaction: async (callback: (tx: { query: typeof db.query }) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 2) {
          throw new Error('injected second-batch failure');
        }
        return await db.transaction(async (tx) =>
          callback({
            query: ((sql: string, params?: unknown[]) => tx.query(sql, params)) as typeof db.query,
          })
        );
      },
    };

    await expect(
      invalidateManagedCacheEntriesByIdentity(failingDb, {
        embeddingSetId: 'set-1',
        targets,
      })
    ).rejects.toThrow('injected second-batch failure');

    expect(transactionCalls).toBe(2);
    await expect(fileRecordRepository.findById('batch1-file')).resolves.toBeNull();
    await expect(fileRecordRepository.findById('batch2-file')).resolves.not.toBeNull();
    await expect(getCollectionIndexingStats(db, 'set-1')).resolves.toEqual(
      expect.objectContaining({ dirty: true })
    );
  });

  it('invalidates mixed exact and prefix targets in a single call', async () => {
    await importManagedCacheFile({
      fileRecordId: 'mixed-exact-file',
      relativePath: 'src/mixed/exact.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'mixed-prefix-at-path-file',
      relativePath: 'src/mixed/dir',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'mixed-prefix-descendant-file',
      relativePath: 'src/mixed/dir/child.ts',
      rootId: 'root-fixture',
    });
    await importManagedCacheFile({
      fileRecordId: 'mixed-untouched-file',
      relativePath: 'src/mixed/other.ts',
      rootId: 'root-fixture',
    });

    const result = await invalidateManagedCacheEntriesByIdentity(db, {
      embeddingSetId: 'set-1',
      targets: [
        { relativePath: 'src/mixed/exact.ts', rootId: 'root-fixture' },
        { mode: 'prefix', relativePathPrefix: 'src/mixed/dir', rootId: 'root-fixture' },
      ],
    });

    expect(result.deletedFileRecordIds).toEqual([
      'mixed-exact-file',
      'mixed-prefix-at-path-file',
      'mixed-prefix-descendant-file',
    ]);
    await expect(fileRecordRepository.findById('mixed-untouched-file')).resolves.not.toBeNull();
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
          relativePath: 'src/delete.ts',
          rootId: 'root-fixture',
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
      leasedUntil: '2999-01-01T00:00:00.000Z',
      leaseToken: 'lease-delete-running',
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
          relativePath: 'src/job-delete.ts',
          rootId: 'root-fixture',
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

    // Lifetime canceled counter is folded into the same statement as the
    // cancel transition (aggregate-then-prune): both canceled jobs count,
    // the untouched job does not.
    expect(await readCanceledTotal('embeddings')).toBe(2);
  });

  it('replacement cancels queued and running embed jobs for old chunks before deleting chunks', async () => {
    const now = new Date().toISOString();
    await fileRecordRepository.createWithContent({
      chunkingStrategy: 'sentence',
      chunksCount: 2,
      chunksProcessedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-job-old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-job-file',
      name: 'replace-job.ts',
      path: 'src/replace-job.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
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
      leasedUntil: '2999-01-01T00:00:00.000Z',
      leaseToken: 'replace-job-running-lease',
      state: 'running',
      workerId: 'replace-job-worker',
    });
    await insertEmbeddingJob({
      chunkId: 'unrelated-replace-job-chunk',
      id: 'replace-job-unrelated',
      state: 'queued',
    });

    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const version = 2;',
            contentHash: 'replace-job-new-hash',
            id: 'replace-job-file',
            name: 'replace-job.ts',
            path: 'src/replace-job.ts',
            processedAt: now,
            size: 11,
            tokenCount: 6,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
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

    // Both replaced-chunk jobs increment the lifetime canceled counter; the
    // unrelated queued job does not.
    expect(await readCanceledTotal('embeddings')).toBe(2);
  });

  it('cancels managed-cache replacement jobs through indexed chunk_id instead of JSON payload scans', async () => {
    const now = new Date().toISOString();
    const executedSql: string[] = [];
    const recordingDb = {
      exec: db.exec.bind(db),
      query: db.query.bind(db),
      transaction: async <T>(callback: (tx: PGlite) => Promise<T>): Promise<T> =>
        await db.transaction(async (tx) => {
          const recordingTx = {
            exec: tx.exec.bind(tx),
            query: async <TRow = unknown>(
              sql: string,
              params?: unknown[]
            ): Promise<{ rows: TRow[] }> => {
              executedSql.push(sql);
              return await tx.query<TRow>(sql, params);
            },
          };
          return await callback(recordingTx as PGlite);
        }),
    };

    await fileRecordRepository.createWithContent({
      chunkingStrategy: 'sentence',
      chunksCount: 1,
      chunksProcessedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-indexed-job-old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-indexed-job-file',
      name: 'replace-indexed-job.ts',
      path: 'src/replace-indexed-job.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });
    await insertChunk({
      chunkId: 'replace-indexed-job-old-chunk',
      fileRecordId: 'replace-indexed-job-file',
    });
    await insertEmbeddingJob({
      chunkId: 'replace-indexed-job-old-chunk',
      id: 'replace-indexed-job-old-queued',
      state: 'queued',
    });

    await applyManagedCacheBatch(recordingDb as unknown as PGlite, {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const version = 2;',
            contentHash: 'replace-indexed-job-new-hash',
            id: 'replace-indexed-job-file',
            name: 'replace-indexed-job.ts',
            path: 'src/replace-indexed-job.ts',
            processedAt: now,
            size: 11,
            tokenCount: 6,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
    });

    const cancellationSql = executedSql.find(
      (sql) => sql.includes('UPDATE job_queue') && sql.includes('Managed-cache replacement')
    );

    expect(cancellationSql).toContain('chunk_id = ANY($2::text[])');
    expect(cancellationSql).not.toContain("payload->>'chunkId'");
  });

  it('rolls back replacement chunk deletion when a later import in the batch fails', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      chunkingStrategy: 'sentence',
      chunksCount: 1,
      chunksProcessedAt: now,
      content: 'export const version = 1;',
      contentHash: 'old-content-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-file',
      name: 'replace.ts',
      path: 'src/replace.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });

    await fileChunkRepository.insert({
      chunkIndex: 0,
      chunkSize: 16,
      chunkType: 'sentence',
      content: 'old chunk',
      contentHash: 'chunk-old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      fileRecordId: 'replace-file',
      id: 'chunk-old',
      tokenCount: 4,
      updatedAt: now,
    });

    await fileRecordRepository.createWithContent({
      content: 'export const existing = true;',
      contentHash: 'existing-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'duplicate-import',
      name: 'existing.ts',
      path: 'src/existing.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });

    await fileRecordRepository.update('replace-file', {
      chunkingStrategy: 'sentence',
      chunksCount: 1,
      chunksProcessedAt: now,
    });

    await expect(
      applyManagedCacheBatch(db, {
        changes: [
          {
            mode: 'replace',
            record: {
              content: 'export const version = 2;',
              contentHash: 'new-content-hash',
              id: 'replace-file',
              name: 'replace.ts',
              path: 'src/replace.ts',
              processedAt: now,
              size: 11,
              tokenCount: 6,
              updatedAt: now,
            },
          },
          {
            mode: 'import',
            record: {
              content: 'export const shouldFail = true;',
              contentHash: 'duplicate-hash',
              createdAt: now,
              id: 'duplicate-import',
              name: 'new.ts',
              path: 'src/new.ts',
              processedAt: now,
              size: 12,
              tokenCount: 7,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow();

    const restoredRecord = await fileRecordRepository.findById('replace-file');
    const restoredChunks = await fileChunkRepository.findByFileRecordId('replace-file');

    expect(restoredRecord).toEqual(
      expect.objectContaining({
        chunkingStrategy: 'sentence',
        chunksCount: 1,
        content: 'export const version = 1;',
        contentHash: 'old-content-hash',
        id: 'replace-file',
      })
    );
    expect(restoredChunks).toHaveLength(1);
    expect(restoredChunks[0]).toEqual(
      expect.objectContaining({
        content: 'old chunk',
        id: 'chunk-old',
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
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const shouldRollback = true;',
              contentHash: 'stats-failure-hash',
              createdAt: now,
              id: 'stats-failure-import',
              name: 'stats-failure.ts',
              path: 'src/stats-failure.ts',
              processedAt: now,
              size: 12,
              tokenCount: 4,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow('simulated stats refresh failure');

    await expect(fileRecordRepository.findById('stats-failure-import')).resolves.toBeNull();
  });

  it('rejects oversized public batches before issuing parameter-heavy SQL', async () => {
    const now = new Date().toISOString();

    const oversizedImports = Array.from({ length: 5462 }, (_, index) => ({
      mode: 'import' as const,
      record: {
        content: 'export const value = 1;',
        contentHash: `hash-${index}`,
        createdAt: now,
        id: `import-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        processedAt: now,
        size: 10,
        tokenCount: 5,
        updatedAt: now,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        changes: oversizedImports,
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow('Managed cache batch import exceeds the PostgreSQL parameter limit.');

    const oversizedReplacements = Array.from({ length: 6554 }, (_, index) => ({
      mode: 'replace' as const,
      record: {
        content: 'export const value = 2;',
        contentHash: `replace-hash-${index}`,
        id: `replace-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        processedAt: now,
        size: 10,
        tokenCount: 5,
        updatedAt: now,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        changes: oversizedReplacements,
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow('Managed cache batch replace exceeds the PostgreSQL parameter limit.');
  });

  it('rejects oversized total mutation counts before batching into SQL statements', async () => {
    const now = new Date().toISOString();
    const oversizedCombinedBatch = Array.from({ length: 12_015 }, (_, index) => ({
      mode: 'replace' as const,
      record: {
        content: 'export const value = 2;',
        contentHash: `replace-total-hash-${index}`,
        id: `replace-total-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        processedAt: now,
        size: 10,
        tokenCount: 5,
        updatedAt: now,
      },
    }));

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: oversizedCombinedBatch,
        embeddingSetId: 'set-1',
      })
    ).toThrow('Managed cache batch exceeds the maximum supported total size.');
  });

  it('rejects duplicate file record ids in a single batch with a clear error', async () => {
    const now = new Date().toISOString();

    await expect(
      applyManagedCacheBatch(db, {
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const first = true;',
              contentHash: 'hash-first',
              createdAt: now,
              id: 'duplicate-id',
              name: 'first.ts',
              path: 'src/first.ts',
              processedAt: now,
              size: 10,
              tokenCount: 5,
              updatedAt: now,
            },
          },
          {
            mode: 'replace',
            record: {
              content: 'export const second = true;',
              contentHash: 'hash-second',
              id: 'duplicate-id',
              name: 'second.ts',
              path: 'src/second.ts',
              processedAt: now,
              size: 10,
              tokenCount: 5,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).rejects.toThrow('Managed cache batch contains duplicate file record id duplicate-id.');
  });

  it('applies replacement-only batches with numeric file metadata successfully', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      chunkingStrategy: 'sentence',
      chunksCount: 1,
      chunksProcessedAt: now,
      content: 'export const version = 1;',
      contentHash: 'replace-only-old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-only-file',
      name: 'replace-only.ts',
      path: 'src/replace-only.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });

    await fileChunkRepository.insert({
      chunkIndex: 0,
      chunkSize: 16,
      chunkType: 'sentence',
      content: 'old chunk',
      contentHash: 'replace-only-chunk-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      fileRecordId: 'replace-only-file',
      id: 'replace-only-chunk',
      tokenCount: 4,
      updatedAt: now,
    });

    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const version = 2;',
            contentHash: 'replace-only-new-hash',
            id: 'replace-only-file',
            name: 'replace-only.ts',
            path: 'src/replace-only.ts',
            processedAt: now,
            size: 11,
            tokenCount: 6,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
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
        content: 'export const version = 2;',
        contentHash: 'replace-only-new-hash',
        id: 'replace-only-file',
        size: 11,
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
      changes: [
        {
          mode: 'import',
          record: {
            content: 'export const imported = true;',
            contentHash: 'import-only-hash',
            createdAt: now,
            id: 'import-only-file',
            name: 'import-only.ts',
            path: 'src/import-only.ts',
            processedAt: now,
            size: 12,
            tokenCount: 4,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
    });

    const insertedRecord = await fileRecordRepository.findById('import-only-file');
    expect(insertedRecord).toEqual(
      expect.objectContaining({
        contentHash: 'import-only-hash',
        embeddingSetId: 'set-1',
        id: 'import-only-file',
      })
    );
  });

  it('persists mtimeMs on import and surfaces it with size for the stat-cache fast-path', async () => {
    const now = new Date().toISOString();
    const mtimeMs = 1_700_000_000_000;

    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'import',
          record: {
            content: 'export const value = 1;',
            contentHash: 'stat-hash',
            createdAt: now,
            id: 'stat-cache-file',
            mtimeMs,
            name: 'stat.ts',
            path: 'src/stat.ts',
            processedAt: now,
            size: 128,
            tokenCount: 5,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
    });

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'stat-cache-file',
        mtimeMs,
        relativePath: 'src/stat.ts',
        size: 128,
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
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const value = 1;',
              contentHash: 'frac-hash',
              createdAt: now,
              id: 'fractional-mtime-file',
              mtimeMs: fractionalMtimeMs,
              name: 'frac.ts',
              path: 'src/frac.ts',
              processedAt: now,
              size: 64,
              tokenCount: 5,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
        rootId: 'root-fixture',
      })
    ).resolves.toBeUndefined();

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'fractional-mtime-file',
        mtimeMs: Math.floor(fractionalMtimeMs),
        relativePath: 'src/frac.ts',
      }),
    ]);
  });

  it('persists mtimeMs on replace so an in-place edit refreshes the stat-cache', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      content: 'export const version = 1;',
      contentHash: 'old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-stat-file',
      name: 'stat.ts',
      path: 'src/stat.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });
    // Stamp the managed-cache identity (root_id) — createWithContent does not
    // set it, and listManagedCacheEntryMetadata only returns root_id-bearing rows.
    await db.query(
      "UPDATE file_records SET root_id = 'root-fixture' WHERE id = 'replace-stat-file'"
    );

    const newMtimeMs = 1_800_000_000_000;
    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const version = 2;',
            contentHash: 'new-hash',
            id: 'replace-stat-file',
            mtimeMs: newMtimeMs,
            name: 'stat.ts',
            path: 'src/stat.ts',
            processedAt: now,
            size: 20,
            tokenCount: 6,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-fixture',
    });

    const entries = await fileRecordRepository.listManagedCacheEntryMetadata('set-1');
    expect(entries).toEqual([
      expect.objectContaining({
        fileRecordId: 'replace-stat-file',
        mtimeMs: newMtimeMs,
        relativePath: 'src/stat.ts',
        size: 20,
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
      changes: [
        {
          mode: 'import',
          record: {
            content: 'export const rootId = true;',
            contentHash: 'root-id-import-hash',
            createdAt: now,
            id: 'root-id-import-file',
            name: 'root-id-import.ts',
            path: 'src/root-id-import.ts',
            processedAt: now,
            size: 10,
            tokenCount: 5,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-db-1',
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
        changes: [
          {
            mode: 'import',
            record: {
              content: 'export const noRootId = true;',
              contentHash: 'no-root-id-hash',
              createdAt: now,
              id: 'no-root-id-import-file',
              name: 'no-root-id.ts',
              path: 'src/no-root-id.ts',
              processedAt: now,
              size: 10,
              tokenCount: 5,
              updatedAt: now,
            },
          },
        ],
        embeddingSetId: 'set-1',
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
      content: 'export const version = 1;',
      contentHash: 'replace-with-root-old-hash',
      createdAt: now,
      embeddingSetId: 'set-1',
      id: 'replace-with-root-file',
      name: 'replace-with-root.ts',
      path: 'src/replace-with-root.ts',
      processedAt: now,
      size: 10,
      tokenCount: 5,
      updatedAt: now,
    });
    await db.query(
      `UPDATE file_records SET root_id = 'root-db-replace' WHERE id = 'replace-with-root-file'`
    );

    // Apply a replace batch — root_id must NOT be cleared or changed.
    await applyManagedCacheBatch(db, {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const version = 2;',
            contentHash: 'replace-with-root-new-hash',
            id: 'replace-with-root-file',
            name: 'replace-with-root.ts',
            path: 'src/replace-with-root.ts',
            processedAt: now,
            size: 20,
            tokenCount: 6,
            updatedAt: now,
          },
        },
      ],
      embeddingSetId: 'set-1',
      rootId: 'root-db-replace',
    });

    const result = await db.query<{ root_id: string | null }>(
      'SELECT root_id FROM file_records WHERE id = $1',
      ['replace-with-root-file']
    );
    expect(result.rows[0]?.root_id).toBe('root-db-replace');
  });

  it('parseManagedCacheBatchArgs accepts rootId as a non-empty string', () => {
    const parsed = parseManagedCacheBatchArgs({
      changes: [],
      embeddingSetId: 'set-1',
      rootId: 'root-db-1',
    });
    expect(parsed.rootId).toBe('root-db-1');
  });

  it('parseManagedCacheBatchArgs accepts absent rootId (back-compat)', () => {
    const parsed = parseManagedCacheBatchArgs({
      changes: [],
      embeddingSetId: 'set-1',
    });
    expect(parsed.rootId).toBeUndefined();
  });

  it('parseManagedCacheBatchArgs accepts null rootId', () => {
    const parsed = parseManagedCacheBatchArgs({
      changes: [],
      embeddingSetId: 'set-1',
      rootId: null,
    });
    expect(parsed.rootId).toBeNull();
  });

  it('parseManagedCacheBatchArgs rejects a non-string non-null rootId with a thrown error', () => {
    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [],
        embeddingSetId: 'set-1',
        rootId: 42,
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [],
        embeddingSetId: 'set-1',
        rootId: true,
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [],
        embeddingSetId: 'set-1',
        rootId: [],
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');

    // '' would pass a bare typeof check and reach the DB as a doomed FK lookup.
    expect(() =>
      parseManagedCacheBatchArgs({
        changes: [],
        embeddingSetId: 'set-1',
        rootId: '',
      })
    ).toThrow('Managed cache batch payload rootId must be a non-empty string or null.');
  });
});
