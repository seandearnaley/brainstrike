import { createDatabaseWorkScheduler } from '@brainstrike/db';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueEmbeddingBackfillMock, getDatabaseMock } = vi.hoisted(() => ({
  enqueueEmbeddingBackfillMock: vi.fn(),
  getDatabaseMock: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })) })),
}));

vi.mock('../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../embedding-backfill', () => ({
  enqueueEmbeddingBackfill: enqueueEmbeddingBackfillMock,
}));

import {
  DatabaseIntegrityError,
  getDesktopDatabaseIntegrity,
  resetDesktopDatabaseIntegrityForTests,
} from '../database-integrity-state';
import {
  markDesktopShuttingDown,
  resetDesktopShutdownStateForTests,
} from '../desktop-shutdown-state';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import {
  EMBEDDING_BACKFILL_CANCELED_MESSAGE,
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
} from '../embedding-host-shared';
import {
  cancelDesktopEmbeddingBackfill,
  getDesktopEmbeddingBackfillsInFlight,
  runDesktopEmbeddingBackfill,
} from '../ipc-embedding-backfill';

interface EnqueueOptions {
  assertCanContinue: () => void;
}

function createHostManager(): EmbeddingHostManager {
  const status = {
    active: true,
    lastError: null,
    state: 'running' as const,
  };
  return {
    ensureStarted: vi.fn(async () => status),
    getStatus: vi.fn(() => status),
  } as unknown as EmbeddingHostManager;
}

function createDeadSenderEvent(): IpcMainInvokeEvent {
  // Simulates the renderer that requested the backfill being torn down by a
  // top-level navigation: the IPC rejection it would receive is discarded.
  return {
    sender: {
      isDestroyed: vi.fn(() => true),
      send: vi.fn(),
    },
  } as unknown as IpcMainInvokeEvent;
}

function createLiveSenderEvent(): IpcMainInvokeEvent {
  return {
    sender: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  } as unknown as IpcMainInvokeEvent;
}

function createRunParams(
  embeddingSetId: string,
  source: 'background-indexing' | 'manual' = 'manual',
  options: { dimensionIndexMaintenanceStrategy?: 'regular' | 'concurrent' | null } = {}
) {
  const strategy =
    'dimensionIndexMaintenanceStrategy' in options
      ? (options.dimensionIndexMaintenanceStrategy ?? null)
      : source === 'background-indexing'
        ? 'regular'
        : null;
  return {
    databaseWorkScheduler: createDatabaseWorkScheduler({ foregroundQuietMs: 0 }),
    event: createDeadSenderEvent(),
    flushPendingLiveUpdates: vi.fn(),
    getDimensionIndexMaintenanceStrategy: () => strategy,
    gpuMemoryReclaimConfig: {
      enabled: false,
      itemThreshold: 500,
      minimumIntervalMs: 15_000,
      mode: 'reset' as const,
    },
    hostManager: createHostManager(),
    isBackgrounded: () => true,
    normalizedEmbeddingSetId: embeddingSetId,
    onDetachedFailure: vi.fn(async () => undefined),
    source,
  };
}

