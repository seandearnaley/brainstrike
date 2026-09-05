import type { DatabaseWorkScheduler, DimensionIndexMaintenanceStrategy } from '@brainstrike/db';
import { ipcMain } from 'electron';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import {
  EMBEDDING_BACKFILL_CANCELED_MESSAGE,
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
import {
  handleRuntimeDatabaseCorruption,
  type RuntimeDatabaseCorruptionHandler,
  recoverRuntimeDatabaseCorruption,
} from './runtime-database-corruption';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

interface RegisterEmbeddingBackfillIpcHandlersOptions {
  readonly embeddingHostManager: EmbeddingHostManager | undefined;
  readonly flushPendingLiveUpdates: () => void;
  readonly getDatabaseWorkScheduler: () => DatabaseWorkScheduler;
  readonly getDimensionIndexMaintenanceStrategy?: () => DimensionIndexMaintenanceStrategy | null;
  readonly isBackgrounded: () => boolean;
  readonly onRuntimeCorruption?: RuntimeDatabaseCorruptionHandler;
}

async function withCorruptionRecovery<T>(
  operation: () => Promise<T>,
  context: string,
  onRuntimeCorruption?: RuntimeDatabaseCorruptionHandler
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const { isCorruptionError } = await import('../db-main');
    if (!isCorruptionError(error)) {
      throw error;
    }
    return recoverRuntimeDatabaseCorruption(context, onRuntimeCorruption);
  }
}

async function handleDetachedFailure(
  error: unknown,
  context: string,
  onRuntimeCorruption?: RuntimeDatabaseCorruptionHandler
): Promise<void> {
  const { isCorruptionError } = await import('../db-main');
  if (!isCorruptionError(error)) {
    return;
  }
  await handleRuntimeDatabaseCorruption(context, onRuntimeCorruption);
}

export function registerEmbeddingBackfillIpcHandlers({
  embeddingHostManager,
  flushPendingLiveUpdates,
  getDatabaseWorkScheduler,
  getDimensionIndexMaintenanceStrategy,
  isBackgrounded,
  onRuntimeCorruption,
}: RegisterEmbeddingBackfillIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'embeddings',
    EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => {
      cancelAllDesktopEmbeddingBackfills();
    }
  );

  registry.registerUnauthenticatedInvoke(
    'embeddings',
    EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, embeddingSetId: unknown) => {
      if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
        throw new Error('Embedding backfill cancellation requires a non-empty embeddingSetId.');
      }
      cancelDesktopEmbeddingBackfill(embeddingSetId.trim());
    }
  );

  registry.registerUnauthenticatedInvoke(
    'embeddings',
    EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async (event, embeddingSetId: unknown) => {
      try {
        return await withCorruptionRecovery(
          async () =>
            await runDesktopEmbeddingBackfill({
              databaseWorkScheduler: getDatabaseWorkScheduler(),
              event,
              flushPendingLiveUpdates,
              ...(getDimensionIndexMaintenanceStrategy
                ? { getDimensionIndexMaintenanceStrategy }
                : {}),
              isBackgrounded,
              ...resolveEmbeddingBackfillRequest(embeddingSetId, embeddingHostManager),
              onDetachedFailure: async (error: unknown) =>
                await handleDetachedFailure(
                  error,
                  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
                  onRuntimeCorruption
                ),
            }),
          EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
          onRuntimeCorruption
        );
      } catch (error) {
        // A deliberate cancellation is a benign STATE, not a handler failure.
        // runDesktopEmbeddingBackfill still throws it (its contract is unchanged)
        // and already logs the cancellation at info level; here we resolve a
        // structured { canceled: true } so Electron's ipcMain.handle does not
        // surface it as "Error occurred in handler". Every other error — including
        // corruption that survived recovery — still rejects and is logged loudly.
        if (error instanceof Error && error.message === EMBEDDING_BACKFILL_CANCELED_MESSAGE) {
          return { canceled: true } as const;
        }
        throw error;
      }
    }
  );

  registry.registerUnauthenticatedInvoke(
    'embeddings',
    EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
    UNAUTHENTICATED_SENDER_POLICY,
    async () => getDesktopEmbeddingBackfillsInFlight()
  );

  return () => registry.unregisterAll();
}
