import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ParentPortMock {
  readonly on: (event: 'message', listener: (message: unknown) => void) => ParentPortMock;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

const dbMainMocks = vi.hoisted(() => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  getDatabaseDiagnostics: vi.fn(() => ({ hasDatabaseHandle: true })),
  initializeMainDatabase: vi.fn(),
  initializeMainDatabaseWithBootstrapReport: vi.fn(),
  resetLocalDatabase: vi.fn(),
}));

vi.mock('../../db-main', () => dbMainMocks);

const dbPackageMocks = vi.hoisted(() => ({
  insertChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
  insertTursoChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
  applyManagedCacheBatch: vi.fn(async () => undefined),
  applyTursoManagedCacheBatch: vi.fn(async () => undefined),
  markTursoCollectionIndexingStatsDirty: vi.fn(async () => undefined),
  refreshTursoCollectionIndexingStats: vi.fn(async () => undefined),
  tursoFileChunkRepositoryClearEmbeddingsForSet: vi.fn(async () => 3),
  tursoJobQueueClear: vi.fn(async () => 4),
  tursoJobQueueClaimMany: vi.fn(async () => [{ id: 'job-1', state: 'running' }]),
  tursoJobQueueCompleteBatch: vi.fn(async () => [{ id: 'job-1', state: 'done' }]),
  tursoJobQueueCompleteEmbeddingChunkBatch: vi.fn(async () => [{ id: 'job-2', state: 'done' }]),
  tursoJobQueueFail: vi.fn(async () => ({ id: 'job-3', state: 'failed' })),
  tursoJobQueueFailBatch: vi.fn(async () => [{ id: 'job-4', state: 'failed' }]),
  tursoJobQueueHeartbeatBatch: vi.fn(async () => [{ id: 'job-5', state: 'running' }]),
  tursoJobQueueRepairUnclaimableQueued: vi.fn(async () => 5),
  tursoJobQueueRequeueFailed: vi.fn(async () => 6),
  invalidateManagedCacheEntriesByIdentity: vi.fn(async () => ({
    canceledEmbeddingJobCount: 0,
    deletedChunkIds: [],
    deletedFileRecordIds: [],
  })),
  invalidateTursoManagedCacheEntriesByIdentity: vi.fn(async () => ({
    canceledEmbeddingJobCount: 0,
    deletedChunkIds: [],
    deletedFileRecordIds: [],
  })),
}));

vi.mock('@brainstrike/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...original,
    applyManagedCacheBatch: dbPackageMocks.applyManagedCacheBatch,
    applyTursoManagedCacheBatch: dbPackageMocks.applyTursoManagedCacheBatch,
    insertChunksAndEnqueueEmbeddingJobs: dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs,
    insertTursoChunksAndEnqueueEmbeddingJobs:
      dbPackageMocks.insertTursoChunksAndEnqueueEmbeddingJobs,
    invalidateManagedCacheEntriesByIdentity: dbPackageMocks.invalidateManagedCacheEntriesByIdentity,
    invalidateTursoManagedCacheEntriesByIdentity:
      dbPackageMocks.invalidateTursoManagedCacheEntriesByIdentity,
    markTursoCollectionIndexingStatsDirty: dbPackageMocks.markTursoCollectionIndexingStatsDirty,
    refreshTursoCollectionIndexingStats: dbPackageMocks.refreshTursoCollectionIndexingStats,
    TursoFileChunkRepository: class TursoFileChunkRepository {
      clearEmbeddingsForSet = dbPackageMocks.tursoFileChunkRepositoryClearEmbeddingsForSet;
    },
    TursoJobQueue: class TursoJobQueue {
      clear = dbPackageMocks.tursoJobQueueClear;
      claimMany = dbPackageMocks.tursoJobQueueClaimMany;
      completeBatch = dbPackageMocks.tursoJobQueueCompleteBatch;
      completeEmbeddingChunkBatch = dbPackageMocks.tursoJobQueueCompleteEmbeddingChunkBatch;
      fail = dbPackageMocks.tursoJobQueueFail;
      failBatch = dbPackageMocks.tursoJobQueueFailBatch;
      heartbeatBatch = dbPackageMocks.tursoJobQueueHeartbeatBatch;
      repairUnclaimableQueued = dbPackageMocks.tursoJobQueueRepairUnclaimableQueued;
      requeueFailed = dbPackageMocks.tursoJobQueueRequeueFailed;
    },
  };
});

