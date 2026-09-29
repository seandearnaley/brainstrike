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
  resetLocalDatabase: vi.fn(),
}));

vi.mock('../../db-main', () => dbMainMocks);

const dbPackageMocks = vi.hoisted(() => ({
  insertChunksAndEnqueueEmbeddingJobs: vi.fn(async () => undefined),
}));

vi.mock('@brainstrike/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...original,
    insertChunksAndEnqueueEmbeddingJobs: dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs,
  };
});
vi.mock('@brainstrike/db/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/db/react')>();
  return {
    ...original,
    insertChunksAndEnqueueEmbeddingJobs: dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs,
  };
});

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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('db-host-entry', () => {
  beforeEach(() => {
    vi.resetModules();
    dbMainMocks.closeDatabase.mockReset();
    dbMainMocks.getDatabase.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReset();
    dbMainMocks.getDatabaseDiagnostics.mockReturnValue({ hasDatabaseHandle: true });
    dbMainMocks.initializeMainDatabase.mockReset();
    dbMainMocks.initializeMainDatabase.mockResolvedValue(undefined);
    dbMainMocks.resetLocalDatabase.mockReset();
    dbPackageMocks.insertChunksAndEnqueueEmbeddingJobs.mockClear();
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

    expect(dbMainMocks.initializeMainDatabase).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'init-request',
      kind: 'response',
      ok: true,
      result: { initialized: true },
    });
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unknown' })
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
            params: ['set-1'],
            sql: 'SELECT * FROM file_chunks WHERE embedding IS NULL',
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
          params: { value: 'not-array-params' },
          sql: 'SELECT $1',
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

  it('carries identifier-only Postgres diagnostics across the boundary and never row data or SQL', async () => {
    const corruption = Object.assign(
      new Error('index "idx_chunks" contains unexpected zero page'),
      {
        code: 'XX002',
        detail: 'Key (secret)=(user row data) is broken.',
        file: 'nbtpage.c',
        hint: 'REINDEX the index',
        internalQuery: 'SELECT secret FROM brainstrike_chunks',
        position: '42',
        routine: '_bt_checkpage',
        schema: 'public',
        table: 'brainstrike_chunks',
        where: 'SQL statement "SELECT secret FROM brainstrike_chunks"',
      }
    );
    dbMainMocks.getDatabase.mockResolvedValue({
      query: vi.fn(async () => Promise.reject(corruption)),
    });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: {
        id: 'corrupt-query-request',
        kind: 'request',
        request: { kind: 'query', params: [], sql: 'SELECT 1' },
      },
    });
    await vi.waitFor(() => {
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'corrupt-query-request', ok: false })
      );
    });

    const posted = parentPort.postMessage.mock.calls.map(
      ([message]) => message as Record<string, unknown>
    );
    const response = posted.find((message) => message['id'] === 'corrupt-query-request');
    const wireError = response?.['error'] as Record<string, unknown>;
    expect(wireError).toMatchObject({
      code: 'XX002',
      file: 'nbtpage.c',
      message: 'index "idx_chunks" contains unexpected zero page',
      routine: '_bt_checkpage',
      schema: 'public',
      table: 'brainstrike_chunks',
    });
    for (const forbidden of ['detail', 'where', 'hint', 'internalQuery', 'position']) {
      expect(wireError).not.toHaveProperty(forbidden);
    }

    const failureLog = posted.find(
      (message) => message['kind'] === 'log' && message['message'] === 'DB host request failed'
    );
    expect(failureLog).toBeDefined();
    expect((failureLog?.['context'] as { error?: unknown } | undefined)?.error).toEqual({
      code: 'XX002',
      file: 'nbtpage.c',
      message: 'index "idx_chunks" contains unexpected zero page',
      name: 'Error',
      routine: '_bt_checkpage',
      schema: 'public',
      table: 'brainstrike_chunks',
    });
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
            params: ['needle'],
            query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
          },
        },
      },
    });
    await flushMicrotasks();

    expect(liveQuery).toHaveBeenCalledWith({
      params: ['needle'],
      query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'live-start-request',
        kind: 'response',
        ok: true,
      })
    );
  });

  it('reports the host live-query count before and after terminal teardown', async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const liveQuery = vi.fn(async () => ({
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe,
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
        request: { kind: 'live:start', payload: { params: [], query: 'SELECT 1' } },
      },
    });
    await flushMicrotasks();

    const startResponse = parentPort.postMessage.mock.calls.find(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { id?: string }).id === 'live-start-request'
    )?.[0] as { result?: { liveId?: string } } | undefined;
    const liveId = startResponse?.result?.liveId;
    expect(liveId).toEqual(expect.any(String));

    listeners[0]?.({
      data: {
        id: 'active-diagnostics-request',
        kind: 'request',
        request: { kind: 'diagnostics' },
      },
    });
    await flushMicrotasks();
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'active-diagnostics-request',
      kind: 'response',
      ok: true,
      result: { activeLiveQueryCount: 1, hasDatabaseHandle: true },
    });

    listeners[0]?.({
      data: {
        id: 'live-stop-request',
        kind: 'request',
        request: { kind: 'live:stop', liveId },
      },
    });
    await flushMicrotasks();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    listeners[0]?.({
      data: {
        id: 'released-diagnostics-request',
        kind: 'request',
        request: { kind: 'diagnostics' },
      },
    });
    await flushMicrotasks();
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      id: 'released-diagnostics-request',
      kind: 'response',
      ok: true,
      result: { activeLiveQueryCount: 0, hasDatabaseHandle: true },
    });
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

  it.each(['close', 'reset'] as const)(
    'BST-1330: %s AWAITS every live-query unsubscribe before touching the database',
    async (kind) => {
      // The serial envelope queue joins protocol statements against close, but
      // the live extension's internal refreshes have no queue entry — a handle
      // still subscribed when the backend deactivates is the BST-1320 wedge.
      // The unsubscribe mock is gated on a deferred so this pins the AWAIT: a
      // fire-and-forget unsubscribe would call the database while the deferred
      // is still pending, failing the not-called assertion below.
      let releaseUnsubscribe: (() => void) | undefined;
      const unsubscribed = new Promise<void>((resolve) => {
        releaseUnsubscribe = resolve;
      });
      const unsubscribe = vi.fn(() => unsubscribed);
      const liveQuery = vi.fn(async () => ({
        initialResults: { rows: [] },
        refresh: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe,
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
            payload: { params: [], query: 'SELECT 1' },
          },
        },
      });
      await flushMicrotasks();
      expect(liveQuery).toHaveBeenCalledTimes(1);

      listeners[0]?.({
        data: { id: `${kind}-request`, kind: 'request', request: { kind } },
      });
      await flushMicrotasks();
      await flushMicrotasks();

      const databaseCall =
        kind === 'close' ? dbMainMocks.closeDatabase : dbMainMocks.resetLocalDatabase;
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      // The drain is still pending — the database must not have been touched.
      expect(databaseCall).not.toHaveBeenCalled();

      releaseUnsubscribe?.();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(databaseCall).toHaveBeenCalledTimes(1);
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: `${kind}-request`, kind: 'response', ok: true })
      );
    }
  );

  it('answers a close that fails with the error, never as closed, so main SIGKILLs the host', async () => {
    dbMainMocks.closeDatabase.mockRejectedValueOnce(new Error('Database close failed: boom'));
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: { id: 'close-request', kind: 'request', request: { kind: 'close' } },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Database close failed: boom' }),
        id: 'close-request',
        kind: 'response',
        ok: false,
      })
    );
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'close-request', ok: true })
    );
  });

  it('BST-1330: close with no live queries still responds ok (the common drained-shutdown path)', async () => {
    dbMainMocks.getDatabase.mockResolvedValue({
      query: vi.fn(async () => ({ rows: [] })),
    });
    const { listeners, parentPort } = installParentPortMock();
    await import('../../db-host-entry');

    listeners[0]?.({
      data: { id: 'close-request', kind: 'request', request: { kind: 'close' } },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'close-request', kind: 'response', ok: true })
    );
  });

  it('BST-1330: a failed unsubscribe is WARNED about, and close still proceeds', async () => {
    const unsubscribe = vi.fn(async () => {
      throw new Error('current transaction is aborted, commands ignored');
    });
    const liveQuery = vi.fn(async () => ({
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe,
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
        request: { kind: 'live:start', payload: { params: [], query: 'SELECT 1' } },
      },
    });
    await flushMicrotasks();

    listeners[0]?.({
      data: { id: 'close-request', kind: 'request', request: { kind: 'close' } },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    // The drain failure must be loud (NO SILENT FALLBACKS)...
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'log',
        level: 'warn',
        message: 'Live query unsubscribe failed during close/reset drain',
      })
    );
    // ...and close must still complete rather than leaving the database open.
    expect(dbMainMocks.closeDatabase).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'close-request', kind: 'response', ok: true })
    );
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
    const db = { query: vi.fn(async () => ({ rows: [] })) };
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
});
