import type { DatabaseWorkScheduler } from '@brainstrike/db';
import { ipcMain } from 'electron';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import {
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
} from '../embedding-host-shared';
import {
  cancelAllDesktopEmbeddingBackfills,
  cancelDesktopEmbeddingBackfill,
  getDesktopEmbeddingBackfillsInFlight,
  resolveEmbeddingBackfillRequest,
  runDesktopEmbeddingBackfill,
} from '../ipc-embedding-backfill';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';

interface RegisterEmbeddingBackfillIpcHandlersOptions {
  readonly databaseWorkScheduler: DatabaseWorkScheduler;
  readonly embeddingHostManager: EmbeddingHostManager | undefined;
  readonly flushPendingLiveUpdates: () => void;
  readonly isBackgrounded: () => boolean;
}

async function withCorruptionRecovery<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const { isCorruptionError, handleRuntimeCorruption } = await import('../db-main');
    if (!isCorruptionError(error)) {
      throw error;
    }
    await handleRuntimeCorruption(context);
    return await operation();
  }
}

export function registerEmbeddingBackfillIpcHandlers({
  databaseWorkScheduler,
  embeddingHostManager,
  flushPendingLiveUpdates,
  isBackgrounded,
}: RegisterEmbeddingBackfillIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('embeddings', EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL, async () => {
    cancelAllDesktopEmbeddingBackfills();
  });

  registry.registerInvoke(
    'embeddings',
    EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
    async (_event, embeddingSetId: unknown) => {
      if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
        throw new Error('Embedding backfill cancellation requires a non-empty embeddingSetId.');
      }
      cancelDesktopEmbeddingBackfill(embeddingSetId.trim());
    }
  );

  registry.registerInvoke(
    'embeddings',
    EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
    async (event, embeddingSetId: unknown) =>
      withCorruptionRecovery(
        async () =>
          await runDesktopEmbeddingBackfill({
            databaseWorkScheduler,
            event,
            flushPendingLiveUpdates,
            isBackgrounded,
            ...resolveEmbeddingBackfillRequest(embeddingSetId, embeddingHostManager),
          }),
        EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL
      )
  );

  registry.registerInvoke('embeddings', EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL, async () =>
    getDesktopEmbeddingBackfillsInFlight()
  );

  return () => registry.unregisterAll();
}
