import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FileChunkInsert,
  type FileRecord,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoFileRecordRepository,
  TursoJobQueue,
} from '@brainstrike/db';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { applyTursoSchemaBaseline } from '@brainstrike/db/turso/schema-baseline';
import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { handlers, removeHandler } = vi.hoisted(() => {
  const registeredHandlers = new Map<string, IpcHandler>();
  return {
    handlers: registeredHandlers,
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

// Fake main-process PGlite whose transaction() runs the callback against a tx that
// echoes the statements, so the db:transaction success path can be exercised without
// a real database.
const { createDefaultMockDatabase, getDatabaseMock, transactionSpy } = vi.hoisted(() => {
  const transactionSpy = vi.fn();
  const createDefaultMockDatabase = () => ({
    transaction: async (
      fn: (tx: {
        exec?: (sql: string, params?: unknown[]) => Promise<void>;
        query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      }) => Promise<unknown>
    ) => {
      const queries: { sql: string; params?: unknown[] }[] = [];
      const result = await fn({
        exec: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
        },
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('FROM job_queue') && sql.includes('LIMIT ?')) {
            return {
              rows: [
                {
                  attempts: 0,
                  backoff_ms: 0,
                  chunk_id: 'chunk-1',
                  created_at: '2026-06-30T10:00:00.000Z',
                  dedupe_key: null,
                  embedding_set_id: 'embedding-set-1',
                  error: null,
                  id: 'job-1',
                  job_type: 'embed_chunk',
                  lease_token: null,
                  leased_until: null,
                  max_attempts: 5,
                  payload: JSON.stringify({
                    chunkId: 'chunk-1',
                    embeddingSetId: 'embedding-set-1',
                  }),
                  queue: 'embeddings',
                  run_at: '2026-06-30T10:00:00.000Z',
                  state: 'queued',
                  updated_at: '2026-06-30T10:00:00.000Z',
                  worker_id: null,
                },
              ],
            };
          }
          if (sql.includes('UPDATE job_queue') && sql.includes('RETURNING *')) {
            return {
              rows: [
                {
                  attempts: 1,
                  backoff_ms: 0,
                  chunk_id: 'chunk-1',
                  created_at: '2026-06-30T10:00:00.000Z',
                  dedupe_key: null,
                  embedding_set_id: 'embedding-set-1',
                  error: null,
                  id: 'job-1',
                  job_type: 'embed_chunk',
                  lease_token: String(params?.[0]),
                  leased_until: String(params?.[1]),
                  max_attempts: 5,
                  payload: JSON.stringify({
                    chunkId: 'chunk-1',
                    embeddingSetId: 'embedding-set-1',
                  }),
                  queue: 'embeddings',
                  run_at: '2026-06-30T10:00:00.000Z',
                  state: 'running',
                  updated_at: String(params?.[3]),
                  worker_id: String(params?.[2]),
                },
              ],
            };
          }
          return { rows: [{ sql }] };
        },
      });
      transactionSpy(queries);
      return result;
    },
  });
  return {
    createDefaultMockDatabase,
    getDatabaseMock: vi.fn(async () => createDefaultMockDatabase()),
    transactionSpy,
  };
});
const { dbHostManagerMock } = vi.hoisted(() => ({
  dbHostManagerMock: {
    insertChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
  },
}));
vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  isCorruptionError: () => false,
  handleRuntimeCorruption: vi.fn(),
}));
vi.mock('../../db-host-manager', () => ({
  getDbHostManager: vi.fn(() => dbHostManagerMock),
}));

import { registerDatabaseIpcHandlers } from '../../ipc-domains/db-ipc';

