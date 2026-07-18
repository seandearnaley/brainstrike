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

const backfillMocks = vi.hoisted(() => ({
  cancelAllDesktopEmbeddingBackfills: vi.fn(),
  cancelDesktopEmbeddingBackfill: vi.fn(),
  getDesktopEmbeddingBackfillsInFlight: vi.fn(() => [{ embeddingSetId: 'set-1' }]),
  resolveEmbeddingBackfillRequest: vi.fn(() => ({
    embeddingHostManager: { id: 'host' },
    embeddingSetId: 'set-1',
  })),
  runDesktopEmbeddingBackfill: vi.fn(async () => ({ enqueued: true })),
}));
const dbMainMocks = vi.hoisted(() => ({
  handleRuntimeCorruption: vi.fn(),
  isCorruptionError: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

vi.mock('../../ipc-embedding-backfill', () => backfillMocks);

// withCorruptionRecovery dynamically imports db-main in its catch path; stub it so an
// errored backfill does not load the real module (and is classified as non-corruption).
vi.mock('../../db-main', () => ({
  handleRuntimeCorruption: dbMainMocks.handleRuntimeCorruption,
  isCorruptionError: dbMainMocks.isCorruptionError,
}));

import {
  EMBEDDING_BACKFILL_CANCELED_MESSAGE,
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
} from '../../embedding-host-shared';
import { registerEmbeddingBackfillIpcHandlers } from '../../ipc-domains/embedding-backfill-ipc';

describe('embedding backfill IPC domain', () => {
  const databaseWorkScheduler = { id: 'scheduler' };
  const embeddingHostManager = { id: 'embedding-host' };
  const flushPendingLiveUpdates = vi.fn();
  const isBackgrounded = vi.fn(() => false);

  beforeEach(() => {
    handlers.clear();
    removeHandler.mockClear();
    vi.clearAllMocks();
    registerEmbeddingBackfillIpcHandlers({
      embeddingHostManager: embeddingHostManager as never,
      flushPendingLiveUpdates,
      getDatabaseWorkScheduler: () => databaseWorkScheduler as never,
      isBackgrounded,
    });
  });

  it('registers cancellation and in-flight backfill handlers', async () => {
    await handlers.get(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL)?.({} as IpcMainInvokeEvent);
    await handlers.get(EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL)?.(
      {} as IpcMainInvokeEvent,
      ' set-1 '
    );
    await expect(
      handlers.get(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL)?.({} as IpcMainInvokeEvent)
    ).resolves.toEqual([{ embeddingSetId: 'set-1' }]);

    expect(backfillMocks.cancelAllDesktopEmbeddingBackfills).toHaveBeenCalled();
    expect(backfillMocks.cancelDesktopEmbeddingBackfill).toHaveBeenCalledWith('set-1');
    expect(backfillMocks.getDesktopEmbeddingBackfillsInFlight).toHaveBeenCalled();
  });

  it('rejects invalid cancellation ids before touching cancellation state', async () => {
    await expect(
      handlers.get(EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, ' ')
    ).rejects.toThrow('Embedding backfill cancellation requires a non-empty embeddingSetId.');
    expect(backfillMocks.cancelDesktopEmbeddingBackfill).not.toHaveBeenCalled();
  });

  it('enqueues through the embedding host and unregisters owned channels', async () => {
    await expect(
      handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, 'set-1')
    ).resolves.toEqual({ enqueued: true });
    expect(backfillMocks.resolveEmbeddingBackfillRequest).toHaveBeenCalledWith(
      'set-1',
      embeddingHostManager
    );
    expect(backfillMocks.runDesktopEmbeddingBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseWorkScheduler,
        flushPendingLiveUpdates,
        isBackgrounded,
      })
    );

    const unregister = registerEmbeddingBackfillIpcHandlers({
      embeddingHostManager: embeddingHostManager as never,
      flushPendingLiveUpdates,
      getDatabaseWorkScheduler: () => databaseWorkScheduler as never,
      isBackgrounded,
    });
    unregister();
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
  });

  it('resolves { canceled: true } for a deliberate cancellation instead of rejecting', async () => {
    // A deliberate cancellation is a benign state. The handler must swallow it into a
    // structured result so Electron's ipcMain.handle does not log "Error occurred in
    // handler" on every background-indexing cancel.
    backfillMocks.runDesktopEmbeddingBackfill.mockRejectedValueOnce(
      new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE)
    );

    await expect(
      handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, 'set-1')
    ).resolves.toEqual({ canceled: true });
  });

  it('still rejects a real backfill failure so it surfaces loudly', async () => {
    backfillMocks.runDesktopEmbeddingBackfill.mockRejectedValueOnce(
      new Error('embedding host exploded')
    );

    await expect(
      handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, 'set-1')
    ).rejects.toThrow('embedding host exploded');
  });

  it('recovers corruption without replaying a stale backfill against the empty database', async () => {
    const corruption = Object.assign(new Error('invalid page in block 42'), { code: 'XX001' });
    backfillMocks.runDesktopEmbeddingBackfill.mockRejectedValueOnce(corruption);
    dbMainMocks.isCorruptionError.mockReturnValueOnce(true);

    await expect(
      handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, 'set-1')
    ).rejects.toThrow(
      'Database corruption was recovered by resetting local index data. Brainstrike is reloading.'
    );

    expect(backfillMocks.runDesktopEmbeddingBackfill).toHaveBeenCalledTimes(1);
    expect(dbMainMocks.handleRuntimeCorruption).toHaveBeenCalledWith(
      EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL
    );
  });

  it('recovers corruption raised after background indexing detaches from IPC', async () => {
    const corruption = Object.assign(new Error('invalid page in block 42'), { code: 'XX001' });

    await expect(
      handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)?.({} as IpcMainInvokeEvent, 'set-1')
    ).resolves.toEqual({ enqueued: true });

    const call = backfillMocks.runDesktopEmbeddingBackfill.mock.calls.at(-1)?.[0] as
      | { onDetachedFailure?: (error: unknown) => Promise<void> }
      | undefined;
    expect(call?.onDetachedFailure).toBeTypeOf('function');
    dbMainMocks.isCorruptionError.mockReturnValueOnce(true);

    await call?.onDetachedFailure?.(corruption);

    expect(dbMainMocks.handleRuntimeCorruption).toHaveBeenCalledWith(
      EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL
    );
  });
});