describe('desktop embedding backfill termination logging', () => {
  let captured: LogRecord[];
  let removeListener: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    setLogLevel(LogLevel.INFO);
    captured = [];
    removeListener = addLogListener((record) => {
      if (record.scope === 'DesktopEmbeddingBackfillIpc') {
        captured.push(record);
      }
    });
  });

  afterEach(() => {
    removeListener();
  });

  it('logs the cancellation and rethrows when a backfill is canceled mid-run', async () => {
    enqueueEmbeddingBackfillMock.mockImplementation(
      async (
        _db: unknown,
        _jobQueue: unknown,
        embeddingSetId: string,
        _onProgress: unknown,
        options: EnqueueOptions
      ) => {
        // The renderer teardown cancels while the loop is mid-flight.
        cancelDesktopEmbeddingBackfill(embeddingSetId);
        options.assertCanContinue();
      }
    );

    await expect(runDesktopEmbeddingBackfill(createRunParams('set-canceled'))).rejects.toThrow(
      EMBEDDING_BACKFILL_CANCELED_MESSAGE
    );

    const canceled = captured.filter(
      (record) => record.message === 'Desktop embedding backfill canceled'
    );
    expect(canceled).toHaveLength(1);
    expect(canceled[0]?.level).toBe('info');
    expect(canceled[0]?.args).toContainEqual(
      expect.objectContaining({ embeddingSetId: 'set-canceled' })
    );
  });

  it('logs a request-scoped record when a cancel is registered', async () => {
    enqueueEmbeddingBackfillMock.mockImplementation(
      async (
        _db: unknown,
        _jobQueue: unknown,
        embeddingSetId: string,
        _onProgress: unknown,
        options: EnqueueOptions
      ) => {
        cancelDesktopEmbeddingBackfill(embeddingSetId);
        options.assertCanContinue();
      }
    );

    await expect(runDesktopEmbeddingBackfill(createRunParams('set-cancel-log'))).rejects.toThrow(
      EMBEDDING_BACKFILL_CANCELED_MESSAGE
    );

    const cancelRequested = captured.filter(
      (record) => record.message === 'Desktop embedding backfill cancellation requested'
    );
    expect(cancelRequested).toHaveLength(1);
    expect(cancelRequested[0]?.args).toContainEqual(
      expect.objectContaining({ embeddingSetId: 'set-cancel-log' })
    );
  });

  it('does not let a stale cancellation request poison the next backfill for that set', async () => {
    cancelDesktopEmbeddingBackfill('set-stale-cancel');
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: unknown,
        options: EnqueueOptions
      ) => {
        options.assertCanContinue();
      }
    );

    await expect(
      runDesktopEmbeddingBackfill(createRunParams('set-stale-cancel'))
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^embedding-backfill:/),
    });

    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledTimes(1);
    const canceled = captured.filter(
      (record) => record.message === 'Desktop embedding backfill canceled'
    );
    expect(canceled).toHaveLength(0);
  });

  it('classifies a WRAPPED cancellation as canceled, not failed', async () => {
    // Cancellation is tracked authoritatively in the canceled set; the log
    // classification must not depend on the error message text surviving
    // unwrapped through every layer.
    enqueueEmbeddingBackfillMock.mockImplementation(
      async (
        _db: unknown,
        _jobQueue: unknown,
        embeddingSetId: string,
        _onProgress: unknown,
        options: EnqueueOptions
      ) => {
        cancelDesktopEmbeddingBackfill(embeddingSetId);
        try {
          options.assertCanContinue();
        } catch (cause) {
          throw new Error(
            `backfill aborted: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        }
      }
    );

    await expect(
      runDesktopEmbeddingBackfill(createRunParams('set-wrapped-cancel'))
    ).rejects.toThrow('backfill aborted');

    const canceled = captured.filter(
      (record) => record.message === 'Desktop embedding backfill canceled'
    );
    expect(canceled).toHaveLength(1);
    const failed = captured.filter(
      (record) => record.message === 'Desktop embedding backfill failed'
    );
    expect(failed).toHaveLength(0);
  });

  it('logs an error and rethrows when a backfill fails for any other reason', async () => {
    enqueueEmbeddingBackfillMock.mockRejectedValue(new Error('disk exploded'));

    await expect(runDesktopEmbeddingBackfill(createRunParams('set-failed'))).rejects.toThrow(
      'disk exploded'
    );

    const failed = captured.filter(
      (record) => record.message === 'Desktop embedding backfill failed'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe('error');
    expect(failed[0]?.args).toContainEqual(
      expect.objectContaining({ embeddingSetId: 'set-failed', error: 'disk exploded' })
    );
  });

  it('logs a benign INFO (not an error) when the logger thread-stream is torn down', async () => {
    // pino thread-stream throws this when its logger worker ends (e.g. during app
    // shutdown) — a logging-infra artifact, expected teardown, not a real failure.
    enqueueEmbeddingBackfillMock.mockRejectedValue(new Error('the worker is ending'));

    await expect(runDesktopEmbeddingBackfill(createRunParams('set-shutdown'))).rejects.toThrow(
      'the worker is ending'
    );

    expect(
      captured.filter((record) => record.message === 'Desktop embedding backfill failed')
    ).toHaveLength(0);
    const stopped = captured.filter(
      (record) => record.message === 'Desktop embedding backfill stopped (benign teardown)'
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.level).toBe('info');
    expect(stopped[0]?.args).toContainEqual(
      expect.objectContaining({ embeddingSetId: 'set-shutdown' })
    );
  });

  it('logs a real ERROR (not a benign stop) for a mid-session worker crash that is NOT a shutdown', async () => {
    // A genuine embedding-worker crash during normal operation surfaces as
    // "worker terminated" — the broad teardown signature. Outside shutdown this
    // must take the failure branch (logged error + the UI error progress event),
    // not be silenced as a benign stop. (The app is not shutting down here.)
    enqueueEmbeddingBackfillMock.mockRejectedValue(
      new Error('Embedding worker terminated during an active stream')
    );

    await expect(runDesktopEmbeddingBackfill(createRunParams('set-crash'))).rejects.toThrow(
      'Embedding worker terminated during an active stream'
    );

    expect(
      captured.filter(
        (record) => record.message === 'Desktop embedding backfill stopped (benign teardown)'
      )
    ).toHaveLength(0);
    const failed = captured.filter(
      (record) => record.message === 'Desktop embedding backfill failed'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe('error');
    expect(failed[0]?.args).toContainEqual(
      expect.objectContaining({
        embeddingSetId: 'set-crash',
        error: 'Embedding worker terminated during an active stream',
      })
    );
  });

  it('logs completion so a backfill that outlives its requester still leaves a trace', async () => {
    enqueueEmbeddingBackfillMock.mockResolvedValue(undefined);

    await expect(
      runDesktopEmbeddingBackfill(createRunParams('set-completed'))
    ).resolves.toMatchObject({ requestId: expect.any(String) });

    const completed = captured.filter(
      (record) => record.message === 'Desktop embedding backfill completed'
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.args).toContainEqual(
      expect.objectContaining({ embeddingSetId: 'set-completed' })
    );
  });

  it('attaches duplicate background-indexing submissions to the in-flight backfill', async () => {
    let resolveBackfillStarted: (() => void) | null = null;
    const backfillStarted = new Promise<void>((resolve) => {
      resolveBackfillStarted = resolve;
    });
    let resolveBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveBackfillStarted?.();
          resolveBackfill = resolve;
        })
    );

    const first = runDesktopEmbeddingBackfill(
      createRunParams('set-background-attach', 'background-indexing')
    );
    await backfillStarted;
    const second = await runDesktopEmbeddingBackfill(
      createRunParams('set-background-attach', 'background-indexing')
    );

    expect(second.requestId).toMatch(/^background-indexing-backfill:/);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledTimes(1);
    const finishBackfill = resolveBackfill as (() => void) | null;
    if (!finishBackfill) {
      throw new Error('Expected the background backfill to be pending.');
    }
    finishBackfill();
    await first;
  });

  it('returns immediately after scheduling a background-indexing backfill', async () => {
    let resolveBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveBackfill = resolve;
        })
    );

    await expect(
      runDesktopEmbeddingBackfill(
        createRunParams('set-background-immediate', 'background-indexing')
      )
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      'set-background-immediate',
      expect.any(Function),
      expect.objectContaining({
        dimensionIndexMaintenanceStrategy: 'regular',
        rebuildDimensionIndexOnCompletion: false,
      })
    );

    const finishBackfill = resolveBackfill as (() => void) | null;
    if (!finishBackfill) {
      throw new Error('Expected the background backfill to be pending.');
    }
    finishBackfill();
  });

  it('rejects background-indexing backfill when the dimension index strategy is unavailable', async () => {
    await expect(
      runDesktopEmbeddingBackfill(
        createRunParams('set-background-no-strategy', 'background-indexing', {
          dimensionIndexMaintenanceStrategy: null,
        })
      )
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });

    await vi.waitFor(() => {
      expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
      const failed = captured.filter(
        (record) => record.message === 'Desktop embedding backfill failed'
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.args).toContainEqual(
        expect.objectContaining({
          embeddingSetId: 'set-background-no-strategy',
          error:
            'Background indexing backfill requires dimension index maintenance strategy from startup capability probe.',
        })
      );
    });
  });

  it('emits a terminal error progress event for detached background-indexing failures', async () => {
    const event = createLiveSenderEvent();
    enqueueEmbeddingBackfillMock.mockRejectedValueOnce(new Error('metadata missing'));

    await expect(
      runDesktopEmbeddingBackfill({
        ...createRunParams('set-background-failed', 'background-indexing'),
        event,
      })
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });

    await vi.waitFor(() => {
      expect(event.sender.send).toHaveBeenCalledWith(
        EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
        expect.objectContaining({
          current: 0,
          embeddingSetId: 'set-background-failed',
          message: 'metadata missing',
          source: 'background-indexing',
          stage: 'error',
          total: 0,
        })
      );
    });
  });

  it('routes detached background-indexing failures to the owning containment boundary', async () => {
    const corruption = Object.assign(new Error('invalid page in block 42'), { code: 'XX001' });
    const onDetachedFailure = vi.fn(async () => undefined);
    enqueueEmbeddingBackfillMock.mockRejectedValueOnce(corruption);

    await expect(
      runDesktopEmbeddingBackfill({
        ...createRunParams('set-background-corrupt', 'background-indexing'),
        onDetachedFailure,
      })
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });

    await vi.waitFor(() => {
      expect(onDetachedFailure).toHaveBeenCalledOnce();
      expect(onDetachedFailure).toHaveBeenCalledWith(corruption);
    });
  });

  it('emits a terminal complete progress event after detached background-indexing backfill resolves', async () => {
    const event = createLiveSenderEvent();
    let resolveBackfillStarted: (() => void) | null = null;
    const backfillStarted = new Promise<void>((resolve) => {
      resolveBackfillStarted = resolve;
    });
    let resolveBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (_db: unknown, _jobQueue: unknown, _embeddingSetId: string, onProgress: unknown) => {
        (onProgress as (done: number, total: number) => void)(1, 1);
        resolveBackfillStarted?.();
        await new Promise<void>((resolve) => {
          resolveBackfill = resolve;
        });
      }
    );

    await expect(
      runDesktopEmbeddingBackfill({
        ...createRunParams('set-background-completed', 'background-indexing'),
        event,
      })
    ).resolves.toMatchObject({
      requestId: expect.stringMatching(/^background-indexing-backfill:/),
    });
    await backfillStarted;
    expect(event.sender.send).not.toHaveBeenCalledWith(
      EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
      expect.objectContaining({ stage: 'complete' })
    );

    const finishBackfill = resolveBackfill as (() => void) | null;
    if (!finishBackfill) {
      throw new Error('Expected the background backfill to be pending.');
    }
    finishBackfill();

    await vi.waitFor(() => {
      expect(event.sender.send).toHaveBeenCalledWith(
        EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
        expect.objectContaining({
          current: 1,
          embeddingSetId: 'set-background-completed',
          source: 'background-indexing',
          stage: 'complete',
          total: 1,
        })
      );
    });
  });

  it('delivers terminal errors to duplicate background-indexing attachers when the original sender is gone', async () => {
    const originalEvent = createDeadSenderEvent();
    const attachedEvent = createLiveSenderEvent();
    let resolveBackfillStarted: (() => void) | null = null;
    const backfillStarted = new Promise<void>((resolve) => {
      resolveBackfillStarted = resolve;
    });
    let rejectBackfill: ((error: Error) => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (_db: unknown, _jobQueue: unknown, _embeddingSetId: string, onProgress: unknown) => {
        (onProgress as (done: number, total: number) => void)(1, 1);
        resolveBackfillStarted?.();
        await new Promise<void>((_resolve, reject) => {
          rejectBackfill = reject;
        });
      }
    );

    const first = await runDesktopEmbeddingBackfill({
      ...createRunParams('set-background-reattach', 'background-indexing'),
      event: originalEvent,
    });
    await backfillStarted;
    const second = await runDesktopEmbeddingBackfill({
      ...createRunParams('set-background-reattach', 'background-indexing'),
      event: attachedEvent,
    });

    expect(second.requestId).toBe(first.requestId);
    const failBackfill = rejectBackfill as ((error: Error) => void) | null;
    if (!failBackfill) {
      throw new Error('Expected the background backfill to be pending.');
    }
    failBackfill(new Error('drain failed'));

    await vi.waitFor(() => {
      expect(attachedEvent.sender.send).toHaveBeenCalledWith(
        EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
        expect.objectContaining({
          current: 1,
          embeddingSetId: 'set-background-reattach',
          message: 'drain failed',
          requestId: first.requestId,
          source: 'background-indexing',
          stage: 'error',
          total: 1,
        })
      );
    });
  });
});

describe('desktop embedding backfill admission during shutdown', () => {
  afterEach(() => {
    resetDesktopShutdownStateForTests();
    vi.clearAllMocks();
  });

  it('refuses a new backfill once graceful shutdown has begun without starting the host', async () => {
    markDesktopShuttingDown();
    const params = createRunParams('set-shutdown', 'background-indexing');

    await runDesktopEmbeddingBackfill(params);
    await vi.waitFor(() => {
      expect(params.onDetachedFailure).toHaveBeenCalledOnce();
    });

    // Starting the host here recreates a hidden renderer that the shutdown
    // sequence is about to dispose; the job rows stay durable for next launch.
    expect(params.hostManager.ensureStarted).not.toHaveBeenCalled();
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
    expect(params.onDetachedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('shutting down') })
    );
  });
});

describe('desktop embedding backfill admission during database integrity containment', () => {
  beforeEach(() => {
    resetDesktopDatabaseIntegrityForTests();
  });

  afterEach(() => {
    resetDesktopDatabaseIntegrityForTests();
    vi.clearAllMocks();
  });

  it.for(['background-indexing', 'manual'] as const)(
    'refuses a new %s backfill with background-paused before starting the host',
    async (source) => {
      getDesktopDatabaseIntegrity().contain('db:query', {
        message: 'invalid page in block 3',
        sqlstate: 'XX001',
      });
      const params = createRunParams('set-contained', source);

      const rejection = await runDesktopEmbeddingBackfill(params).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(DatabaseIntegrityError);
      expect((rejection as DatabaseIntegrityError).detail.reason).toBe('background-paused');
      expect(params.hostManager.ensureStarted).not.toHaveBeenCalled();
      expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
      expect(getDesktopEmbeddingBackfillsInFlight()).toEqual([]);
      expect(params.onDetachedFailure).not.toHaveBeenCalled();
    }
  );

  it('admits a backfill again after the database is replaced', async () => {
    const integrity = getDesktopDatabaseIntegrity();
    integrity.contain('db:query', { message: 'invalid page in block 3', sqlstate: 'XX001' });
    integrity.markDatabaseReplaced('factory-reset');
    enqueueEmbeddingBackfillMock.mockResolvedValue(undefined);
    const params = createRunParams('set-replaced');

    await runDesktopEmbeddingBackfill(params);

    expect(params.hostManager.ensureStarted).toHaveBeenCalledOnce();
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledOnce();
  });
});
