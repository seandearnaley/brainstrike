import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { getResetTables } from '@brainstrike/db';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  applyManagedCacheBatchMock,
  browserWindowMock,
  createAuthorizedDbEvent,
  createCorruptionError,
  createFakeLiveQueryOwner,
  createLiveHandleMock,
  createWindowWithWebContents,
  currentIntegrityState,
  embeddingHostIsHostWindowMock,
  getDatabaseDiagnosticsMock,
  getDatabaseMock,
  getDbHostManagerMock,
  handlers,
  invalidateManagedCacheEntriesByIdentityMock,
  loggerDebug,
  loggerWarn,
  mockDb,
  resetDatabaseIpcHandlerMocks,
  resetLocalDatabaseMock,
} from './ipc-handlers-db-test-fixture';

function setBrowserWindows(...senders: unknown[]): void {
  const windows = senders.map((sender) =>
    createWindowWithWebContents(
      sender as unknown as Parameters<typeof createWindowWithWebContents>[0]
    )
  );
  browserWindowMock.getAllWindows.mockReturnValue(
    windows as unknown as ReturnType<typeof browserWindowMock.getAllWindows>
  );
}

/** The three owner-teardown shapes the live-query reaper must cover. */
const LIVE_QUERY_TEARDOWN_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const;

