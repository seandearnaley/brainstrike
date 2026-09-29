import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseIntegrityError } from '../../database-integrity-state';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import {
  applyManagedCacheBatchMock,
  closeDatabaseMock,
  createAuthorizedDbEvent,
  createCorruptionError,
  createFakeLiveQueryOwner,
  createLiveHandleMock,
  createWindowWithWebContents,
  currentIntegrityState,
  embeddingHostIsHostWindowMock,
  handlers,
  insertChunksAndEnqueueEmbeddingJobsMock,
  invalidateManagedCacheEntriesByIdentityMock,
  mockDb,
  resetDatabaseIpcHandlerMocks,
  resetLocalDatabaseMock,
} from './ipc-handlers-db-test-fixture';

/**
 * BST-1870: an integrity error at a database IPC entry point CONTAINS the
 * database. It never deletes, replaces or reloads it (`platform-contracts.md`
 * § DATABASE INTEGRITY CONTAINMENT).
 */
describe('database IPC integrity containment', () => {
  beforeEach(async () => {
    await resetDatabaseIpcHandlerMocks();
  });

  it('contains an integrity error in db:query without replacing the database', async () => {
    const queryHandler = handlers.get('db:query');
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(queryHandler && startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }
    const corruption = createCorruptionError();

    // A renderer live query that exists before the error.
    const liveHandle = createLiveHandleMock();
    mockDb.live.query.mockResolvedValueOnce(liveHandle);
    const subscription = (await startHandler(
      createAuthorizedDbEvent(createFakeLiveQueryOwner(701)),
      { query: 'select 1' }
    )) as { id: number };

    // The corrupting query runs while a foreground query waits behind it.
    let rejectCorruptingQuery: ((error: Error) => void) | null = null;
    let markCorruptingQueryStarted: (() => void) | null = null;
    const corruptingQueryStarted = new Promise<void>((resolve) => {
      markCorruptingQueryStarted = resolve;
    });
    mockDb.query.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCorruptingQuery = reject;
          markCorruptingQueryStarted?.();
        })
    );
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'queued' }] });

    const corruptingQuery = queryHandler(createAuthorizedDbEvent(), 'SELECT * FROM file_chunks');
    await corruptingQueryStarted;
    const queuedForegroundQuery = queryHandler(createAuthorizedDbEvent(), 'SELECT queued');
    if (typeof rejectCorruptingQuery !== 'function') {
      throw new Error('Corrupting query did not expose its rejection callback.');
    }
    (rejectCorruptingQuery as (error: Error) => void)(corruption);

    const rejection = await Promise.resolve(corruptingQuery).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DatabaseIntegrityError);
    expect(rejection).toMatchObject({
      cause: corruption,
      detail: { context: 'db:query', reason: 'detected' },
    });
    expect((rejection as Error).message).toContain('SQLSTATE XX001');
    expect((rejection as Error).message).toContain('Nothing was deleted or replaced');
    expect(currentIntegrityState()).toMatchObject({
      context: 'db:query',
      kind: 'contained',
      signal: { sqlstate: 'XX001' },
    });

    // Nothing was replaced: no reset, no close, and foreground work goes on.
    expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
    expect(closeDatabaseMock).not.toHaveBeenCalled();
    await expect(queuedForegroundQuery).resolves.toEqual({ rows: [{ id: 'queued' }] });

    // Background work is paused at the scheduler and never reaches the database.
    const hiddenSender = {
      getOwnerBrowserWindow: vi.fn(() => createWindowWithWebContents({ send: vi.fn() })),
    };
    embeddingHostIsHostWindowMock.mockReturnValueOnce(true);
    const backgroundRejection = await Promise.resolve(
      queryHandler(createAuthorizedDbEvent(hiddenSender), 'SELECT hidden_host', [])
    ).catch((error: unknown) => error);
    expect(backgroundRejection).toBeInstanceOf(DatabaseIntegrityError);
    expect(backgroundRejection).toMatchObject({ detail: { reason: 'background-paused' } });
    expect(mockDb.query).toHaveBeenCalledTimes(2);

    // The live subscription survives and still refreshes.
    expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
    await expect(
      refreshHandler(createAuthorizedDbEvent(), { id: subscription.id })
    ).resolves.toEqual({ success: true });
    expect(liveHandle.refresh).toHaveBeenCalledOnce();
  });

  const OWN_CONTEXT_CASES = [
    {
      args: ['CREATE TABLE probe (id int)'],
      channel: 'db:exec',
      fail: (error: Error) => mockDb.exec.mockRejectedValueOnce(error),
    },
    {
      args: [[{ sql: 'SELECT 1' }], 0],
      channel: 'db:transaction',
      fail: (error: Error) => mockDb.transaction.mockRejectedValueOnce(error),
    },
    {
      args: [{ query: 'select 1' }],
      channel: 'db:live-query:start',
      fail: (error: Error) => mockDb.live.query.mockRejectedValueOnce(error),
    },
    {
      args: [{ changes: [], embeddingSetId: 'set-1' }],
      channel: 'db:managed-cache:apply-batch',
      fail: (error: Error) => applyManagedCacheBatchMock.mockRejectedValueOnce(error),
    },
    {
      args: [{ embeddingSetId: 'set-1', targets: [] }],
      channel: 'db:managed-cache:invalidate-by-identity',
      fail: (error: Error) =>
        invalidateManagedCacheEntriesByIdentityMock.mockRejectedValueOnce(error),
    },
    {
      args: [
        [
          {
            chunkIndex: 0,
            chunkSize: 12,
            chunkType: 'sentence',
            content: 'hello world',
            contentHash: 'chunk-hash',
            createdAt: '2026-09-29T00:00:00.000Z',
            fileRecordId: 'file-1',
            id: 'chunk-1',
            tokenCount: 2,
            updatedAt: '2026-09-29T00:00:00.000Z',
          },
        ],
        'file-1',
        {
          dimensionParameter: null,
          model: 'local::Xenova/all-MiniLM-L6-v2',
          provider: 'local',
          targetDimension: 384,
          targetEmbeddingSetId: 'workspace-index',
        },
      ],
      channel: 'db:chunks:insert-and-enqueue-embedding-jobs',
      fail: (error: Error) => insertChunksAndEnqueueEmbeddingJobsMock.mockRejectedValueOnce(error),
    },
  ] as const;

  it.for(OWN_CONTEXT_CASES)(
    '$channel contains an integrity error under its own context',
    async ({ args, channel, fail }) => {
      const handler = handlers.get(channel);
      const corruption = createCorruptionError();
      fail(corruption);

      const rejection = await Promise.resolve(
        handler?.(createAuthorizedDbEvent(createFakeLiveQueryOwner(702)), ...args)
      ).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(DatabaseIntegrityError);
      expect(rejection).toMatchObject({ cause: corruption });
      expect(currentIntegrityState()).toMatchObject({ context: channel, kind: 'contained' });
      expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
      expect(closeDatabaseMock).not.toHaveBeenCalled();
    }
  );

  it('db:live-query:refresh contains an integrity error and keeps the subscription', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = createLiveHandleMock();
    mockDb.live.query.mockResolvedValueOnce(liveHandle);
    const result = (await startHandler(createAuthorizedDbEvent(createFakeLiveQueryOwner(77)), {
      query: 'select 1',
    })) as { id: number };

    liveHandle.refresh.mockRejectedValueOnce(createCorruptionError());

    const refreshResult = (await refreshHandler(createAuthorizedDbEvent(), {
      id: result.id,
    })) as { message: string; success: boolean };

    expect(refreshResult.success).toBe(false);
    expect(refreshResult.message).toContain('SQLSTATE XX001');
    expect(refreshResult.message).toContain('Nothing was deleted or replaced');
    expect(currentIntegrityState()).toMatchObject({
      context: 'db:live-query:refresh',
      kind: 'contained',
    });
    expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
    expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
    // The subscription is still registered: a later refresh reaches the handle.
    liveHandle.refresh.mockResolvedValueOnce(undefined);
    await expect(refreshHandler(createAuthorizedDbEvent(), { id: result.id })).resolves.toEqual({
      success: true,
    });
  });

  it('db:test contains an integrity error and reports it without replacing the database', async () => {
    const handler = handlers.get('db:test');
    mockDb.query.mockRejectedValueOnce(createCorruptionError());

    const result = (await handler?.(createTrustedInvokeEvent())) as {
      message: string;
      success: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain('Database connection failed: Database integrity error');
    expect(result.message).toContain('SQLSTATE XX001');
    expect(currentIntegrityState()).toMatchObject({ context: 'db:test', kind: 'contained' });
    expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
    expect(closeDatabaseMock).not.toHaveBeenCalled();
  });

  describe('db:clearAll', () => {
    it('contains an integrity error and reports the failure without replacing the database', async () => {
      const handler = handlers.get('db:clearAll');
      mockDb.transaction.mockRejectedValueOnce(createCorruptionError());

      const result = (await handler?.(createAuthorizedDbEvent(), 'CONFIRM_CLEAR_DATABASE')) as {
        deletedChunks: number;
        deletedFiles: number;
        message: string;
        success: boolean;
      };

      expect(result).toMatchObject({ deletedChunks: 0, deletedFiles: 0, success: false });
      expect(result.message).toContain('Database clear failed: Database integrity error');
      expect(result.message).toContain('Nothing was deleted or replaced');
      expect(currentIntegrityState()).toMatchObject({ context: 'db:clearAll', kind: 'contained' });
      expect(resetLocalDatabaseMock).not.toHaveBeenCalled();
      expect(closeDatabaseMock).not.toHaveBeenCalled();
    });
  });
});
