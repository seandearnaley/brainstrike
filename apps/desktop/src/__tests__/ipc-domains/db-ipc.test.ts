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
const { createDefaultMockDatabase, execSpy, getDatabaseMock, querySpy, transactionSpy } =
  vi.hoisted(() => {
    const querySpy = vi.fn();
    const execSpy = vi.fn();
    const transactionSpy = vi.fn();
    const createDefaultMockDatabase = () => ({
      exec: async (sql: string, params?: unknown[], workOptions?: unknown) => {
        execSpy({ params, sql, workOptions });
        return { rows: [] };
      },
      query: async (sql: string, params?: unknown[], workOptions?: unknown) => {
        querySpy({ params, sql, workOptions });
        return { rows: [{ id: 'deleted-job-1' }] };
      },
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
            if (sql.includes('SELECT id') && sql.includes("state = 'failed'")) {
              return { rows: [{ id: 'failed-job-1' }] };
            }
            if (
              sql.includes('SELECT id') &&
              sql.includes("state = 'queued' AND attempts >= max_attempts")
            ) {
              return { rows: [{ id: 'blocked-queued-job-1' }] };
            }
            if (sql.includes('SET state =') && sql.includes('WHERE id IN')) {
              return { rows: [{ id: String(params?.[2] ?? 'reset-job-1') }] };
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
      execSpy,
      getDatabaseMock: vi.fn(async () => createDefaultMockDatabase()),
      querySpy,
      transactionSpy,
    };
  });
const { dbHostManagerMock } = vi.hoisted(() => ({
  dbHostManagerMock: {
    insertChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
    runTursoEmbeddingWorkerQueueOperation: vi.fn(async () => [{ id: 'job-1', state: 'running' }]),
    runTursoEmbeddingWorkerStatsOperation: vi.fn(async () => undefined),
    runTursoVectorQueueAction: vi.fn(async () => ({ repairedQueued: 1, requeuedFailed: 1 })),
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
    execSpy.mockClear();
    querySpy.mockClear();
    transactionSpy.mockClear();
    dbHostManagerMock.insertChunksAndEnqueueEmbeddingJobs.mockClear();
    dbHostManagerMock.runTursoEmbeddingWorkerQueueOperation.mockClear();
    dbHostManagerMock.runTursoEmbeddingWorkerStatsOperation.mockClear();
    dbHostManagerMock.runTursoVectorQueueAction.mockClear();
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

  it('forwards renderer query and exec work options to the runtime DB client', async () => {
    const queryWorkOptions = { label: 'assistant foreground query', priority: 'foreground' };
    const execWorkOptions = { label: 'assistant foreground exec', priority: 'normal' };

    await expect(
      handlers.get('db:query')?.(
        {} as IpcMainInvokeEvent,
        'SELECT id FROM file_records WHERE id = $1',
        ['file-1'],
        queryWorkOptions
      )
    ).resolves.toEqual({ rows: [{ id: 'deleted-job-1' }] });

    await expect(
      handlers.get('db:exec')?.(
        {} as IpcMainInvokeEvent,
        'UPDATE file_records SET updated_at = $1 WHERE id = $2',
        ['2026-07-03T08:00:00.000Z', 'file-1'],
        execWorkOptions
      )
    ).resolves.toEqual({ rows: [] });

    expect(querySpy).toHaveBeenCalledWith({
      params: ['file-1'],
      sql: 'SELECT id FROM file_records WHERE id = $1',
      workOptions: queryWorkOptions,
    });
    expect(execSpy).toHaveBeenCalledWith({
      params: ['2026-07-03T08:00:00.000Z', 'file-1'],
      sql: 'UPDATE file_records SET updated_at = $1 WHERE id = $2',
      workOptions: execWorkOptions,
    });
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

  it('forwards Turso embedding worker queue operations to the DB host manager', async () => {
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
        state: 'running',
      }),
    ]);
    expect(dbHostManagerMock.runTursoEmbeddingWorkerQueueOperation).toHaveBeenCalledWith(
      {
        operation: 'claimMany',
        payload: {
          leaseMs: 60_000,
          limit: 1,
          now: '2026-06-30T10:01:00.000Z',
          queue: 'embeddings',
          workerId: 'worker-1',
        },
      },
      { label: 'turso.embedding-worker.queue.claimMany', priority: 'background' }
    );
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('forwards Turso embedding worker stats operations to the DB host manager', async () => {
    await expect(
      handlers.get('db:turso-embedding-worker:stats')?.(
        {} as IpcMainInvokeEvent,
        'refresh',
        ['set-1'],
        { label: 'turso.embedding-worker.stats.refresh', priority: 'background' }
      )
    ).resolves.toBeUndefined();

    expect(dbHostManagerMock.runTursoEmbeddingWorkerStatsOperation).toHaveBeenCalledWith(
      {
        embeddingSetIds: ['set-1'],
        operation: 'refresh',
      },
      { label: 'turso.embedding-worker.stats.refresh', priority: 'background' }
    );
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('forwards Turso vector queue action operations to the DB host manager', async () => {
    const result = await handlers.get('db:turso-vector-queue:action')?.(
      {} as IpcMainInvokeEvent,
      'retryFailed',
      { limit: 5 },
      { label: 'turso.vector-queue.action.retryFailed', priority: 'normal' }
    );

    expect(result).toEqual({
      repairedQueued: 1,
      requeuedFailed: 1,
    });
    expect(dbHostManagerMock.runTursoVectorQueueAction).toHaveBeenCalledWith(
      {
        operation: 'retryFailed',
        payload: { limit: 5 },
      },
      { label: 'turso.vector-queue.action.retryFailed', priority: 'normal' }
    );
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('forwards Turso vector queue clearQueue without serializing an absent state filter', async () => {
    dbHostManagerMock.runTursoVectorQueueAction.mockResolvedValueOnce({ cleared: 1 });

    const result = await handlers.get('db:turso-vector-queue:action')?.(
      {} as IpcMainInvokeEvent,
      'clearQueue',
      {},
      { label: 'turso.vector-queue.action.clearQueue', priority: 'normal' }
    );

    expect(result).toEqual({ cleared: 1 });
    expect(dbHostManagerMock.runTursoVectorQueueAction).toHaveBeenCalledWith(
      {
        operation: 'clearQueue',
        payload: {},
      },
      { label: 'turso.vector-queue.action.clearQueue', priority: 'normal' }
    );
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
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