async function flushAsyncOwnerCleanup(): Promise<void> {
  // The reap schedules owner cleanup (Promise.allSettled over unsubscribes);
  // drain a few microtask turns so its effects are observable.
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

describe('database IPC handlers', () => {
  beforeEach(async () => {
    await resetDatabaseIpcHandlerMocks();
  });

  it('waits for scheduled desktop database work to drain before shutdown', async () => {
    const { runDesktopScheduledDatabaseWork, waitForDesktopDatabaseWorkSchedulerIdle } =
      await import('../../platform/desktop-database-work');

    let releaseWork: (() => void) | null = null;
    const workStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'shutdown-drain-test', priority: 'normal' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseWork = release;
          });
        }
      );
    });

    await workStarted;

    let idleResolved = false;
    const idlePromise = waitForDesktopDatabaseWorkSchedulerIdle(1000).then(() => {
      idleResolved = true;
    });
    await Promise.resolve();

    expect(idleResolved).toBe(false);
    if (!releaseWork) {
      throw new Error('Scheduled database work did not expose a release callback.');
    }
    const release: unknown = releaseWork;
    if (typeof release !== 'function') {
      throw new Error('Expected scheduled database work release callback.');
    }
    release();
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  it('keeps database work submitted during reset out of the scheduler until reset completes', async () => {
    const {
      getDesktopDatabaseWorkSchedulerSnapshot,
      runDesktopScheduledDatabaseWork,
      runWithDesktopDatabaseResetBarrier,
      waitForDesktopDatabaseWorkSchedulerIdle,
    } = await import('../../platform/desktop-database-work');

    let releaseReset: (() => void) | null = null;
    let resetBarrierPromise: Promise<void> | null = null;
    const resetStarted = new Promise<void>((resolve) => {
      resetBarrierPromise = runWithDesktopDatabaseResetBarrier(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseReset = release;
        });
      });
    });
    await resetStarted;

    let workStarted = false;
    const pendingWork = runDesktopScheduledDatabaseWork(
      { label: 'reset-submitted-live-query', priority: 'foreground' },
      async () => {
        workStarted = true;
        return 'ran-after-reset';
      }
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(workStarted).toBe(false);
    expect(getDesktopDatabaseWorkSchedulerSnapshot()).toMatchObject({
      queued: { background: 0, foreground: 0, normal: 0 },
      runningPriority: null,
    });
    await waitForDesktopDatabaseWorkSchedulerIdle(1000);

    if (!releaseReset) {
      throw new Error('Reset barrier did not expose a release callback.');
    }
    const finishReset: unknown = releaseReset;
    if (typeof finishReset !== 'function') {
      throw new Error('Expected reset barrier release callback.');
    }
    finishReset();
    await resetBarrierPromise;
    await expect(pendingWork).resolves.toBe('ran-after-reset');
    expect(workStarted).toBe(true);
  });

  it('db:query calls query and returns result', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.(createAuthorizedDbEvent(), 'SELECT 1', [1]);

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1', [1]);
    expect(result).toBe(rows);
  });

  it('db:query accepts database work options as the second argument when params are omitted', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.(createAuthorizedDbEvent(), 'SELECT 1', {
      label: 'collection page',
      priority: 'foreground',
    });

    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    expect(result).toBe(rows);
  });

  it('db:query rejects empty object params instead of treating them as work options', async () => {
    const handler = handlers.get('db:query');

    await expect(handler?.(createAuthorizedDbEvent(), 'SELECT $1', {})).rejects.toThrow(
      'db:query parameters must be an array when provided.'
    );

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects object params before they reach PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(
      handler?.(createAuthorizedDbEvent(), 'SELECT $1', { value: 'not-array-params' })
    ).rejects.toThrow('db:query parameters must be an array when provided.');

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects destructive renderer schema SQL before it reaches PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(handler?.(createAuthorizedDbEvent(), 'DROP TABLE file_records')).rejects.toThrow(
      'db:query does not permit destructive schema SQL from the renderer.'
    );

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects broad destructive DROP statements before they reach PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(
      handler?.(createAuthorizedDbEvent(), 'DROP SEQUENCE file_record_seq')
    ).rejects.toThrow('db:query does not permit destructive schema SQL from the renderer.');

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query permits renderer-owned DML and delegates to PGlite', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.(
      createAuthorizedDbEvent(),
      'DELETE FROM job_queue WHERE id = $1',
      ['job-1']
    );

    expect(mockDb.query).toHaveBeenCalledWith('DELETE FROM job_queue WHERE id = $1', ['job-1']);
    expect(result).toBe(rows);
  });

  it('db:exec permits non-destructive ALTER TABLE literals and delegates to PGlite', async () => {
    const handler = handlers.get('db:exec');

    const result = await handler?.(
      createTrustedInvokeEvent(),
      "ALTER TABLE file_records ADD COLUMN label TEXT DEFAULT 'drop'"
    );

    expect(mockDb.exec).toHaveBeenCalledWith(
      "ALTER TABLE file_records ADD COLUMN label TEXT DEFAULT 'drop'"
    );
    expect(result).toBeUndefined();
  });

  it('db:exec rejects destructive renderer schema SQL before it reaches PGlite', async () => {
    const handler = handlers.get('db:exec');

    await expect(handler?.(createTrustedInvokeEvent(), 'DROP TABLE file_records')).rejects.toThrow(
      'db:exec does not permit destructive schema SQL from the renderer.'
    );

    expect(mockDb.exec).not.toHaveBeenCalled();
  });

  it('db:query throws on error', async () => {
    const handler = handlers.get('db:query');
    const err = new Error('fail');
    mockDb.query.mockRejectedValue(err);

    await expect(handler?.(createAuthorizedDbEvent(), 'SELECT bad')).rejects.toThrow(err);
  });

  it('schedules foreground db:query before queued background work during the quiet window', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import(
        '../../platform/desktop-database-work'
      );
      let now = 1000;
      resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 50, now: () => now });
      const handler = handlers.get('db:query');
      const order: string[] = [];
      mockDb.query.mockImplementation(async (sql: string) => {
        order.push(sql);
        return { rows: [] };
      });

      await handler?.(createAuthorizedDbEvent(), 'SELECT warmup', []);
      order.length = 0;

      const background = handler?.(createAuthorizedDbEvent(), 'SELECT background', [], {
        label: 'background claim',
        priority: 'background',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      const foreground = handler?.(createAuthorizedDbEvent(), 'SELECT foreground', [], {
        label: 'collection page',
      });
      await foreground;
      expect(order).toEqual(['SELECT foreground']);

      now += 50;
      await vi.advanceTimersByTimeAsync(50);
      await background;

      expect(order).toEqual(['SELECT foreground', 'SELECT background']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults db:query calls from the embedding host to background priority', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import(
        '../../platform/desktop-database-work'
      );
      let now = 1000;
      resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 50, now: () => now });
      const handler = handlers.get('db:query');
      const order: string[] = [];
      mockDb.query.mockImplementation(async (sql: string) => {
        order.push(sql);
        return { rows: [] };
      });
      const hiddenSender = {
        getOwnerBrowserWindow: vi.fn(() => createWindowWithWebContents({ send: vi.fn() })),
      };

      await handler?.(createAuthorizedDbEvent(), 'SELECT warmup', []);
      order.length = 0;
      embeddingHostIsHostWindowMock.mockReturnValueOnce(true);

      const background = handler?.(createAuthorizedDbEvent(hiddenSender), 'SELECT hidden_host', []);
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      const foreground = handler?.(createAuthorizedDbEvent(), 'SELECT visible_renderer', []);
      await foreground;
      expect(order).toEqual(['SELECT visible_renderer']);

      now += 50;
      await vi.advanceTimersByTimeAsync(50);
      await background;

      expect(order).toEqual(['SELECT visible_renderer', 'SELECT hidden_host']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('db:exec calls exec and returns result', async () => {
    const handler = handlers.get('db:exec');
    const ret = { done: true };
    mockDb.exec.mockResolvedValue(ret);

    const result = await handler?.(createTrustedInvokeEvent(), 'CREATE TABLE');

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.exec).toHaveBeenCalledWith('CREATE TABLE');
    expect(result).toBe(ret);
  });

  it('db:exec throws on error', async () => {
    const handler = handlers.get('db:exec');
    const err = new Error('exec fail');
    mockDb.exec.mockRejectedValue(err);

    await expect(handler?.(createTrustedInvokeEvent(), 'SELECT bad')).rejects.toThrow(err);
  });

  it('db:managed-cache:apply-batch validates payload and delegates to the DB host', async () => {
    const handler = handlers.get('db:managed-cache:apply-batch');
    const payload = {
      changes: [
        {
          mode: 'replace',
          record: {
            content: 'export const value = 2;',
            contentHash: 'hash-2',
            id: 'file-1',
            name: 'index.ts',
            path: 'src/index.ts',
            processedAt: '2026-04-15T00:00:00.000Z',
            size: 10,
            sourceRootPath: '/workspace/root',
            tokenCount: 5,
            updatedAt: '2026-04-15T00:00:00.000Z',
          },
        },
      ],
      embeddingSetId: 'set-1',
    };

    await handler?.(createTrustedInvokeEvent(), payload);

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).toHaveBeenCalled();
    expect(applyManagedCacheBatchMock).toHaveBeenCalledWith(payload);
  });

  it('schedules db:managed-cache:apply-batch as background when requested', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import(
        '../../platform/desktop-database-work'
      );
      let now = 1000;
      resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 50, now: () => now });
      const batchHandler = handlers.get('db:managed-cache:apply-batch');
      const queryHandler = handlers.get('db:query');
      const order: string[] = [];
      applyManagedCacheBatchMock.mockImplementation(async () => {
        order.push('batch');
      });
      mockDb.query.mockImplementation(async () => {
        order.push('query');
        return { rows: [] };
      });
      const payload = { changes: [], embeddingSetId: 'set-1' };

      await queryHandler?.(createAuthorizedDbEvent(), 'SELECT warmup', []);
      order.length = 0;

      const background = batchHandler?.(createTrustedInvokeEvent(), payload, {
        label: 'managed cache batch',
        priority: 'background',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      await queryHandler?.(createAuthorizedDbEvent(), 'SELECT foreground_query', []);
      expect(order).toEqual(['query']);

      now += 50;
      await vi.advanceTimersByTimeAsync(50);
      await background;

      expect(order).toEqual(['query', 'batch']);
      expect(applyManagedCacheBatchMock).toHaveBeenCalledWith(payload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('db:managed-cache:apply-batch rejects invalid payloads before touching the database', async () => {
    const handler = handlers.get('db:managed-cache:apply-batch');

    await expect(
      handler?.(createTrustedInvokeEvent(), {
        changes: 'invalid',
        embeddingSetId: '',
      })
    ).rejects.toThrow();

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).not.toHaveBeenCalled();
    expect(applyManagedCacheBatchMock).not.toHaveBeenCalled();
    expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
  });

  it('db:managed-cache:apply-batch accepts empty change arrays as a no-op payload', async () => {
    const handler = handlers.get('db:managed-cache:apply-batch');
    const payload = {
      changes: [],
      embeddingSetId: 'set-1',
    };

    await handler?.(createTrustedInvokeEvent(), payload);

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).toHaveBeenCalled();
    expect(applyManagedCacheBatchMock).toHaveBeenCalledWith(payload);
  });

  it('db:managed-cache:invalidate-by-identity validates payload and delegates to the DB host', async () => {
    const handler = handlers.get('db:managed-cache:invalidate-by-identity');
    const payload = {
      embeddingSetId: 'set-1',
      targets: [
        {
          mode: 'exact',
          relativePath: 'src/index.ts',
          rootId: 'root-1',
        },
        {
          mode: 'prefix',
          relativePathPrefix: 'src/generated',
          rootId: 'root-2',
        },
      ],
    };

    await handler?.(createTrustedInvokeEvent(), payload);

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).toHaveBeenCalled();
    expect(invalidateManagedCacheEntriesByIdentityMock).toHaveBeenCalledWith(payload);
  });

  it('schedules db:managed-cache:invalidate-by-identity as background when requested', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import(
        '../../platform/desktop-database-work'
      );
      let now = 1000;
      resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 50, now: () => now });
      const invalidationHandler = handlers.get('db:managed-cache:invalidate-by-identity');
      const queryHandler = handlers.get('db:query');
      const order: string[] = [];
      invalidateManagedCacheEntriesByIdentityMock.mockImplementation(async () => {
        order.push('invalidation');
        return {
          canceledEmbeddingJobCount: 0,
          deletedChunkIds: [],
          deletedFileRecordIds: [],
        };
      });
      mockDb.query.mockImplementation(async () => {
        order.push('query');
        return { rows: [] };
      });
      const payload = { embeddingSetId: 'set-1', targets: [] };

      await queryHandler?.(createAuthorizedDbEvent(), 'SELECT warmup', []);
      order.length = 0;

      const background = invalidationHandler?.(createTrustedInvokeEvent(), payload, {
        label: 'managed cache invalidation',
        priority: 'background',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      await queryHandler?.(createAuthorizedDbEvent(), 'SELECT foreground_query', []);
      expect(order).toEqual(['query']);

      now += 50;
      await vi.advanceTimersByTimeAsync(50);
      await background;

      expect(order).toEqual(['query', 'invalidation']);
      expect(invalidateManagedCacheEntriesByIdentityMock).toHaveBeenCalledWith(payload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('db:managed-cache:invalidate-by-identity rejects invalid payloads before touching the database', async () => {
    const handler = handlers.get('db:managed-cache:invalidate-by-identity');

    await expect(
      handler?.(createTrustedInvokeEvent(), {
        embeddingSetId: '',
        targets: 'invalid',
      })
    ).rejects.toThrow();

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).not.toHaveBeenCalled();
    expect(invalidateManagedCacheEntriesByIdentityMock).not.toHaveBeenCalled();
    expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
  });

  it('db:live-query:start subscribes and forwards updates', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    let listener: ((results: unknown) => void) | null = null;
    const liveHandle = {
      initialResults: { rows: [{ id: 1 }] },
      refresh: vi.fn(),
      subscribe: vi.fn((cb: (results: unknown) => void) => {
        listener = cb;
      }),
      unsubscribe: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 22,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    };

    const result = (await handler(createAuthorizedDbEvent(sender), {
      params: [1],
      query: 'select 1',
    })) as {
      id: number;
      initialResults: unknown;
    };

    expect(mockDb.live.query).toHaveBeenCalledWith({
      limit: undefined,
      offset: undefined,
      params: [1],
      query: 'select 1',
    });
    expect(result.initialResults).toEqual({ rows: [{ id: 1 }] });

    const subscribedListener: unknown = listener;
    if (typeof subscribedListener !== 'function') {
      throw new Error('expected live-query listener');
    }
    subscribedListener({ rows: [{ id: 2 }] });
    // Live query updates are dedup+batched; flush to deliver pending sends.
    const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
    setBrowserWindows(sender);
    flushPendingLiveUpdates();
    expect(sender.send).toHaveBeenCalledWith('db:live-query:update', {
      id: result.id,
      results: { rows: [{ id: 2 }] },
    });

    const stopHandler = handlers.get('db:live-query:stop');
    await stopHandler?.(createAuthorizedDbEvent(), result.id);
    expect(liveHandle.unsubscribe).toHaveBeenCalled();
  });

  it('db:live-query:start escapes literal percents when params are present', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    await handler(
      createAuthorizedDbEvent({
        id: 23,
        isDestroyed: () => false,
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      }),
      {
        params: ['needle'],
        query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
      }
    );

    expect(mockDb.live.query).toHaveBeenCalledWith({
      limit: undefined,
      offset: undefined,
      params: ['needle'],
      query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
    });
  });

  it('db:live-query:start attaches one owner reaper per webContents covering all three teardown events', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    mockDb.live.query
      .mockResolvedValueOnce(createLiveHandleMock())
      .mockResolvedValueOnce(createLiveHandleMock());
    const owner = createFakeLiveQueryOwner(101);

    await handler(createAuthorizedDbEvent(owner), { query: 'select 1' });
    await handler(createAuthorizedDbEvent(owner), { query: 'select 2' });

    for (const teardownEvent of LIVE_QUERY_TEARDOWN_EVENTS) {
      expect(owner.listenerCount(teardownEvent)).toBe(1);
    }
  });

  // Reload (Cmd+R / crash-recovery reload) preserves the WebContents, so a
  // 'destroyed'-only hook leaks every old-page subscription: each orphan
  // update keeps being computed by PGlite, serialized over IPC, and dropped by
  // the new page's id filter — unbounded growth until window close. The reaper
  // must cover all three teardown shapes, and because 'did-navigate' and
  // 'render-process-gone' leave the WebContents ALIVE, a fired reap must
  // remove its sibling listeners so re-registration cannot pile them up.
  it.each(LIVE_QUERY_TEARDOWN_EVENTS)(
    "db:live-query:start reaps every owner subscription on '%s'",
    async (teardownEvent) => {
      const startHandler = handlers.get('db:live-query:start');
      const refreshHandler = handlers.get('db:live-query:refresh');
      if (!(startHandler && refreshHandler)) {
        throw new Error('handler not registered');
      }

      const firstHandle = createLiveHandleMock();
      const secondHandle = createLiveHandleMock();
      mockDb.live.query.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);
      const owner = createFakeLiveQueryOwner(110);

      const first = (await startHandler(createAuthorizedDbEvent(owner), {
        query: 'select 1',
      })) as { id: number };
      const second = (await startHandler(createAuthorizedDbEvent(owner), {
        query: 'select 2',
      })) as { id: number };

      owner.emit(teardownEvent);
      await flushAsyncOwnerCleanup();

      expect(firstHandle.unsubscribe).toHaveBeenCalledTimes(1);
      expect(secondHandle.unsubscribe).toHaveBeenCalledTimes(1);
      await expect(refreshHandler(createAuthorizedDbEvent(), { id: first.id })).resolves.toEqual({
        message: 'Subscription not found',
        success: false,
      });
      await expect(refreshHandler(createAuthorizedDbEvent(), { id: second.id })).resolves.toEqual({
        message: 'Subscription not found',
        success: false,
      });
      // A fired reap must remove ALL teardown listeners, not only its own.
      for (const remaining of LIVE_QUERY_TEARDOWN_EVENTS) {
        expect(owner.listenerCount(remaining)).toBe(0);
      }
    }
  );

  it('db:live-query:start re-attaches the owner reaper after a did-navigate reap', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    mockDb.live.query
      .mockResolvedValueOnce(createLiveHandleMock())
      .mockResolvedValueOnce(createLiveHandleMock());
    const owner = createFakeLiveQueryOwner(111);

    await handler(createAuthorizedDbEvent(owner), { query: 'select 1' });
    owner.emit('did-navigate');
    await flushAsyncOwnerCleanup();

    await handler(createAuthorizedDbEvent(owner), { query: 'select 2' });

    for (const teardownEvent of LIVE_QUERY_TEARDOWN_EVENTS) {
      expect(owner.listenerCount(teardownEvent)).toBe(1);
    }
  });

  // The mid-setup race: a reload landing while createLiveQueryHandle is being
  // awaited would otherwise register a fresh subscription already owned by the
  // dead page — a permanent orphan the reap (which already ran) cannot see.
  it('db:live-query:start discards a handle created for a renderer context reaped mid-setup', async () => {
    const startHandler = handlers.get('db:live-query:start');
    if (!startHandler) {
      throw new Error('handler not registered');
    }

    let resolveHandle: ((handle: unknown) => void) | null = null;
    mockDb.live.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHandle = resolve;
        })
    );
    const owner = createFakeLiveQueryOwner(112);

    const pendingStart = startHandler(createAuthorizedDbEvent(owner), { query: 'select 1' });
    await vi.waitFor(() => {
      expect(mockDb.live.query).toHaveBeenCalledTimes(1);
    });
    const releaseHandle: unknown = resolveHandle;
    if (typeof releaseHandle !== 'function') {
      throw new Error('expected pending live-query handle creation');
    }

    // Reload lands while the handle creation is still in flight.
    owner.emit('did-navigate');
    const racedHandle = createLiveHandleMock();
    releaseHandle(racedHandle);

    await expect(pendingStart).rejects.toThrow(
      'db:live-query:start: the requesting renderer context changed during setup.'
    );
    expect(racedHandle.unsubscribe).toHaveBeenCalledTimes(1);
    expect(racedHandle.subscribe).not.toHaveBeenCalled();
  });

  // The raced-handle teardown is the one unsubscribe in this file that does
  // not go through cleanupLiveSubscription's error tolerance. A rejection
  // there must neither replace the context-changed error nor — via
  // runWithIntegrityContainment — let a benign reload race contain the database.
  // It must still be VISIBLE (logged), never swallowed silently.
  it('db:live-query:start surfaces the context-changed error even when the raced handle teardown rejects', async () => {
    const startHandler = handlers.get('db:live-query:start');
    if (!startHandler) {
      throw new Error('handler not registered');
    }

    let resolveHandle: ((handle: unknown) => void) | null = null;
    mockDb.live.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHandle = resolve;
        })
    );
    const owner = createFakeLiveQueryOwner(113);

    const pendingStart = startHandler(createAuthorizedDbEvent(owner), { query: 'select 1' });
    await vi.waitFor(() => {
      expect(mockDb.live.query).toHaveBeenCalledTimes(1);
    });
    const releaseHandle: unknown = resolveHandle;
    if (typeof releaseHandle !== 'function') {
      throw new Error('expected pending live-query handle creation');
    }

    owner.emit('did-navigate');
    const racedHandle = createLiveHandleMock();
    // Even a corruption-shaped teardown failure must not contain the database.
    const teardownFailure = createCorruptionError('invalid page in block 7');
    racedHandle.unsubscribe.mockRejectedValueOnce(teardownFailure);
    releaseHandle(racedHandle);

    await expect(pendingStart).rejects.toThrow(
      'db:live-query:start: the requesting renderer context changed during setup.'
    );
    expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
    expect(loggerWarn).toHaveBeenCalledWith(
      'Failed to tear down a live-query handle reaped mid-setup',
      {
        error: teardownFailure,
      }
    );
  });

  // Mirrors fs-watch's pre-attach guard: a start processed after the sender is
  // already destroyed would attach a reaper to an emitter whose teardown
  // events have already fired — no reap would ever arrive, permanently
  // registering the subscription and retaining the dead WebContents through
  // the update-listener closure.
  it('db:live-query:start rejects a sender that is already destroyed before touching the database', async () => {
    const startHandler = handlers.get('db:live-query:start');
    if (!startHandler) {
      throw new Error('handler not registered');
    }

    const owner = createFakeLiveQueryOwner(114);
    owner.isDestroyed.mockReturnValue(true);

    await expect(
      startHandler(createAuthorizedDbEvent(owner), { query: 'select 1' })
    ).rejects.toThrow('db:live-query:start: the requesting renderer is already destroyed.');
    expect(mockDb.live.query).not.toHaveBeenCalled();
    for (const teardownEvent of LIVE_QUERY_TEARDOWN_EVENTS) {
      expect(owner.listenerCount(teardownEvent)).toBe(0);
    }
  });

  it('db:live-query:start supports incremental mode with key', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    mockDb.live.incrementalQuery.mockResolvedValue(liveHandle);

    await handler(
      createAuthorizedDbEvent({
        id: 1,
        isDestroyed: () => false,
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      }),
      { key: 'id', limit: 5, mode: 'incremental', offset: 2, query: 'select *' }
    );

    expect(mockDb.live.incrementalQuery).toHaveBeenCalledWith({
      key: 'id',
      limit: 5,
      offset: 2,
      params: null,
      query: 'select *',
    });
  });

  it('db:live-query:start throws when incremental key is missing', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler(
        createAuthorizedDbEvent({
          id: 1,
          isDestroyed: () => false,
          on: vi.fn(),
          removeListener: vi.fn(),
          send: vi.fn(),
        }),
        { mode: 'incremental', query: 'select *' }
      )
    ).rejects.toThrow('Live incremental queries require a key column');
  });

  it('db:live-query:refresh returns not found when subscription missing', async () => {
    const handler = handlers.get('db:live-query:refresh');

    const result = await handler?.(createAuthorizedDbEvent(), { id: 999 });

    expect(result).toEqual({ message: 'Subscription not found', success: false });
  });

  it('db:live-query:refresh returns error message for non-corruption errors', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      refresh: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 55,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    };

    const result = (await startHandler(createAuthorizedDbEvent(sender), { query: 'select 1' })) as {
      id: number;
    };

    liveHandle.refresh.mockRejectedValue(new Error('refresh failed'));

    const refreshResult = await refreshHandler(createAuthorizedDbEvent(), {
      id: result.id,
      offset: 1,
    });

    expect(refreshResult).toEqual({
      message: 'refresh failed',
      success: false,
    });
    expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
  });

  it('retained db:resetLocal delegates to its database owner and reports failure', async () => {
    const handler = handlers.get('db:resetLocal');
    if (!handler) {
      throw new Error('handler not registered');
    }
    await expect(handler(createAuthorizedDbEvent())).resolves.toEqual({ success: true });
    expect(resetLocalDatabaseMock).toHaveBeenCalledOnce();
    resetLocalDatabaseMock.mockRejectedValueOnce(new Error('fail reset'));
    await expect(handler(createAuthorizedDbEvent())).resolves.toEqual({
      message: 'fail reset',
      success: false,
    });
  });

  it('db:getUserDataPath returns expected paths', async () => {
    const handler = handlers.get('db:getUserDataPath');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const originalEnv = process.env['NODE_ENV'];

    process.env['NODE_ENV'] = 'test';
    const testPath = await handler(createAuthorizedDbEvent());
    expect(String(testPath)).toContain('pgdata');

    process.env['NODE_ENV'] = 'production';
    const prodPath = await handler(createAuthorizedDbEvent());
    expect(String(prodPath)).toContain('BrainStrike');

    process.env['NODE_ENV'] = originalEnv;
  });

  it('db:diagnostics returns DB-host diagnostics snapshot', async () => {
    const handler = handlers.get('db:diagnostics');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const result = await handler(createTrustedInvokeEvent());

    expect(getDbHostManagerMock).toHaveBeenCalledTimes(1);
    expect(getDatabaseDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
      databaseLockHeld: true,
      databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
      databaseProfile: 'test',
      dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
      hasDatabaseHandle: true,
      initializationAttemptCount: 1,
      initializationInFlight: false,
      lastInitializationFailure: null,
      lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
      lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
      nodeEnv: 'test',
    });
  });

  it('db:test success path', async () => {
    const handler = handlers.get('db:test');
    const row = { test: 1, timestamp: 'now' };
    mockDb.query.mockResolvedValue({ rows: [row] });

    const result = await handler?.(createTrustedInvokeEvent());

    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    expect(result).toEqual({
      dbLocation: 'DB Host',
      message: 'Database connection successful',
      success: true,
    });
  });

  it('db:test failure path', async () => {
    const handler = handlers.get('db:test');
    mockDb.query.mockRejectedValue(new Error('oops'));

    const result = await handler?.(createTrustedInvokeEvent());

    expect(result).toEqual({
      dbLocation: 'DB Host',
      message: 'Database connection failed: oops',
      success: false,
    });
    expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
  });

  describe('db:clearAll handler', () => {
    /**
     * Every optional relation is now PROBED with `to_regclass` before deleting —
     * a `DELETE FROM` on a missing relation would abort the whole transaction
     * (25P02 on every later statement), which no `vi.fn()` stub can reproduce.
     * Wrapping the stub lets the probe answer "present" WITHOUT consuming a slot
     * in the caller's positional `mockResolvedValueOnce` chain, so these tests
     * keep asserting exactly what they asserted before. The real
     * aborted-transaction behaviour is pinned separately in
     * ipc-handlers-db-clear-all.integration.test.ts.
     */
    function withPresentRelationProbe(
      query: (sql: string) => unknown
    ): (sql: string) => Promise<unknown> {
      return async (sql: string) => {
        if (sql.startsWith('SELECT to_regclass(')) {
          return { rows: [{ present: true }] };
        }
        return await query(sql);
      };
    }

    /**
     * Dispatch-by-SQL `tx.query` stub for the probe-first clear path: counts
     * answer 0, a `to_regclass` probe answers present unless the table is listed
     * in `absent`, and `onDelete` may throw to simulate a genuine failure.
     *
     * Deliberately NOT a positional `mockResolvedValueOnce` chain. The handler
     * now issues one probe per optional relation, so a positional chain would
     * have to be re-counted every time a table is added to the clear — the exact
     * brittleness that made these tests need rewriting in the first place.
     */
    function createClearTxQuery(
      options: { absent?: readonly string[]; onDelete?: (table: string) => void } = {}
    ): Mock<(sql: string) => Promise<{ rows: Array<{ count?: string; present?: boolean }> }>> {
      const absent = new Set<string>(options.absent ?? []);
      return vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT COUNT(*)')) {
          return { rows: [{ count: '0' }] };
        }
        const probed = sql.match(/^SELECT to_regclass\('([^']+)'\)/u);
        if (probed) {
          return { rows: [{ present: !absent.has(probed[1] as string) }] };
        }
        const deleted = sql.match(/^DELETE FROM (\w+)$/u);
        if (deleted) {
          options.onDelete?.(deleted[1] as string);
        }
        return { rows: [] };
      });
    }

    it('requires confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.(createAuthorizedDbEvent());

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Unauthorized: Invalid or missing confirmation token',
        success: false,
      });
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });

    it('rejects invalid confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.(createAuthorizedDbEvent(), 'invalid_token');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Unauthorized: Invalid or missing confirmation token',
        success: false,
      });
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });

    it('successfully clears database with valid token', async () => {
      const handler = handlers.get('db:clearAll');
      let queryMock: ReturnType<typeof vi.fn> | null = null;

      // Mock transaction to call the callback immediately
      mockDb.transaction.mockImplementation(async (callback) => {
        queryMock = vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // chunks count
          .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // files count
          .mockResolvedValue(undefined);
        const mockTx = {
          query: withPresentRelationProbe(
            queryMock as unknown as (sql: string) => Promise<unknown>
          ),
        };
        return await callback(mockTx);
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(getDatabaseMock).toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(result).toEqual({
        deletedChunks: 5,
        deletedFiles: 3,
        message: 'Database cleared successfully',
        success: true,
      });
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM collection_indexing_stats');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM embedding_sets');
      expect(queryMock).toHaveBeenCalledWith(
        'DELETE FROM brainstrike_assistant_tool_output_artifacts'
      );
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_diagnostic_events');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_message_parents');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM prompt_items');
      // Factory-reset contract: stale roots must not survive a clear and
      // resurface as ghost workspaces once consumers read the roots table.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM roots');
    });

    // BST-992: the registry↔call-site parity leg for desktop. The production
    // registry is imported ON PURPOSE (unlike the test-owned literals in
    // ipc-handlers-db-clear-all.integration.test.ts, which exist so production
    // and fixture cannot drift together): a table added to the registry
    // without a `clearOptionalRelation` call here — or a call site the
    // registry does not know — fails this set equality.
    it('clears exactly the reset-table registry set', async () => {
      const handler = handlers.get('db:clearAll');
      const cleared = new Set<string>();
      mockDb.transaction.mockImplementation(async (callback) => {
        const query = createClearTxQuery({ onDelete: (table) => cleared.add(table) });
        return await callback({ query });
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toMatchObject({ success: true });
      expect([...cleared].sort()).toEqual([...getResetTables()].sort());
    });

    // BST-558: `mastra_workflow_snapshot` is the only assistant-owned durable
    // store with an unbounded lifetime (its sole production writer is
    // persistWorkflowSnapshot; nothing deletes rows). Per the FACTORY RESET
    // CONTRACT it must be purged, otherwise suspended-approval snapshots — and
    // their tool arguments — survive a "true fresh start".
    it('clears the Mastra workflow snapshot store per the factory reset contract', async () => {
      const handler = handlers.get('db:clearAll');
      let queryMock: ReturnType<typeof vi.fn> | null = null;

      mockDb.transaction.mockImplementation(async (callback) => {
        queryMock = vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
          .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
          .mockResolvedValue(undefined);
        return await callback({
          query: withPresentRelationProbe(
            queryMock as unknown as (sql: string) => Promise<unknown>
          ),
        });
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toMatchObject({ success: true });
      expect(queryMock).toHaveBeenCalledWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE}`);
    });

    // The relation is created lazily by PgliteWorkflowsStore.initialize(), so
    // "absent" is the normal state for a never-used assistant. It must be
    // PROBED, not deleted-and-caught: a 42P01 aborts the enclosing transaction,
    // and swallowing it still rolls the entire clear back (25P02 thereafter).
    it('probes rather than deletes a missing mastra_workflow_snapshot relation', async () => {
      const handler = handlers.get('db:clearAll');
      let query: ReturnType<typeof vi.fn> | null = null;

      mockDb.transaction.mockImplementation(async (callback) => {
        query = vi.fn(async (sql: string) => {
          if (sql.startsWith('SELECT COUNT(*)')) {
            return { rows: [{ count: '0' }] };
          }
          if (sql === `SELECT to_regclass('${MASTRA_WORKFLOW_TABLE}') IS NOT NULL AS present`) {
            return { rows: [{ present: false }] };
          }
          if (sql.startsWith('SELECT to_regclass(')) {
            return { rows: [{ present: true }] };
          }
          return { rows: [] };
        });
        return await callback({ query });
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toMatchObject({ success: true });
      expect(query).not.toHaveBeenCalledWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE}`);
      // The clear must continue past the absent relation, not abandon it.
      expect(query).toHaveBeenCalledWith('DELETE FROM brainstrike_diagnostic_events');
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    // NOTE: there is deliberately no "tolerates the relation vanishing between
    // probe and delete" case. A mocked `tx.query` has no aborted-transaction
    // semantics, so such a test would assert `success: true` for something real
    // Postgres cannot produce: the 42P01 aborts the transaction, the next
    // statement raises 25P02, and the handler returns `success: false`. Nothing
    // in the repo ever DROPs the relation, so the race is unreachable and the
    // DELETE now surfaces any genuine failure as itself.

    it('handles database errors gracefully', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockRejectedValue(new Error('Database connection failed'));

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database clear failed: Database connection failed',
        success: false,
      });
      expect(currentIntegrityState()).toEqual({ kind: 'healthy' });
    });

    it('handles transaction callback errors', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi.fn().mockRejectedValue(new Error('Query failed')),
        };
        return await callback(mockTx);
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database clear failed: Query failed',
        success: false,
      });
    });

    // Absence is now handled by SKIPPING the delete, not by catching its error.
    // These two cases used to assert delete-and-tolerate; that shape could never
    // work inside a transaction (the tolerated 42P01 leaves it aborted), so the
    // assertion is now "no DELETE was ever issued for the absent relation".
    it('skips selection snapshots entirely when the relation is absent', async () => {
      const handler = handlers.get('db:clearAll');
      const query = createClearTxQuery({ absent: ['selection_snapshot_files'] });
      mockDb.transaction.mockImplementation(async (callback) => await callback({ query }));

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database cleared successfully',
        success: true,
      });
      expect(query).not.toHaveBeenCalledWith('DELETE FROM selection_snapshot_files');
      // The clear must continue past the absent relation, not abandon it.
      expect(query).toHaveBeenCalledWith('DELETE FROM selection_snapshots');
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('skips an optional indexing table when the relation is absent', async () => {
      const handler = handlers.get('db:clearAll');
      const query = createClearTxQuery({ absent: ['collection_indexing_stats'] });
      mockDb.transaction.mockImplementation(async (callback) => await callback({ query }));

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database cleared successfully',
        success: true,
      });
      expect(query).not.toHaveBeenCalledWith('DELETE FROM collection_indexing_stats');
      expect(query).toHaveBeenCalledWith('DELETE FROM embedding_sets');
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    // The selection-snapshot block used to only LOG a non-missing-relation error
    // and never rethrow, so the clear reported success having rolled back. The
    // relation is PRESENT here, so the failure is genuine and must fail closed.
    it('fails the clear when a present selection-snapshot relation cannot be deleted', async () => {
      const handler = handlers.get('db:clearAll');
      let transactionCommitted = false;
      const query = createClearTxQuery({
        onDelete: (table) => {
          if (table === 'selection_snapshot_files') {
            throw new Error('boom');
          }
        },
      });
      mockDb.transaction.mockImplementation(async (callback) => {
        const value = await callback({ query });
        transactionCommitted = true;
        return value;
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(transactionCommitted).toBe(false);
      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database clear failed: boom',
        success: false,
      });
    });

    /**
     * A 42P01 naming a DIFFERENT relation (say a trigger's audit table) must not
     * be mistaken for "prompt_items is absent". Under probe-first that is true by
     * construction: the probe already said prompt_items is present, so the DELETE
     * is unwrapped and the real error propagates verbatim — no message parsing,
     * and no duplicate warn on the way out.
     */
    it('fails closed when a present table reports an unrelated undefined relation', async () => {
      const handler = handlers.get('db:clearAll');
      const unrelatedMissingRelation = Object.assign(
        new Error('relation "prompt_item_audit_log" does not exist while deleting prompt_items'),
        { code: '42P01' }
      );
      let transactionCommitted = false;
      const query = createClearTxQuery({
        onDelete: (table) => {
          if (table === 'prompt_items') {
            throw unrelatedMissingRelation;
          }
        },
      });
      mockDb.transaction.mockImplementation(async (callback) => {
        const value = await callback({ query });
        transactionCommitted = true;
        return value;
      });

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(transactionCommitted).toBe(false);
      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message:
          'Database clear failed: relation "prompt_item_audit_log" does not exist while deleting prompt_items',
        success: false,
      });
    });

    it('fails the clear when optional indexing table cleanup hits an unexpected error', async () => {
      const handler = handlers.get('db:clearAll');
      const query = createClearTxQuery({
        onDelete: (table) => {
          if (table === 'collection_indexing_stats') {
            throw new Error('stats cleanup failed');
          }
        },
      });
      mockDb.transaction.mockImplementation(async (callback) => await callback({ query }));

      const result = await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
        message: 'Database clear failed: stats cleanup failed',
        success: false,
      });
    });
  });

  describe('live query backgrounding', () => {
    // NOTE: flushPendingLiveUpdates uses require('electron').browserWindowMock.getAllWindows()
    // which doesn't resolve through the vi.mock factory. These tests focus on the
    // pause/resume subscription lifecycle. The flush path is covered by the module
    // being exercised in integration.

    function createLiveQuerySender(id: number): {
      id: number;
      isDestroyed: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    } {
      return {
        id,
        isDestroyed: vi.fn(() => false),
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      };
    }

    async function setupLiveQuery(sender = createLiveQuerySender(50)) {
      const handler = handlers.get('db:live-query:start');
      if (!handler) {
        throw new Error('handler not registered');
      }

      let listener: ((results: unknown) => void) | null = null;
      const liveHandle = {
        initialResults: { rows: [] },
        refresh: vi.fn(),
        subscribe: vi.fn((cb: (results: unknown) => void) => {
          listener = cb;
        }),
        unsubscribe: vi.fn(),
      };
      mockDb.live.query.mockResolvedValue(liveHandle);

      const result = (await handler(createAuthorizedDbEvent(sender), {
        query: 'SELECT 1',
      })) as { id: number };
      const subscribedListener: unknown = listener;
      if (typeof subscribedListener !== 'function') {
        throw new Error('expected live-query listener');
      }
      return { listener: subscribedListener, liveHandle, result, sender };
    }

    it('keeps live-query subscriptions attached across background and foreground transitions', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { liveHandle } = await setupLiveQuery();

      // subscribe called once during setup
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);

      // PGlite 0.4.4 treats unsubscribe of the final listener as terminal for the
      // handle, so backgrounding must rely on IPC batching instead of detaching.
      setBackgrounded(true);
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();

      // Return to foreground — should flush pending updates without re-subscribing.
      // pendingLiveUpdates is empty so flushPendingLiveUpdates is a no-op
      setBackgrounded(false);
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);
    });

    it('does not pause when setBackgrounded(false) is called while already foregrounded', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { liveHandle } = await setupLiveQuery();

      // Already foregrounded — setting false again should not re-subscribe
      setBackgrounded(false);
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1); // only initial
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
    });

    it('does not re-pause when setBackgrounded(true) is called while already backgrounded', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { liveHandle } = await setupLiveQuery();

      setBackgrounded(true);
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();

      // Already backgrounded — should still keep the live-query handle attached.
      setBackgrounded(true);
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();

      // Clean up without triggering flush (no pending updates)
      setBackgrounded(false);
    });

    it('does not call unsubscribe during background pause', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { liveHandle } = await setupLiveQuery();

      liveHandle.unsubscribe.mockReturnValue(Promise.reject(new Error('pause failed')));

      expect(() => setBackgrounded(true)).not.toThrow();
      await Promise.resolve();

      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
      expect(loggerDebug).not.toHaveBeenCalledWith(
        'Failed to unsubscribe live query during pause',
        expect.anything()
      );

      setBackgrounded(false);
    });

    it('does not call subscribe again during foreground resume', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { liveHandle } = await setupLiveQuery();

      setBackgrounded(true);
      liveHandle.subscribe.mockImplementation(() => Promise.reject(new Error('resume failed')));

      expect(() => setBackgrounded(false)).not.toThrow();
      await Promise.resolve();

      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);
      expect(loggerDebug).not.toHaveBeenCalledWith(
        'Failed to resubscribe live query after pause release',
        expect.anything()
      );
    });

    it('cleans up subscriptions when a backgrounded owner window is no longer available', async () => {
      const { setBackgrounded } = await import('../../ipc-domains/db-ipc');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);

      setBackgrounded(true);
      listener({ rows: [{ id: 99 }] });

      getAllWindowsMock.mockReturnValue([]);

      setBackgrounded(false);
      await Promise.resolve();

      expect(liveHandle.unsubscribe).toHaveBeenCalledTimes(1);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('cleans up subscriptions when foreground sends fail because the render frame was disposed', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      setBrowserWindows(sender);

      listener({ rows: [{ id: 123 }] });
      // Flush the batched update to trigger the disposed-frame error path
      flushPendingLiveUpdates();
      await Promise.resolve();

      expect(liveHandle.unsubscribe).toHaveBeenCalled();
    });

    it('does not retry disposed-frame sends while owner cleanup is still in flight', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      let resolveCleanup: (() => void) | null = null;
      const cleanupInFlight = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      liveHandle.unsubscribe.mockReturnValue(cleanupInFlight);
      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      setBrowserWindows(sender);

      listener({ rows: [{ id: 1 }] });
      flushPendingLiveUpdates();

      listener({ rows: [{ id: 2 }] });
      flushPendingLiveUpdates();

      expect(sender.send).toHaveBeenCalledTimes(1);

      const finishCleanup: unknown = resolveCleanup;
      if (typeof finishCleanup !== 'function') {
        throw new Error('expected cleanup completion callback');
      }
      finishCleanup();
      await cleanupInFlight;
      await Promise.resolve();
    });

    it('logs unexpected send errors and continues flushing healthy subscriptions', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
      const failingSender = createLiveQuerySender(60);
      const healthySender = createLiveQuerySender(61);
      const failingSubscription = await setupLiveQuery(failingSender);
      const healthySubscription = await setupLiveQuery(healthySender);
      failingSender.send.mockImplementation(() => {
        throw new Error('boom');
      });
      setBrowserWindows(failingSender, healthySender);

      failingSubscription.listener({ rows: [{ id: 456 }] });
      healthySubscription.listener({ rows: [{ id: 789 }] });

      expect(() => flushPendingLiveUpdates()).not.toThrow();
      expect(failingSender.send).toHaveBeenCalledTimes(1);
      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 789 }] },
      });
      expect(loggerWarn).toHaveBeenCalledWith('Failed to deliver live query update to renderer', {
        error: expect.any(Error),
        subscriptionId: failingSubscription.result.id,
        webContentsId: failingSender.id,
      });

      healthySubscription.sender.send.mockClear();
      healthySubscription.listener({ rows: [{ id: 790 }] });
      flushPendingLiveUpdates();

      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 790 }] },
      });
    });

    it('keeps the owner reaper attached when disposed-frame cleanup runs before webContents teardown', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
      const handler = handlers.get('db:live-query:start');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const firstLiveHandle = createLiveHandleMock();
      const secondLiveHandle = createLiveHandleMock();
      mockDb.live.query
        .mockResolvedValueOnce(firstLiveHandle)
        .mockResolvedValueOnce(secondLiveHandle);

      const sender = createFakeLiveQueryOwner(51);
      sender.send
        .mockImplementationOnce(() => {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed');
        })
        .mockImplementation(() => undefined);
      setBrowserWindows(sender);

      const firstResult = (await handler(createAuthorizedDbEvent(sender), {
        query: 'SELECT 1',
      })) as { id: number };
      const firstListener = firstLiveHandle.subscribe.mock.calls[0]?.[0] as
        | ((results: unknown) => void)
        | undefined;
      if (!firstListener) {
        throw new Error('expected first live-query listener');
      }

      firstListener({ rows: [{ id: 1 }] });
      // Flush the batched update to trigger the disposed-frame error path
      flushPendingLiveUpdates();
      await Promise.resolve();

      expect(firstLiveHandle.unsubscribe).toHaveBeenCalled();
      for (const teardownEvent of LIVE_QUERY_TEARDOWN_EVENTS) {
        expect(sender.listenerCount(teardownEvent)).toBe(1);
      }

      const secondResult = (await handler(createAuthorizedDbEvent(sender), {
        query: 'SELECT 2',
      })) as { id: number };

      expect(secondResult.id).not.toBe(firstResult.id);
      expect(secondLiveHandle.subscribe).toHaveBeenCalledTimes(1);
      // Disposed-frame cleanup does not detach the reaper, so a later start
      // must not attach a duplicate set of teardown listeners.
      for (const teardownEvent of LIVE_QUERY_TEARDOWN_EVENTS) {
        expect(sender.listenerCount(teardownEvent)).toBe(1);
      }
    });

    it('resets live-query module state during shutdown cleanup', async () => {
      const { cleanupDesktopLiveSubscriptionsForShutdown, setBackgrounded } = await import(
        '../../ipc-domains/db-ipc'
      );
      const first = await setupLiveQuery(createLiveQuerySender(70));

      setBackgrounded(true);
      first.listener({ rows: [{ id: 1 }] });
      await cleanupDesktopLiveSubscriptionsForShutdown();

      expect(first.liveHandle.unsubscribe).toHaveBeenCalledTimes(1);

      const second = await setupLiveQuery(createLiveQuerySender(71));
      expect(second.result.id).toBe(1);
      second.listener({ rows: [{ id: 2 }] });

      setBrowserWindows(second.sender);
      const { flushPendingLiveUpdates } = await import('../../ipc-domains/db-ipc');
      flushPendingLiveUpdates();

      expect(second.sender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: 1,
        results: { rows: [{ id: 2 }] },
      });
    });
  });
});