function createReadyBootstrapProbeReport(engine: 'pglite' | 'turso' = 'pglite') {
  const checkIds =
    engine === 'turso'
      ? [
          'store.open',
          'primary-store.mvcc',
          'schema.baseline',
          'search.grep-content-grams',
          'search.ownership',
          'store.close',
        ]
      : [
          'store.open',
          'schema.migrated',
          'extension.pgvector',
          'extension.pg_trgm',
          'search.fts-grep',
          'capability.transaction',
          'capability.live-query',
          'queue.table',
          'assistant-memory.run-usage',
          'assistant-memory.mastra-schema',
          'workspace-index.system-role',
          'store.close',
        ];
  const checks = checkIds.map((id) => ({
    id,
    label: id,
    required: id !== 'assistant-memory.mastra-schema',
    status: id === 'assistant-memory.mastra-schema' ? 'skipped' : 'passed',
  }));

  return {
    blockingIssues: [],
    bootstrapReport: {
      checks,
      failure: null,
      phase: 'ready',
      profileId: 'default',
      ready: true,
      runtime: {
        engine,
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:01.000Z',
    },
    checks,
    generatedAt: '2026-06-22T00:00:01.000Z',
    reportVersion: 1,
  };
}

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function installParentPortMock(): {
  readonly listeners: readonly ((message: unknown) => void)[];
  readonly parentPort: ParentPortMock;
} {
  const listeners: ((message: unknown) => void)[] = [];
  const parentPort: ParentPortMock = {
    on: vi.fn((event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
      return parentPort;
    }),
    postMessage: vi.fn(),
  };

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });

  return { listeners, parentPort };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function createMockExecutionDb() {
  return {
    exec: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (callback) =>
      callback({
        exec: vi.fn(async () => undefined),
        query: vi.fn(async () => ({ rows: [] })),
      })
    ),
  };
}

