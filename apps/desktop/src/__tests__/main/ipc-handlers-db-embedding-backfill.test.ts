import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
} from '../../embedding-host-shared';
import {
  embeddingHostDestroyAndRestartMock,
  embeddingHostEnsureStartedMock,
  embeddingHostGetStatusMock,
  embeddingHostResetMock,
  embeddingHostStopMock,
  enqueueEmbeddingBackfillMock,
  getDatabaseMock,
  handlers,
  mockDb,
  resetDatabaseIpcHandlerMocks,
} from './ipc-handlers-db-test-fixture';

describe('database IPC embedding backfill handlers', () => {
  beforeEach(async () => {
    await resetDatabaseIpcHandlerMocks();
  });

  it('embedding-host:enqueue-backfill runs backfill in main and streams progress', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        onProgress: (done: number, total: number) => void
      ) => {
        onProgress(0, 450);
        onProgress(128, 450);
        onProgress(450, 450);
        return {
          queued: 450,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const result = await handler({ sender } as unknown, 'set-123');

    expect(embeddingHostEnsureStartedMock).toHaveBeenCalledWith({ waitForRunning: true });
    expect(getDatabaseMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
      }),
      expect.any(Object),
      'set-123',
      expect.any(Function),
      expect.objectContaining({
        assertCanContinue: expect.any(Function),
        progressIntervalBatches: 4,
        progressIntervalMs: 250,
      })
    );
    expect(sender.send).toHaveBeenCalledWith(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
      embeddingSetId: 'set-123',
      requestId: expect.stringMatching(/^embedding-backfill:/),
      source: 'manual',
      stage: 'backfill',
      current: 0,
      total: 450,
    });
    expect(sender.send).toHaveBeenLastCalledWith(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
      embeddingSetId: 'set-123',
      requestId: expect.stringMatching(/^embedding-backfill:/),
      source: 'manual',
      stage: 'backfill',
      current: 450,
      total: 450,
    });
    expect(result).toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill schedules manual backfill DB work outside the foreground lane', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    mockDb.query.mockResolvedValue({ rows: [] });
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
        await db.query('SELECT manual_backfill_queue_refill', []);
        return {
          queued: 0,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const { getDesktopDatabaseWorkSchedulerSnapshot } = await import('../../ipc-handlers');

    const result = await handler({ sender } as unknown, {
      embeddingSetId: 'set-123',
      source: 'manual',
    });

    const snapshot = getDesktopDatabaseWorkSchedulerSnapshot();
    expect(snapshot.priorityStats.foreground.completed).toBe(0);
    expect(snapshot.priorityStats.normal.completed).toBe(0);
    expect(snapshot.priorityStats.background.completed).toBe(1);
    expect(result).toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill schedules background indexing backfill DB work as background', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    mockDb.query.mockResolvedValue({ rows: [] });
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
        await db.query('SELECT background_backfill_query', []);
        return {
          queued: 0,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const { getDesktopDatabaseWorkSchedulerSnapshot } = await import('../../ipc-handlers');

    const result = await handler({ sender } as unknown, {
      embeddingSetId: 'set-123',
      source: 'background-indexing',
    });

    const snapshot = getDesktopDatabaseWorkSchedulerSnapshot();
    expect(snapshot.priorityStats.background.completed).toBe(1);
    expect(snapshot.priorityStats.foreground.completed).toBe(0);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      'set-123',
      expect.any(Function),
      expect.objectContaining({
        queueCapacityTimeoutMs: 600_000,
      })
    );
    expect(result).toEqual({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill rejects blank embedding set ids', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, '   ')).rejects.toThrow(
      'Embedding backfill requires a non-empty embeddingSetId.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects malformed embedding set ids', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, '../secret')).rejects.toThrow(
      'Embedding backfill embeddingSetId may only include letters, numbers, dots, underscores, hyphens, and colons.'
    );
    await expect(handler({ sender } as unknown, 'a'.repeat(257))).rejects.toThrow(
      'Embedding backfill embeddingSetId must be at most 256 characters.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill stops progress sends after the renderer is destroyed', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => true),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        onProgress: (done: number, total: number) => void
      ) => {
        onProgress(32, 450);
        return {
          queued: 450,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill does not run maintenance when reclaim is disabled', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'false';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockResolvedValueOnce({
      queued: 8,
      running: 0,
      failed: 0,
      succeeded: 8,
    });

    const result = await handler({ sender } as unknown, 'set-123');

    expect(embeddingHostResetMock).not.toHaveBeenCalled();
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim enabled env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'maybe';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED must be set to one of: "true", "false", "1", or "0" when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim threshold env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '0';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD must be a positive integer when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim interval env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS'] = '0';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS must be a positive integer when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim mode env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'maybe';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE must be set to "reset" when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
    expect(embeddingHostEnsureStartedMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill leaves no in-flight state after invalid reclaim config', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '0';
    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD must be a positive integer when configured.'
    );

    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD');
    enqueueEmbeddingBackfillMock.mockResolvedValueOnce({
      queued: 1,
      running: 0,
      failed: 0,
      succeeded: 1,
    });

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill runs planned maintenance from drain ticks using reset mode', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'true';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '2';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'reset';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { onDrainTick?: (completedSinceLastTick: number) => Promise<void> }
      ) => {
        await options.onDrainTick?.(1);
        await options.onDrainTick?.(1);
        return {
          queued: 2,
          running: 0,
          failed: 0,
          succeeded: 2,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
    expect(embeddingHostResetMock).toHaveBeenCalledTimes(1);
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill defaults to reclaim disabled when no env is provided', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { onDrainTick?: (completedSinceLastTick: number) => Promise<void> }
      ) => {
        await options.onDrainTick?.(1);
        return {
          queued: 1,
          running: 0,
          failed: 0,
          succeeded: 1,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
    expect(embeddingHostResetMock).not.toHaveBeenCalled();
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill resolves cleanly after an explicit cancel-all request', async () => {
    const backfillHandler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    const cancelHandler = handlers.get(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL);
    if (!(backfillHandler && cancelHandler)) {
      throw new Error('required handlers not registered');
    }

    mockDb.query.mockResolvedValue({ rows: [] });

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: {
          assertCanContinue?: () => void | Promise<void>;
        }
      ) => {
        await cancelHandler({} as unknown);
        await options.assertCanContinue?.();
        return {
          queued: 99,
          running: 99,
          failed: 99,
          succeeded: 99,
        };
      }
    );

    await expect(backfillHandler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'Embedding backfill was canceled.'
    );
  });

  it('embedding-host:enqueue-backfill treats reset maintenance interruption as planned', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'true';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '2';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'reset';

    let resolveReset: (() => void) | null = null;
    embeddingHostResetMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveReset = () =>
            resolve({
              state: 'running' as const,
              active: false,
              lastError: null,
              runtimeId: 'embedding-host-runtime',
            });
        })
    );

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: {
          assertCanContinue?: () => void | Promise<void>;
          onDrainTick?: (completedSinceLastTick: number) => Promise<void>;
        }
      ) => {
        if (!(options.assertCanContinue && options.onDrainTick)) {
          throw new Error('Missing maintenance callbacks');
        }
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        const maintenancePromise = options.onDrainTick(2);
        expect(() => {
          void options.assertCanContinue();
        }).not.toThrow();
        resolveReset?.();
        await maintenancePromise;
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'running',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        return {
          queued: 2,
          running: 0,
          failed: 0,
          succeeded: 2,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
    expect(embeddingHostResetMock).toHaveBeenCalledTimes(1);
  });

  it('embedding-host:enqueue-backfill still fails fast on unexpected host stop', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { assertCanContinue?: () => void | Promise<void> }
      ) => {
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        await options.assertCanContinue?.();
        return {
          queued: 0,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'Embedding host stopped while backfill was in progress.'
    );
  });

  it('embedding-host:enqueue-backfill stops progress sends after the renderer frame is disposed', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed');
        })
        .mockImplementation(() => undefined),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        onProgress: (done: number, total: number) => void
      ) => {
        onProgress(0, 450);
        onProgress(128, 450);
        onProgress(450, 450);
        return {
          queued: 450,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const result = await handler({ sender } as unknown, 'set-123');

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });

  it('embedding-host:enqueue-backfill fails fast when the embedding host cannot reach running', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    embeddingHostEnsureStartedMock.mockResolvedValueOnce({
      state: 'error',
      active: false,
      lastError: 'host failed to start',
    });

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow('host failed to start');
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects concurrent submissions for the same set', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    let resolveBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveBackfill = () => resolve(undefined);
        })
    );

    const sender = {
      id: 45,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    const first = handler({ sender } as unknown, 'set-a');
    await expect(handler({ sender } as unknown, 'set-a')).rejects.toThrow(
      'Embedding backfill is already running for set set-a.'
    );
    resolveBackfill?.();
    await first;
  });

  it('embedding-host:enqueue-backfill allows concurrent submissions for different sets', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    let markFirstBackfillStarted: (() => void) | null = null;
    const firstBackfillStarted = new Promise<void>((resolve) => {
      markFirstBackfillStarted = resolve;
    });
    let resolveFirstBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          markFirstBackfillStarted?.();
          resolveFirstBackfill = () =>
            resolve({
              failed: 0,
              queued: 450,
              running: 0,
              succeeded: 0,
            });
        })
    );
    enqueueEmbeddingBackfillMock.mockImplementationOnce(async () => ({
      failed: 0,
      queued: 450,
      running: 0,
      succeeded: 0,
    }));

    const sender = {
      id: 46,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    const first = handler({ sender } as unknown, 'set-a');
    await firstBackfillStarted;
    const second = handler({ sender } as unknown, 'set-b');

    await expect(second).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
    resolveFirstBackfill?.();
    await expect(first).resolves.toEqual({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });
  });
});
