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

import {
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
      databaseWorkScheduler: databaseWorkScheduler as never,
      embeddingHostManager: embeddingHostManager as never,
      flushPendingLiveUpdates,
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
      databaseWorkScheduler: databaseWorkScheduler as never,
      embeddingHostManager: embeddingHostManager as never,
      flushPendingLiveUpdates,
      isBackgrounded,
    });
    unregister();
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL);
    expect(removeHandler).toHaveBeenCalledWith(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
  });
});