describe('database IPC domain', () => {
  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    getDatabaseMock.mockReset();
    getDatabaseMock.mockImplementation(async () => createDefaultMockDatabase());
    transactionSpy.mockClear();
    dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs.mockClear();
    registerDatabaseIpcHandlers({});
  });

  it('registers lightweight diagnostics handlers and unregisters owned channels', async () => {
    await expect(handlers.get('db:ping')?.({} as IpcMainInvokeEvent)).resolves.toEqual({
      message: 'ping',
      success: true,
    });
    await expect(
      handlers.get('db:scheduler:snapshot')?.({} as IpcMainInvokeEvent)
    ).resolves.toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      runningPriority: null,
    });

    const unregister = registerDatabaseIpcHandlers({});
    unregister();
    expect(removeHandler).toHaveBeenCalledWith('db:ping');
    expect(removeHandler).toHaveBeenCalledWith('db:scheduler:snapshot');
    expect(removeHandler).toHaveBeenCalledWith('db:live-query:start');
  });

  it('rejects malformed renderer SQL before scheduling database work', async () => {
    await expect(
      handlers.get('db:query')?.({} as IpcMainInvokeEvent, 'SELECT\0 1')
    ).rejects.toThrow('db:query SQL must not contain null bytes.');

    await expect(handlers.get('db:exec')?.({} as IpcMainInvokeEvent, '')).rejects.toThrow(
      'db:exec SQL must be a non-empty string.'
    );
  });

  it('keeps raw renderer SQL inside the documented app-internal policy', async () => {
    await expect(
      handlers.get('db:query')?.({} as IpcMainInvokeEvent, 'DROP TABLE file_records')
    ).rejects.toThrow('db:query does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.({} as IpcMainInvokeEvent, 'DROP TABLE file_records')
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.({} as IpcMainInvokeEvent, 'DROP TYPE file_record_kind')
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');

    await expect(
      handlers.get('db:exec')?.(
        {} as IpcMainInvokeEvent,
        'ALTER TABLE file_records DROP COLUMN path'
      )
    ).rejects.toThrow('db:exec does not permit destructive schema SQL from the renderer.');
  });

  it('validates the db:transaction statement list and guards each statement SQL', async () => {
    // Empty / non-array statement list is rejected before any DB work.
    await expect(handlers.get('db:transaction')?.({} as IpcMainInvokeEvent, [])).rejects.toThrow(
      'db:transaction requires a non-empty statements array.'
    );

    // Every statement's SQL passes through the same assertRendererSql guard as db:query.
    await expect(
      handlers.get('db:transaction')?.({} as IpcMainInvokeEvent, [
        { sql: "SET LOCAL hnsw.ef_search = '1'" },
        { sql: 'SELECT\0 1' },
      ])
    ).rejects.toThrow('db:transaction SQL must not contain null bytes.');

    await expect(
      handlers.get('db:transaction')?.({} as IpcMainInvokeEvent, [
        { sql: 'DROP TABLE file_records' },
      ])
    ).rejects.toThrow('db:transaction does not permit destructive schema SQL from the renderer.');
  });

  it('runs db:transaction statements through a single main-process transaction', async () => {
    const result = await handlers.get('db:transaction')?.(
      {} as IpcMainInvokeEvent,
      [
        { sql: "SET LOCAL hnsw.ef_search = '120'" },
        { sql: 'SELECT id FROM file_chunks WHERE embedding_set_id = $1', params: ['set-1'] },
      ],
      1
    );

    // The handler returns the rows of statements[resultIndex] (the SELECT).
    expect(result).toEqual({
      rows: [{ sql: 'SELECT id FROM file_chunks WHERE embedding_set_id = $1' }],
    });
    // Both statements ran inside ONE transaction() call, in order.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const ranSql = transactionSpy.mock.calls[0]?.[0]?.map((s: { sql: string }) => s.sql);
    expect(ranSql).toEqual([
      "SET LOCAL hnsw.ef_search = '120'",
      'SELECT id FROM file_chunks WHERE embedding_set_id = $1',
    ]);
  });

  it('forwards atomic chunk/job enqueue payloads to the DB host manager', async () => {
    const now = new Date().toISOString();
    await expect(
      handlers.get('db:chunks:insert-and-enqueue-embedding-jobs')?.(
        {} as IpcMainInvokeEvent,
        {
          chunks: [
            {
              chunkIndex: 0,
              chunkSize: 12,
              chunkType: 'sentence',
              content: 'hello world',
              contentHash: 'chunk-hash',
              createdAt: now,
              fileRecordId: 'file-1',
              id: 'chunk-1',
              tokenCount: 2,
              updatedAt: now,
            },
          ],
          fileRecordId: 'file-1',
          options: {
            dimensionParameter: null,
            model: 'local::Xenova/all-MiniLM-L6-v2',
            provider: 'local',
            targetDimension: 384,
            targetEmbeddingSetId: 'workspace-index',
          },
        },
        { label: 'workspace-index import', priority: 'background' }
      )
    ).resolves.toBeUndefined();

    expect(dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith({
      chunks: [
        expect.objectContaining({
          contentHash: 'chunk-hash',
          fileRecordId: 'file-1',
          id: 'chunk-1',
        }),
      ],
      dimensionParameter: null,
      fileRecordId: 'file-1',
      model: 'local::Xenova/all-MiniLM-L6-v2',
      provider: 'local',
      targetDimension: 384,
      targetEmbeddingSetId: 'workspace-index',
    });
  });

  it('runs Turso embedding worker queue operations against the main DB transaction client', async () => {
    const result = await handlers.get('db:turso-embedding-worker:queue')?.(
      {} as IpcMainInvokeEvent,
      'claimMany',
      {
        leaseMs: 60_000,
        limit: 1,
        now: '2026-06-30T10:01:00.000Z',
        queue: 'embeddings',
        workerId: 'worker-1',
      },
      { label: 'turso.embedding-worker.queue.claimMany', priority: 'background' }
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: 'job-1',
        jobType: 'embed_chunk',
        lease_token: expect.any(String),
        state: 'running',
        worker_id: 'worker-1',
      }),
    ]);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const ranSql = transactionSpy.mock.calls[0]?.[0]?.map((s: { sql: string }) => s.sql);
    expect(ranSql).toEqual([
      expect.stringContaining('SELECT *'),
      expect.stringContaining('UPDATE job_queue'),
    ]);
  });

  it('drives Turso embedding worker queue and stats IPC through a real owner client', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-worker-ipc-'));
    const client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    try {
      await applyTursoSchemaBaseline(client);
      const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
      const fileRecordsRepository = new TursoFileRecordRepository(client);
      const chunkRepository = new TursoFileChunkRepository(client);
      const queue = new TursoJobQueue(client);
      const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
        'local::test-model',
        'test-model',
        3,
        'cosine'
      );
      await fileRecordsRepository.createWithContent(
        createRecord({ embeddingSetId: embeddingSet.id })
      );
      await chunkRepository.insert(createChunk({ embeddingSetId: embeddingSet.id }));
      const job = await queue.enqueue({
        queue: 'embeddings',
        jobType: 'embed_chunk',
        payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
        runAt: '2026-06-30T10:00:00.000Z',
      });
      getDatabaseMock.mockResolvedValue(client);

      const claimed = await handlers.get('db:turso-embedding-worker:queue')?.(
        {} as IpcMainInvokeEvent,
        'claimMany',
        {
          leaseMs: 60_000,
          limit: 1,
          now: '2026-06-30T10:01:00.000Z',
          queue: 'embeddings',
          workerId: 'worker-real-owner',
        },
        { label: 'turso.embedding-worker.queue.claimMany', priority: 'background' }
      );

      expect(claimed).toEqual([
        expect.objectContaining({
          id: job.id,
          lease_token: expect.any(String),
          state: 'running',
          worker_id: 'worker-real-owner',
        }),
      ]);
      const [claimedJob] = claimed as Array<{ lease_token: string }>;

      const completed = await handlers.get('db:turso-embedding-worker:queue')?.(
        {} as IpcMainInvokeEvent,
        'completeEmbeddingChunkBatch',
        [
          {
            id: job.id,
            leaseToken: claimedJob.lease_token,
            chunkId: 'chunk-1',
            embedding: [0.1, 0.2, 0.3],
            embeddingHash: 'embedding-hash-ipc',
            embeddingSetId: embeddingSet.id,
          },
        ],
        {
          label: 'turso.embedding-worker.queue.completeEmbeddingChunkBatch',
          priority: 'background',
        }
      );

      expect(completed).toEqual([
        expect.objectContaining({
          id: job.id,
          state: 'succeeded',
        }),
      ]);
      await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
        embedding: [0.1, 0.2, 0.3],
        embeddingHash: 'embedding-hash-ipc',
        embeddingSetId: embeddingSet.id,
      });

      await handlers.get('db:turso-embedding-worker:stats')?.(
        {} as IpcMainInvokeEvent,
        'markDirty',
        [embeddingSet.id],
        { label: 'turso.embedding-worker.stats.markDirty', priority: 'background' }
      );
      await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({ dirty: 1 });

      await handlers.get('db:turso-embedding-worker:stats')?.(
        {} as IpcMainInvokeEvent,
        'refresh',
        [embeddingSet.id],
        { label: 'turso.embedding-worker.stats.refresh', priority: 'background' }
      );

      await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({
        chunk_count: 1,
        dirty: 0,
        embedded_chunk_count: 1,
        file_count: 1,
        pending_chunk_count: 0,
      });
    } finally {
      await client.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('rejects malformed atomic chunk/job payloads before DB host scheduling', async () => {
    await expect(
      handlers.get('db:chunks:insert-and-enqueue-embedding-jobs')?.({} as IpcMainInvokeEvent, {
        chunks: [],
        fileRecordId: 'file-1',
        options: {
          model: 'local::Xenova/all-MiniLM-L6-v2',
          provider: 'local',
          targetDimension: 0,
        },
      })
    ).rejects.toThrow('Atomic chunk/job enqueue requires a positive targetDimension.');

    expect(dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs).not.toHaveBeenCalled();
  });
});

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-06-30T09:50:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-30T09:50:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-06-30T09:55:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-30T09:55:00.000Z',
    ...overrides,
  };
}

async function readStatsRow(client: TursoOwnerClient, embeddingSetId: string) {
  const result = await client.query<{
    chunk_count: number | string;
    dirty: number | string;
    embedded_chunk_count: number | string;
    file_count: number | string;
    pending_chunk_count: number | string;
  }>(
    `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
       FROM collection_indexing_stats
      WHERE embedding_set_id = ?`,
    [embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    chunk_count: Number(row.chunk_count),
    dirty: Number(row.dirty),
    embedded_chunk_count: Number(row.embedded_chunk_count),
    file_count: Number(row.file_count),
    pending_chunk_count: Number(row.pending_chunk_count),
  };
}