describe('db-host-entry', () => {
  beforeEach(() => {
    vi.resetModules();
    dbMainMocks.closeDatabase.mockReset();
    dbMainMocks.getDatabase.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReturnValue({
      dataDir: '/mock/profile/pgdata',
      databaseProfile: 'default',
      hasDatabaseHandle: true,
    });
    dbMainMocks.initializeMainDatabase.mockReset();
    dbMainMocks.initializeMainDatabase.mockResolvedValue(undefined);
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockReset();
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport().bootstrapReport,
      capabilities: { liveQuery: true },
      initialized: true,
    });
    dbMainMocks.resetLocalDatabase.mockReset();
    dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs.mockClear();
    dbPackageMocks.insertTursoChunksAndEnqueueEmbeddingJobs.mockClear();
    dbPackageMocks.applyManagedCacheBatch.mockClear();
    dbPackageMocks.applyTursoManagedCacheBatch.mockClear();
    dbPackageMocks.invalidateManagedCacheEntriesByIdentity.mockClear();
    dbPackageMocks.invalidateTursoManagedCacheEntriesByIdentity.mockClear();
    dbPackageMocks.markTursoCollectionIndexingStatsDirty.mockClear();
    dbPackageMocks.refreshTursoCollectionIndexingStats.mockClear();
    dbPackageMocks.tursoFileChunkRepositoryClearEmbeddingsForSet.mockClear();
    dbPackageMocks.tursoJobQueueClear.mockClear();
    dbPackageMocks.tursoJobQueueClaimMany.mockClear();
    dbPackageMocks.tursoJobQueueCompleteBatch.mockClear();
    dbPackageMocks.tursoJobQueueCompleteEmbeddingChunkBatch.mockClear();
    dbPackageMocks.tursoJobQueueFail.mockClear();
    dbPackageMocks.tursoJobQueueFailBatch.mockClear();
    dbPackageMocks.tursoJobQueueHeartbeatBatch.mockClear();
    dbPackageMocks.tursoJobQueueRepairUnclaimableQueued.mockClear();
    dbPackageMocks.tursoJobQueueRequeueFailed.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('unwraps Electron utility process MessageEvent envelopes before handling requests', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    expect(listeners).toHaveLength(1);
    listeners[0]?.({
      data: {
        id: 'init-request',
        kind: 'request',
        request: { kind: 'init' },
      },
    });
    await flushMicrotasks();

    expect(dbMainMocks.initializeMainDatabaseWithBootstrapReport).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'init-request',
      kind: 'response',
      ok: true,
      result: {
        bootstrapReport: expect.objectContaining({
          phase: 'ready',
          profileId: 'default',
          ready: true,
          runtime: {
            engine: 'pglite',
            host: 'electron-utility',
            persistence: 'filesystem',
          },
        }),
        capabilities: { liveQuery: true },
        initialized: true,
      },
    });
    const initResponse = parentPort.postMessage.mock.calls.find(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        'id' in message &&
        message.id === 'init-request'
    )?.[0] as { result?: { bootstrapReport?: { checks?: readonly { id: string }[] } } };
    expect(initResponse.result?.bootstrapReport?.checks?.map((check) => check.id)).toEqual([
      'store.open',
      'schema.migrated',
      'extension.pgvector',
      'extension.pg_trgm',
      'search.fts-grep',
      'capability.transaction',
      'capability.live-query',
      'queue.table',
      'assistant-memory.run-usage',
      'assistant-memory.mastra-schema',
      'workspace-index.system-role',
      'store.close',
    ]);
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unknown' })
    );
  });

  it('returns a blocked bootstrap report without opening the long-lived DB handle', async () => {
    const blockedReport = createReadyBootstrapProbeReport();
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: {
        ...blockedReport.bootstrapReport,
        checks: blockedReport.bootstrapReport.checks.map((check) =>
          check.id === 'queue.table' ? { ...check, status: 'failed' } : check
        ),
        phase: 'blocked',
        ready: false,
      },
      capabilities: { liveQuery: true },
      initialized: false,
    });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'init-request',
        kind: 'request',
        request: { kind: 'init' },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'init-request',
      kind: 'response',
      ok: true,
      result: {
        bootstrapReport: expect.objectContaining({
          phase: 'blocked',
          ready: false,
        }),
        capabilities: { liveQuery: true },
        initialized: false,
      },
    });
  });

  it('blocks query requests when lazy bootstrap reports not ready', async () => {
    const blockedReport = createReadyBootstrapProbeReport().bootstrapReport;
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: {
        ...blockedReport,
        phase: 'blocked',
        ready: false,
      },
      capabilities: { liveQuery: true },
      initialized: false,
    });
    const query = vi.fn(async () => ({ rows: [] }));
    dbMainMocks.getDatabase.mockResolvedValue({ query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'query-request',
        kind: 'request',
        request: {
          kind: 'query',
          sql: 'SELECT 1',
        },
      },
    });
    await flushMicrotasks();

    expect(dbMainMocks.initializeMainDatabaseWithBootstrapReport).toHaveBeenCalledTimes(1);
    expect(dbMainMocks.getDatabase).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'DB host bootstrap blocked during blocked.',
        }),
        id: 'query-request',
        kind: 'response',
        ok: false,
      })
    );
  });

  it('emits source-tagged lifecycle logs from the utility process', async () => {
    const { parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      context: expect.objectContaining({
        logSource: 'db-host',
        pid: process.pid,
        runtime: 'db-host',
      }),
      kind: 'log',
      level: 'info',
      message: 'DB host process started',
    });
  });

  it('emits structured slow-request diagnostics while a query is still running', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise(() => undefined));
      dbMainMocks.getDatabase.mockResolvedValue({ query });
      const { listeners, parentPort } = installParentPortMock();
      await import('../../db-host-entry');

      listeners[0]?.({
        data: {
          id: 'slow-query-request',
          kind: 'request',
          request: {
            kind: 'query',
            sql: 'SELECT * FROM file_chunks WHERE embedding IS NULL',
            params: ['set-1'],
          },
        },
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5000);

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        context: expect.objectContaining({
          activeDurationMs: 5000,
          paramsCount: 1,
          pendingControlRequests: 0,
          pendingGeneralRequests: 0,
          pendingTransactionRequests: 0,
          requestId: 'slow-query-request',
          requestKind: 'query',
          sqlPreview: 'SELECT * FROM file_chunks WHERE embedding IS NULL',
        }),
        kind: 'log',
        level: 'warn',
        message: 'DB host request still running',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-array query params before calling PGlite', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    dbMainMocks.getDatabase.mockResolvedValue({ query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'query-request',
        kind: 'request',
        request: {
          kind: 'query',
          sql: 'SELECT $1',
          params: { value: 'not-array-params' },
        },
      },
    });
    await flushMicrotasks();

    expect(query).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'DB host query params must be an array when provided.',
        }),
        id: 'query-request',
        kind: 'response',
        ok: false,
      })
    );
  });

  it('escapes literal percents for live query params before calling PGlite', async () => {
    const liveQuery = vi.fn(async () => ({
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }));
    dbMainMocks.getDatabase.mockResolvedValue({
      live: { query: liveQuery },
      query: vi.fn(async () => ({ rows: [] })),
    });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'live-start-request',
        kind: 'request',
        request: {
          kind: 'live:start',
          payload: {
            query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
            params: ['needle'],
          },
        },
      },
    });
    await flushMicrotasks();

    expect(liveQuery).toHaveBeenCalledWith({
      query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
      params: ['needle'],
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'live-start-request',
        kind: 'response',
        ok: true,
      })
    );
  });

  it('keeps the active transaction fenced after a commit failure until rollback runs', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('commit failed'))
      .mockResolvedValueOnce(undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    dbMainMocks.getDatabase.mockResolvedValue({ exec, query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'tx-start',
        kind: 'request',
        request: { kind: 'transaction:start', transactionId: 'tx:client-owned' },
      },
    });
    await flushMicrotasks();
    const txStartResponse = parentPort.postMessage.mock.calls.find(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { id?: string }).id === 'tx-start'
    )?.[0] as { result?: { transactionId?: string } } | undefined;
    const transactionId = txStartResponse?.result?.transactionId;
    expect(transactionId).toBe('tx:client-owned');

    listeners[0]?.({
      data: {
        id: 'tx-commit',
        kind: 'request',
        request: { kind: 'transaction:commit', transactionId },
      },
    });
    listeners[0]?.({
      data: {
        id: 'plain-query',
        kind: 'request',
        request: { kind: 'query', sql: 'SELECT outside transaction' },
      },
    });
    await flushMicrotasks();

    expect(query).not.toHaveBeenCalled();

    listeners[0]?.({
      data: {
        id: 'tx-rollback',
        kind: 'request',
        request: { kind: 'transaction:rollback', transactionId },
      },
    });
    await vi.waitFor(() => {
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-rollback',
          kind: 'response',
          ok: true,
        })
      );
    });
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith('SELECT outside transaction');
    });
  });

  it('does not fence later requests when transaction begin fails', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('begin failed'));
    const query = vi.fn(async () => ({ rows: [{ ok: true }] }));
    dbMainMocks.getDatabase.mockResolvedValue({ exec, query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'tx-start',
        kind: 'request',
        request: { kind: 'transaction:start', transactionId: 'tx:client-owned' },
      },
    });
    listeners[0]?.({
      data: {
        id: 'plain-query',
        kind: 'request',
        request: { kind: 'query', sql: 'SELECT outside transaction' },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'begin failed',
        }),
        id: 'tx-start',
        ok: false,
      })
    );
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith('SELECT outside transaction');
    });
  });

  it('rejects mismatched transaction requests without blocking the active transaction', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    dbMainMocks.getDatabase.mockResolvedValue({ exec, query });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'tx-start',
        kind: 'request',
        request: { kind: 'transaction:start', transactionId: 'tx:client-owned' },
      },
    });
    await flushMicrotasks();
    const txStartResponse = parentPort.postMessage.mock.calls.find(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { id?: string }).id === 'tx-start'
    )?.[0] as { result?: { transactionId?: string } } | undefined;
    const transactionId = txStartResponse?.result?.transactionId;
    expect(transactionId).toBe('tx:client-owned');

    listeners[0]?.({
      data: {
        id: 'wrong-tx',
        kind: 'request',
        request: { kind: 'transaction:query', sql: 'SELECT wrong', transactionId: 'tx:wrong' },
      },
    });
    listeners[0]?.({
      data: {
        id: 'tx-commit',
        kind: 'request',
        request: { kind: 'transaction:commit', transactionId },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining('DB transaction mismatch'),
        }),
        id: 'wrong-tx',
        ok: false,
      })
    );
    await vi.waitFor(() => {
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tx-commit',
          ok: true,
        })
      );
    });
  });

  it('rejects unknown request kinds instead of returning a successful undefined result', async () => {
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'future-request',
        kind: 'request',
        request: { kind: 'future:protocol-kind' },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Unknown DB host request kind: future:protocol-kind',
        }),
        id: 'future-request',
        ok: false,
      })
    );
  });

  it('forwards parsed atomic chunk/job enqueue requests without reparsing the renderer envelope', async () => {
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');
    const now = new Date().toISOString();

    listeners[0]?.({
      data: {
        id: 'atomic-chunk-job',
        kind: 'request',
        request: {
          kind: 'chunks:insert-and-enqueue-embedding-jobs',
          payload: {
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
            dimensionParameter: null,
            fileRecordId: 'file-1',
            model: 'local::Xenova/all-MiniLM-L6-v2',
            provider: 'local',
            targetDimension: 384,
            targetEmbeddingSetId: 'workspace-index',
          },
        },
      },
    });
    await flushMicrotasks();

    expect(dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        fileRecordId: 'file-1',
        model: 'local::Xenova/all-MiniLM-L6-v2',
        targetDimension: 384,
      })
    );
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'atomic-chunk-job',
      kind: 'response',
      ok: true,
      result: { inserted: true },
    });
  });

  it('uses Turso managed-cache apply and invalidation functions for Turso runtime', async () => {
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport('turso').bootstrapReport,
      capabilities: { liveQuery: false },
      initialized: true,
    });
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'managed-cache-apply',
        kind: 'request',
        request: {
          kind: 'managed-cache:apply-batch',
          payload: { changes: [], embeddingSetId: 'set-1' },
        },
      },
    });
    listeners[0]?.({
      data: {
        id: 'managed-cache-invalidate',
        kind: 'request',
        request: {
          kind: 'managed-cache:invalidate-by-identity',
          payload: { embeddingSetId: 'set-1', targets: [] },
        },
      },
    });
    await flushMicrotasks();

    expect(dbPackageMocks.applyTursoManagedCacheBatch).toHaveBeenCalledWith(db, {
      changes: [],
      embeddingSetId: 'set-1',
    });
    expect(dbPackageMocks.applyManagedCacheBatch).not.toHaveBeenCalled();
    expect(dbPackageMocks.invalidateTursoManagedCacheEntriesByIdentity).toHaveBeenCalledWith(db, {
      embeddingSetId: 'set-1',
      targets: [],
    });
    expect(dbPackageMocks.invalidateManagedCacheEntriesByIdentity).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'managed-cache-apply',
      kind: 'response',
      ok: true,
      result: { applied: true },
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'managed-cache-invalidate',
      kind: 'response',
      ok: true,
      result: {
        canceledEmbeddingJobCount: 0,
        deletedChunkIds: [],
        deletedFileRecordIds: [],
      },
    });
  });

  it('uses Turso atomic chunk/job enqueue function for Turso runtime', async () => {
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport('turso').bootstrapReport,
      capabilities: { liveQuery: false },
      initialized: true,
    });
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners } = installParentPortMock();
    await import('../../db-host-entry');
    const now = new Date().toISOString();

    listeners[0]?.({
      data: {
        id: 'atomic-turso-chunk-job',
        kind: 'request',
        request: {
          kind: 'chunks:insert-and-enqueue-embedding-jobs',
          payload: {
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
            model: 'local::Xenova/all-MiniLM-L6-v2',
            targetDimension: 384,
          },
        },
      },
    });
    await flushMicrotasks();

    expect(dbPackageMocks.insertTursoChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        fileRecordId: 'file-1',
        model: 'local::Xenova/all-MiniLM-L6-v2',
        targetDimension: 384,
      })
    );
    expect(dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs).not.toHaveBeenCalled();
  });

  it('routes Turso queue/vector owner requests only after a Turso runtime report', async () => {
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport('turso').bootstrapReport,
      capabilities: { liveQuery: false },
      initialized: true,
    });
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'turso-queue',
        kind: 'request',
        request: {
          kind: 'turso:embedding-worker:queue',
          payload: {
            operation: 'claimMany',
            payload: {
              leaseMs: 60_000,
              limit: 1,
              now: '2026-06-30T10:01:00.000Z',
              queue: 'embeddings',
              workerId: 'worker-1',
            },
          },
        },
      },
    });
    listeners[0]?.({
      data: {
        id: 'turso-stats',
        kind: 'request',
        request: {
          kind: 'turso:embedding-worker:stats',
          payload: {
            embeddingSetIds: ['set-1'],
            operation: 'markDirty',
          },
        },
      },
    });
    listeners[0]?.({
      data: {
        id: 'turso-vector',
        kind: 'request',
        request: {
          kind: 'turso:vector-queue:action',
          payload: {
            operation: 'clearEmbeddingsForSet',
            payload: { embeddingSetId: 'set-1' },
          },
        },
      },
    });
    await flushMicrotasks();

    expect(dbPackageMocks.tursoJobQueueClaimMany).toHaveBeenCalledWith({
      leaseMs: 60_000,
      limit: 1,
      now: '2026-06-30T10:01:00.000Z',
      queue: 'embeddings',
      workerId: 'worker-1',
    });
    expect(dbPackageMocks.markTursoCollectionIndexingStatsDirty).toHaveBeenCalledWith(db, [
      'set-1',
    ]);
    expect(dbPackageMocks.tursoFileChunkRepositoryClearEmbeddingsForSet).toHaveBeenCalledWith(
      'set-1'
    );
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'turso-queue',
      kind: 'response',
      ok: true,
      result: [{ id: 'job-1', state: 'running' }],
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'turso-stats',
      kind: 'response',
      ok: true,
      result: undefined,
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'turso-vector',
      kind: 'response',
      ok: true,
      result: { cleared: 3 },
    });
  });

  it('routes remaining Turso queue/vector owner request variants through DB host repositories', async () => {
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport('turso').bootstrapReport,
      capabilities: { liveQuery: false },
      initialized: true,
    });
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    const queueRequests = [
      {
        id: 'complete-batch',
        payload: {
          operation: 'completeBatch',
          payload: [{ id: 'job-1', leaseToken: 'lease-1' }],
        },
      },
      {
        id: 'complete-embedding-chunk-batch',
        payload: {
          operation: 'completeEmbeddingChunkBatch',
          payload: [{ id: 'job-2', leaseToken: 'lease-2' }],
        },
      },
      {
        id: 'fail',
        payload: {
          operation: 'fail',
          payload: { error: 'boom', id: 'job-3', leaseToken: 'lease-3' },
        },
      },
      {
        id: 'fail-batch',
        payload: {
          operation: 'failBatch',
          payload: {
            error: 'boom',
            jobs: [{ id: 'job-4', leaseToken: 'lease-4' }],
          },
        },
      },
      {
        id: 'heartbeat-batch',
        payload: {
          operation: 'heartbeatBatch',
          payload: {
            extendMs: 30_000,
            jobs: [{ id: 'job-5', leaseToken: 'lease-5' }],
          },
        },
      },
    ];
    const vectorRequests = [
      {
        id: 'clear-queue',
        payload: {
          operation: 'clearQueue',
          payload: { states: ['failed'] },
        },
      },
      {
        id: 'retry-failed',
        payload: {
          operation: 'retryFailed',
          payload: { limit: 5 },
        },
      },
      {
        id: 'wipe-queue',
        payload: {
          operation: 'wipeQueue',
          payload: {},
        },
      },
    ];

    for (const request of queueRequests) {
      listeners[0]?.({
        data: {
          id: request.id,
          kind: 'request',
          request: {
            kind: 'turso:embedding-worker:queue',
            payload: request.payload,
          },
        },
      });
      await flushMicrotasks();
    }
    listeners[0]?.({
      data: {
        id: 'stats-refresh',
        kind: 'request',
        request: {
          kind: 'turso:embedding-worker:stats',
          payload: {
            embeddingSetIds: ['set-2'],
            operation: 'refresh',
          },
        },
      },
    });
    await flushMicrotasks();
    for (const request of vectorRequests) {
      listeners[0]?.({
        data: {
          id: request.id,
          kind: 'request',
          request: {
            kind: 'turso:vector-queue:action',
            payload: request.payload,
          },
        },
      });
      await flushMicrotasks();
    }

    expect(dbPackageMocks.tursoJobQueueCompleteBatch).toHaveBeenCalledWith([
      { id: 'job-1', leaseToken: 'lease-1' },
    ]);
    expect(dbPackageMocks.tursoJobQueueCompleteEmbeddingChunkBatch).toHaveBeenCalledWith([
      { id: 'job-2', leaseToken: 'lease-2' },
    ]);
    expect(dbPackageMocks.tursoJobQueueFail).toHaveBeenCalledWith({
      error: 'boom',
      id: 'job-3',
      leaseToken: 'lease-3',
    });
    expect(dbPackageMocks.tursoJobQueueFailBatch).toHaveBeenCalledWith({
      error: 'boom',
      jobs: [{ id: 'job-4', leaseToken: 'lease-4' }],
    });
    expect(dbPackageMocks.tursoJobQueueHeartbeatBatch).toHaveBeenCalledWith(
      [{ id: 'job-5', leaseToken: 'lease-5' }],
      30_000
    );
    expect(dbPackageMocks.refreshTursoCollectionIndexingStats).toHaveBeenCalledWith(
      expect.objectContaining({
        exec: expect.any(Function),
        query: expect.any(Function),
      }),
      ['set-2']
    );
    expect(dbPackageMocks.tursoJobQueueClear).toHaveBeenNthCalledWith(1, 'embeddings', ['failed']);
    expect(dbPackageMocks.tursoJobQueueRepairUnclaimableQueued).toHaveBeenCalledWith(
      'embeddings',
      5
    );
    expect(dbPackageMocks.tursoJobQueueRequeueFailed).toHaveBeenCalledWith('embeddings', 5);
    expect(dbPackageMocks.tursoJobQueueClear).toHaveBeenNthCalledWith(2, 'embeddings');
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'retry-failed',
      kind: 'response',
      ok: true,
      result: { repairedQueued: 5, requeuedFailed: 6 },
    });
  });

  it('rejects unsupported Turso owner operation messages at the DB host boundary', async () => {
    dbMainMocks.initializeMainDatabaseWithBootstrapReport.mockResolvedValue({
      bootstrapReport: createReadyBootstrapProbeReport('turso').bootstrapReport,
      capabilities: { liveQuery: false },
      initialized: true,
    });
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    for (const request of [
      {
        id: 'unsupported-queue',
        request: {
          kind: 'turso:embedding-worker:queue',
          payload: { operation: 'unknownQueueOperation', payload: {} },
        },
      },
      {
        id: 'unsupported-stats',
        request: {
          kind: 'turso:embedding-worker:stats',
          payload: { embeddingSetIds: ['set-1'], operation: 'unknownStatsOperation' },
        },
      },
      {
        id: 'unsupported-vector',
        request: {
          kind: 'turso:vector-queue:action',
          payload: { operation: 'unknownVectorOperation', payload: {} },
        },
      },
    ]) {
      listeners[0]?.({
        data: {
          id: request.id,
          kind: 'request',
          request: request.request,
        },
      });
    }
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Unsupported Turso embedding worker queue operation.',
        }),
        id: 'unsupported-queue',
        kind: 'response',
        ok: false,
      })
    );
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Unsupported Turso embedding worker stats operation.',
        }),
        id: 'unsupported-stats',
        kind: 'response',
        ok: false,
      })
    );
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Unsupported Turso vector queue action operation.',
        }),
        id: 'unsupported-vector',
        kind: 'response',
        ok: false,
      })
    );
  });

  it('rejects Turso queue/vector owner requests before mutation when the host runtime is PGlite', async () => {
    const db = createMockExecutionDb();
    dbMainMocks.getDatabase.mockResolvedValue(db);
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'pglite-turso-queue',
        kind: 'request',
        request: {
          kind: 'turso:embedding-worker:queue',
          payload: {
            operation: 'claimMany',
            payload: {
              leaseMs: 60_000,
              now: '2026-06-30T10:01:00.000Z',
              queue: 'embeddings',
              workerId: 'worker-1',
            },
          },
        },
      },
    });
    await flushMicrotasks();

    expect(dbPackageMocks.tursoJobQueueClaimMany).not.toHaveBeenCalled();
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pglite-turso-queue',
        kind: 'response',
        ok: false,
        error: expect.objectContaining({
          message: 'Turso DB-host owner request requires Turso runtime.',
        }),
      })
    );
  });
});
