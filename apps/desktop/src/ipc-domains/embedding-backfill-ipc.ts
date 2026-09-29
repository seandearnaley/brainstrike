import type { DatabaseWorkScheduler, DimensionIndexMaintenanceStrategy } from '@brainstrike/db';
import type { DatabaseIntegrityContext } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { containDatabaseIntegrityError } from '../database-integrity-state';
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

// The channel constant is only a template-literal type; the integrity context is the literal.
// The unit test pins the two equal.
const ENQUEUE_BACKFILL_INTEGRITY_CONTEXT =
  'embedding-host:enqueue-backfill' satisfies DatabaseIntegrityContext;

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
}

/** An integrity error contains the database and rejects the call; nothing is replaced or retried. */
async function withIntegrityContainment<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw containDatabaseIntegrityError(ENQUEUE_BACKFILL_INTEGRITY_CONTEXT, error) ?? error;
  }
}

/** The IPC call already resolved, so a detached failure can only contain, never reject. */
async function containDetachedFailure(error: unknown): Promise<void> {
  containDatabaseIntegrityError(ENQUEUE_BACKFILL_INTEGRITY_CONTEXT, error);
}

export function registerEmbeddingBackfillIpcHandlers({
  embeddingHostManager,
  flushPendingLiveUpdates,
  getDatabaseWorkScheduler,
  getDimensionIndexMaintenanceStrategy,
  isBackgrounded,
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
        return await withIntegrityContainment(
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
              onDetachedFailure: containDetachedFailure,
            })
        );
      } catch (error) {
        // A deliberate cancellation is a benign STATE, not a handler failure.
        // runDesktopEmbeddingBackfill still throws it (its contract is unchanged)
        // and already logs the cancellation at info level; here we resolve a
        // structured { canceled: true } so Electron's ipcMain.handle does not
        // surface it as "Error occurred in handler". Every other error — including
        // a contained integrity error — still rejects and is logged loudly.
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
