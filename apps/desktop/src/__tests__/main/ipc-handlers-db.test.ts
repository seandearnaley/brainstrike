import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyManagedCacheBatchMock,
  browserWindowMock,
  closeDatabaseMock,
  createWindowWithWebContents,
  embeddingHostIsHostWindowMock,
  getDatabaseDiagnosticsMock,
  getDatabaseMock,
  getDbHostManagerMock,
  handleRuntimeCorruptionMock,
  handlers,
  invalidateManagedCacheEntriesByIdentityMock,
  isCorruptionErrorMock,
  loggerDebug,
  loggerWarn,
  mockDb,
  resetDatabaseIpcHandlerMocks,
  resetDesktopApplicationDataMock,
  resetLocalDatabaseMock,
} from './ipc-handlers-db-test-fixture';

describe('database IPC handlers', () => {
  beforeEach(async () => {
    await resetDatabaseIpcHandlerMocks();
  });

  it('waits for scheduled desktop database work to drain before shutdown', async () => {
    const { runDesktopScheduledDatabaseWork, waitForDesktopDatabaseWorkSchedulerIdle } =
      await import('../../ipc-handlers');

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
    releaseWork();
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  it('keeps database work submitted during reset out of the scheduler until reset completes', async () => {
    const {
      getDesktopDatabaseWorkSchedulerSnapshot,
      runDesktopScheduledDatabaseWork,
      runWithDesktopDatabaseResetBarrier,
      waitForDesktopDatabaseWorkSchedulerIdle,
    } = await import('../../ipc-handlers');

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
    releaseReset();
    await resetBarrierPromise;
    await expect(pendingWork).resolves.toBe('ran-after-reset');
    expect(workStarted).toBe(true);
  });

  it('db:query calls query and returns result', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.({} as unknown, 'SELECT 1', [1]);

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1', [1]);
    expect(result).toBe(rows);
  });

  it('db:query accepts database work options as the second argument when params are omitted', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.({} as unknown, 'SELECT 1', {
      label: 'collection page',
      priority: 'foreground',
    });

    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    expect(result).toBe(rows);
  });

  it('db:query rejects empty object params instead of treating them as work options', async () => {
    const handler = handlers.get('db:query');

    await expect(handler?.({} as unknown, 'SELECT $1', {})).rejects.toThrow(
      'db:query parameters must be an array when provided.'
    );

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects object params before they reach PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(
      handler?.({} as unknown, 'SELECT $1', { value: 'not-array-params' })
    ).rejects.toThrow('db:query parameters must be an array when provided.');

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects destructive renderer schema SQL before it reaches PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(handler?.({} as unknown, 'DROP TABLE file_records')).rejects.toThrow(
      'db:query does not permit destructive schema SQL from the renderer.'
    );

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query rejects broad destructive DROP statements before they reach PGlite', async () => {
    const handler = handlers.get('db:query');

    await expect(handler?.({} as unknown, 'DROP SEQUENCE file_record_seq')).rejects.toThrow(
      'db:query does not permit destructive schema SQL from the renderer.'
    );

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('db:query permits renderer-owned DML and delegates to PGlite', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.({} as unknown, 'DELETE FROM job_queue WHERE id = $1', ['job-1']);

    expect(mockDb.query).toHaveBeenCalledWith('DELETE FROM job_queue WHERE id = $1', ['job-1']);
    expect(result).toBe(rows);
  });

  it('db:exec permits non-destructive ALTER TABLE literals and delegates to PGlite', async () => {
    const handler = handlers.get('db:exec');

    const result = await handler?.(
      {} as unknown,
      "ALTER TABLE file_records ADD COLUMN label TEXT DEFAULT 'drop'"
    );

    expect(mockDb.exec).toHaveBeenCalledWith(
      "ALTER TABLE file_records ADD COLUMN label TEXT DEFAULT 'drop'"
    );
    expect(result).toBeUndefined();
  });

  it('db:exec rejects destructive renderer schema SQL before it reaches PGlite', async () => {
    const handler = handlers.get('db:exec');

    await expect(handler?.({} as unknown, 'DROP TABLE file_records')).rejects.toThrow(
      'db:exec does not permit destructive schema SQL from the renderer.'
    );

    expect(mockDb.exec).not.toHaveBeenCalled();
  });

  it('db:query throws on error', async () => {
    const handler = handlers.get('db:query');
    const err = new Error('fail');
    mockDb.query.mockRejectedValue(err);

    await expect(handler?.({} as unknown, 'SELECT bad')).rejects.toThrow(err);
  });

  it('schedules foreground db:query before queued background work during the quiet window', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import('../../ipc-handlers');
      let now = 1000;
      resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 50, now: () => now });
      const handler = handlers.get('db:query');
      const order: string[] = [];
      mockDb.query.mockImplementation(async (sql: string) => {
        order.push(sql);
        return { rows: [] };
      });

      await handler?.({} as unknown, 'SELECT warmup', []);
      order.length = 0;

      const background = handler?.({} as unknown, 'SELECT background', [], {
        priority: 'background',
        label: 'background claim',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      const foreground = handler?.({} as unknown, 'SELECT foreground', [], {
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
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import('../../ipc-handlers');
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

      await handler?.({} as unknown, 'SELECT warmup', []);
      order.length = 0;
      embeddingHostIsHostWindowMock.mockReturnValueOnce(true);

      const background = handler?.({ sender: hiddenSender } as unknown, 'SELECT hidden_host', []);
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      const foreground = handler?.({} as unknown, 'SELECT visible_renderer', []);
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

    const result = await handler?.({} as unknown, 'CREATE TABLE');

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.exec).toHaveBeenCalledWith('CREATE TABLE');
    expect(result).toBe(ret);
  });

  it('db:exec throws on error', async () => {
    const handler = handlers.get('db:exec');
    const err = new Error('exec fail');
    mockDb.exec.mockRejectedValue(err);

    await expect(handler?.({} as unknown, 'SELECT bad')).rejects.toThrow(err);
  });

  it('db:managed-cache:apply-batch validates payload and delegates to the DB host', async () => {
    const handler = handlers.get('db:managed-cache:apply-batch');
    const payload = {
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'replace',
          record: {
            id: 'file-1',
            name: 'index.ts',
            path: 'src/index.ts',
            size: 10,
            sourceRootPath: '/workspace/root',
            updatedAt: '2026-04-15T00:00:00.000Z',
            processedAt: '2026-04-15T00:00:00.000Z',
            content: 'export const value = 2;',
            contentHash: 'hash-2',
            tokenCount: 5,
          },
        },
      ],
    };

    await handler?.({} as unknown, payload);

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).toHaveBeenCalled();
    expect(applyManagedCacheBatchMock).toHaveBeenCalledWith(payload);
  });

  it('schedules db:managed-cache:apply-batch as background when requested', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import('../../ipc-handlers');
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
      const payload = { embeddingSetId: 'set-1', changes: [] };

      await queryHandler?.({} as unknown, 'SELECT warmup', []);
      order.length = 0;

      const background = batchHandler?.({} as unknown, payload, {
        priority: 'background',
        label: 'managed cache batch',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      await queryHandler?.({} as unknown, 'SELECT foreground_query', []);
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
    isCorruptionErrorMock.mockReturnValueOnce(true);

    await expect(
      handler?.({} as unknown, {
        embeddingSetId: '',
        changes: 'invalid',
      })
    ).rejects.toThrow();

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).not.toHaveBeenCalled();
    expect(applyManagedCacheBatchMock).not.toHaveBeenCalled();
    expect(isCorruptionErrorMock).not.toHaveBeenCalled();
    expect(handleRuntimeCorruptionMock).not.toHaveBeenCalled();
  });

  it('db:managed-cache:apply-batch accepts empty change arrays as a no-op payload', async () => {
    const handler = handlers.get('db:managed-cache:apply-batch');
    const payload = {
      embeddingSetId: 'set-1',
      changes: [],
    };

    await handler?.({} as unknown, payload);

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
          rootId: 'root-1',
          relativePath: 'src/index.ts',
        },
        {
          mode: 'prefix',
          rootId: 'root-2',
          relativePathPrefix: 'src/generated',
        },
      ],
    };

    await handler?.({} as unknown, payload);

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).toHaveBeenCalled();
    expect(invalidateManagedCacheEntriesByIdentityMock).toHaveBeenCalledWith(payload);
  });

  it('schedules db:managed-cache:invalidate-by-identity as background when requested', async () => {
    vi.useFakeTimers();
    try {
      const { resetDesktopDatabaseWorkSchedulerForTests } = await import('../../ipc-handlers');
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

      await queryHandler?.({} as unknown, 'SELECT warmup', []);
      order.length = 0;

      const background = invalidationHandler?.({} as unknown, payload, {
        priority: 'background',
        label: 'managed cache invalidation',
      });
      await Promise.resolve();
      expect(order).toEqual([]);

      now += 1;
      await queryHandler?.({} as unknown, 'SELECT foreground_query', []);
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
      handler?.({} as unknown, {
        embeddingSetId: '',
        targets: 'invalid',
      })
    ).rejects.toThrow();

    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(getDbHostManagerMock).not.toHaveBeenCalled();
    expect(invalidateManagedCacheEntriesByIdentityMock).not.toHaveBeenCalled();
    expect(isCorruptionErrorMock).not.toHaveBeenCalled();
    expect(handleRuntimeCorruptionMock).not.toHaveBeenCalled();
  });

  it('db:live-query:start subscribes and forwards updates', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    let listener: ((results: unknown) => void) | null = null;
    const liveHandle = {
      initialResults: { rows: [{ id: 1 }] },
      subscribe: vi.fn((cb: (results: unknown) => void) => {
        listener = cb;
      }),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 22,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await handler({ sender } as unknown, { query: 'select 1', params: [1] })) as {
      id: number;
      initialResults: unknown;
    };

    expect(mockDb.live.query).toHaveBeenCalledWith({
      query: 'select 1',
      params: [1],
      offset: undefined,
      limit: undefined,
    });
    expect(result.initialResults).toEqual({ rows: [{ id: 1 }] });

    listener?.({ rows: [{ id: 2 }] });
    // Live query updates are dedup+batched; flush to deliver pending sends.
    const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
    const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);
    getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);
    flushPendingLiveUpdates();
    expect(sender.send).toHaveBeenCalledWith('db:live-query:update', {
      id: result.id,
      results: { rows: [{ id: 2 }] },
    });

    const stopHandler = handlers.get('db:live-query:stop');
    await stopHandler?.({} as unknown, result.id);
    expect(liveHandle.unsubscribe).toHaveBeenCalled();
  });

  it('db:live-query:start escapes literal percents when params are present', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    await handler(
      { sender: { id: 23, isDestroyed: () => false, send: vi.fn(), once: vi.fn() } } as unknown,
      {
        query: "SELECT * FROM file_records WHERE path LIKE '%' || $1 || '%'",
        params: ['needle'],
      }
    );

    expect(mockDb.live.query).toHaveBeenCalledWith({
      query: "SELECT * FROM file_records WHERE path LIKE '%%' || $1 || '%%'",
      params: ['needle'],
      offset: undefined,
      limit: undefined,
    });
  });

  it('db:live-query:start registers a single destroyed listener per webContents', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const firstHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    const secondHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);

    const sender = {
      id: 101,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await handler({ sender } as unknown, { query: 'select 1' });
    await handler({ sender } as unknown, { query: 'select 2' });

    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });

  it('db:live-query:start supports incremental mode with key', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.incrementalQuery.mockResolvedValue(liveHandle);

    await handler(
      { sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn() } } as unknown,
      { query: 'select *', key: 'id', mode: 'incremental', offset: 2, limit: 5 }
    );

    expect(mockDb.live.incrementalQuery).toHaveBeenCalledWith({
      query: 'select *',
      params: null,
      key: 'id',
      offset: 2,
      limit: 5,
    });
  });

  it('db:live-query:start throws when incremental key is missing', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler(
        { sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn() } } as unknown,
        { query: 'select *', mode: 'incremental' }
      )
    ).rejects.toThrow('Live incremental queries require a key column');
  });

  it('db:live-query:refresh returns not found when subscription missing', async () => {
    const handler = handlers.get('db:live-query:refresh');

    const result = await handler?.({} as unknown, { id: 999 });

    expect(result).toEqual({ success: false, message: 'Subscription not found' });
  });

  it('db:live-query:refresh handles corruption errors', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 77,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await startHandler({ sender } as unknown, { query: 'select 1' })) as {
      id: number;
    };

    const error = new Error('corrupted');
    liveHandle.refresh.mockRejectedValue(error);
    isCorruptionErrorMock.mockReturnValueOnce(true);

    const refreshResult = await refreshHandler({} as unknown, { id: result.id });

    expect(handleRuntimeCorruptionMock).toHaveBeenCalledWith('db:live-query:refresh');
    expect(refreshResult).toEqual({
      success: false,
      message: 'Database was corrupted and has been reset. Please reload the application.',
      corrupted: true,
    });
  });

  it('db:live-query:refresh returns error message for non-corruption errors', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 55,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await startHandler({ sender } as unknown, { query: 'select 1' })) as {
      id: number;
    };

    liveHandle.refresh.mockRejectedValue(new Error('refresh failed'));
    isCorruptionErrorMock.mockReturnValueOnce(false);

    const refreshResult = await refreshHandler({} as unknown, { id: result.id, offset: 1 });

    expect(refreshResult).toEqual({
      success: false,
      message: 'refresh failed',
    });
  });

  it('db:resetLocal delegates desktop application data reset and returns errors', async () => {
    const handler = handlers.get('db:resetLocal');
    if (!handler) {
      throw new Error('handler not registered');
    }

    resetDesktopApplicationDataMock.mockResolvedValueOnce({
      deletedPaths: [],
      pendingDeletionPaths: [],
      preservedPaths: [],
    });
    await expect(handler({} as unknown)).resolves.toEqual({ success: true });
    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resetDatabaseProfile: expect.any(Function),
        stopBackgroundRuntimes: expect.any(Function),
        userDataPath: expect.any(String),
      })
    );
    const resetOptions = resetDesktopApplicationDataMock.mock.calls[0]?.[0] as
      | { resetDatabaseProfile?: () => Promise<void> }
      | undefined;
    if (typeof resetOptions?.resetDatabaseProfile !== 'function') {
      throw new Error('resetDatabaseProfile callback was not passed to desktop reset');
    }
    const { runDesktopScheduledDatabaseWork } = await import('../../ipc-handlers');
    let releaseWork: (() => void) | null = null;
    const workStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'reset-drain-test', priority: 'normal' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseWork = release;
          });
        }
      );
    });
    await workStarted;

    const resetProfilePromise = resetOptions.resetDatabaseProfile();
    await Promise.resolve();
    expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
    if (!releaseWork) {
      throw new Error('Scheduled database work did not expose a release callback.');
    }
    releaseWork();
    await resetProfilePromise;
    expect(resetLocalDatabaseMock).toHaveBeenCalledTimes(1);
    expect(closeDatabaseMock).not.toHaveBeenCalled();

    resetDesktopApplicationDataMock.mockRejectedValueOnce(new Error('fail reset'));
    await expect(handler({} as unknown)).resolves.toEqual({
      success: false,
      message: 'fail reset',
    });
  });

  it('db:getUserDataPath returns expected paths', async () => {
    const handler = handlers.get('db:getUserDataPath');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const originalEnv = process.env['NODE_ENV'];

    process.env['NODE_ENV'] = 'test';
    const testPath = await handler({} as unknown);
    expect(String(testPath)).toContain('pgdata');

    process.env['NODE_ENV'] = 'production';
    const prodPath = await handler({} as unknown);
    expect(String(prodPath)).toContain('BrainStrike');

    process.env['NODE_ENV'] = originalEnv;
  });

  it('db:diagnostics returns DB-host diagnostics snapshot', async () => {
    const handler = handlers.get('db:diagnostics');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const result = await handler({} as unknown);

    expect(getDbHostManagerMock).toHaveBeenCalledTimes(1);
    expect(getDatabaseDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      databaseProfile: 'test',
      dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
      appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
      nodeEnv: 'test',
      initializationAttemptCount: 1,
      initializationInFlight: false,
      hasDatabaseHandle: true,
      databaseLockHeld: true,
      databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
      lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
      lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
      lastInitializationFailure: null,
      runtimeCorruptionRecoveryCount: 0,
      lastRuntimeCorruptionAt: null,
      lastRuntimeCorruptionContext: null,
      tursoOwnerClientQoS: { available: false, reason: 'runtime-not-turso' },
    });
  });

  it('db:test success path', async () => {
    const handler = handlers.get('db:test');
    const row = { test: 1, timestamp: 'now' };
    mockDb.query.mockResolvedValue({ rows: [row] });

    const result = await handler?.({} as unknown);

    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    expect(result).toEqual({
      success: true,
      message: 'Database connection successful',
      dbLocation: 'DB Host',
      profileBootstrapReport: null,
    });
  });

  it('db:test failure path', async () => {
    const handler = handlers.get('db:test');
    mockDb.query.mockRejectedValue(new Error('oops'));

    const result = await handler?.({} as unknown);

    expect(result).toEqual({
      success: false,
      message: 'Database connection failed: oops',
      dbLocation: 'DB Host',
    });
  });

  describe('db:clearAll handler', () => {
    it('requires confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.({} as unknown);

      expect(result).toEqual({
        success: false,
        message: 'Unauthorized: Invalid or missing confirmation token',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });

    it('rejects invalid confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.({} as unknown, 'invalid_token');

      expect(result).toEqual({
        success: false,
        message: 'Unauthorized: Invalid or missing confirmation token',
        deletedFiles: 0,
        deletedChunks: 0,
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
          query: queryMock,
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(getDatabaseMock).toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 3,
        deletedChunks: 5,
      });
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM collection_indexing_stats');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM embedding_sets');
      // Factory-reset contract: stale roots must not survive a clear and
      // resurface as ghost workspaces once consumers read the roots table.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM roots');
    });

    it('handles database errors gracefully', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockRejectedValue(new Error('Database connection failed'));

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: false,
        message: 'Database clear failed: Database connection failed',
        deletedFiles: 0,
        deletedChunks: 0,
      });
    });

    it('handles transaction callback errors', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi.fn().mockRejectedValue(new Error('Query failed')),
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: false,
        message: 'Database clear failed: Query failed',
        deletedFiles: 0,
        deletedChunks: 0,
      });
    });

    it('ignores missing relation errors when clearing selection snapshots', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const error = Object.assign(
          new Error('relation "selection_snapshot_files" does not exist'),
          { code: '42P01' }
        );
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockRejectedValueOnce(error) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockResolvedValueOnce(undefined) // DELETE embedding_sets
            .mockResolvedValueOnce(undefined), // DELETE job_queue
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('logs unexpected errors when clearing selection snapshots', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockRejectedValueOnce(new Error('boom')) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockResolvedValueOnce(undefined) // DELETE embedding_sets
            .mockResolvedValueOnce(undefined), // DELETE job_queue
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(loggerWarn).toHaveBeenCalledWith('Failed to clear selection snapshots', {
        error: expect.any(Error),
      });
    });

    it('ignores missing relation errors when clearing optional indexing tables', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const missingRelation = Object.assign(
          new Error('relation "collection_indexing_stats" does not exist'),
          { code: '42P01' }
        );
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce(undefined) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE snapshot headers
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockRejectedValueOnce(missingRelation) // DELETE collection_indexing_stats
            .mockResolvedValueOnce(undefined) // DELETE embedding_sets
            .mockResolvedValueOnce(undefined), // DELETE job_queue
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('fails the clear when optional indexing table cleanup hits an unexpected error', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce(undefined) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE snapshot headers
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockRejectedValueOnce(new Error('stats cleanup failed')),
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: false,
        message: 'Database clear failed: stats cleanup failed',
        deletedFiles: 0,
        deletedChunks: 0,
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
      send: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    } {
      return {
        id,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        once: vi.fn(),
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
        subscribe: vi.fn((cb: (results: unknown) => void) => {
          listener = cb;
        }),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      mockDb.live.query.mockResolvedValue(liveHandle);

      const result = (await handler({ sender } as unknown, {
        query: 'SELECT 1',
      })) as { id: number };
      return { result, listener: listener!, sender, liveHandle };
    }

    it('keeps live-query subscriptions attached across background and foreground transitions', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
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
      const { setBackgrounded } = await import('../../ipc-handlers');
      const { liveHandle } = await setupLiveQuery();

      // Already foregrounded — setting false again should not re-subscribe
      setBackgrounded(false);
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1); // only initial
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
    });

    it('does not re-pause when setBackgrounded(true) is called while already backgrounded', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
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
      const { setBackgrounded } = await import('../../ipc-handlers');
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
      const { setBackgrounded } = await import('../../ipc-handlers');
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
      const { setBackgrounded } = await import('../../ipc-handlers');
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
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);

      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      listener({ rows: [{ id: 123 }] });
      // Flush the batched update to trigger the disposed-frame error path
      flushPendingLiveUpdates();
      await Promise.resolve();

      expect(liveHandle.unsubscribe).toHaveBeenCalled();
    });

    it('does not retry disposed-frame sends while owner cleanup is still in flight', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);

      let resolveCleanup: (() => void) | null = null;
      const cleanupInFlight = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      liveHandle.unsubscribe.mockReturnValue(cleanupInFlight);
      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      listener({ rows: [{ id: 1 }] });
      flushPendingLiveUpdates();

      listener({ rows: [{ id: 2 }] });
      flushPendingLiveUpdates();

      expect(sender.send).toHaveBeenCalledTimes(1);

      resolveCleanup?.();
      await cleanupInFlight;
      await Promise.resolve();
    });

    it('logs unexpected send errors and continues flushing healthy subscriptions', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const failingSender = createLiveQuerySender(60);
      const healthySender = createLiveQuerySender(61);
      const failingSubscription = await setupLiveQuery(failingSender);
      const healthySubscription = await setupLiveQuery(healthySender);
      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);

      failingSender.send.mockImplementation(() => {
        throw new Error('boom');
      });
      getAllWindowsMock.mockReturnValue([
        createWindowWithWebContents(failingSender),
        createWindowWithWebContents(healthySender),
      ]);

      failingSubscription.listener({ rows: [{ id: 456 }] });
      healthySubscription.listener({ rows: [{ id: 789 }] });

      expect(() => flushPendingLiveUpdates()).not.toThrow();
      expect(failingSender.send).toHaveBeenCalledTimes(1);
      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 789 }] },
      });
      expect(loggerWarn).toHaveBeenCalledWith('Failed to deliver live query update to renderer', {
        subscriptionId: failingSubscription.result.id,
        webContentsId: failingSender.id,
        error: expect.any(Error),
      });

      healthySubscription.sender.send.mockClear();
      healthySubscription.listener({ rows: [{ id: 790 }] });
      flushPendingLiveUpdates();

      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 790 }] },
      });
    });

    it('keeps owner destroy-listener registration when disposed-frame cleanup runs before webContents destruction', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const handler = handlers.get('db:live-query:start');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const firstLiveHandle = {
        initialResults: { rows: [] },
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      const secondLiveHandle = {
        initialResults: { rows: [] },
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      mockDb.live.query
        .mockResolvedValueOnce(firstLiveHandle)
        .mockResolvedValueOnce(secondLiveHandle);

      const sender = {
        id: 51,
        isDestroyed: vi.fn(() => false),
        send: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('Render frame was disposed before WebFrameMain could be accessed');
          })
          .mockImplementation(() => undefined),
        once: vi.fn(),
      };
      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      const firstResult = (await handler({ sender } as unknown, {
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
      expect(sender.once).toHaveBeenCalledTimes(1);

      const secondResult = (await handler({ sender } as unknown, {
        query: 'SELECT 2',
      })) as { id: number };

      expect(secondResult.id).not.toBe(firstResult.id);
      expect(secondLiveHandle.subscribe).toHaveBeenCalledTimes(1);
      expect(sender.once).toHaveBeenCalledTimes(1);
    });

    it('resets live-query module state during shutdown cleanup', async () => {
      const { cleanupDesktopLiveSubscriptionsForShutdown, setBackgrounded } = await import(
        '../../ipc-handlers'
      );
      const first = await setupLiveQuery(createLiveQuerySender(70));

      setBackgrounded(true);
      first.listener({ rows: [{ id: 1 }] });
      await cleanupDesktopLiveSubscriptionsForShutdown();

      expect(first.liveHandle.unsubscribe).toHaveBeenCalledTimes(1);

      const second = await setupLiveQuery(createLiveQuerySender(71));
      expect(second.result.id).toBe(1);
      second.listener({ rows: [{ id: 2 }] });

      const getAllWindowsMock = vi.mocked(browserWindowMock.getAllWindows);
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(second.sender)]);
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      flushPendingLiveUpdates();

      expect(second.sender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: 1,
        results: { rows: [{ id: 2 }] },
      });
    });
  });
});
