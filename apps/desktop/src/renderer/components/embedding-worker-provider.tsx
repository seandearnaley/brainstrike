import { useBrainstrikeDbClient } from '@brainstrike/db';
import {
  type EmbeddingWorkerController,
  POWER_BROADCAST_CHANNEL,
  startEmbeddingWorker,
} from '@brainstrike/embeddings/worker';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef } from 'react';
import { resolveEmbeddingWorkerUrlHref } from '../resolve-embedding-worker-url';

const logger = createLogger('EmbeddingWorkerProvider');

function stopWorker(
  controller: EmbeddingWorkerController,
  message: string,
  completeMessage: string
): void {
  logger.info(message);
  void controller.stop().then(() => {
    logger.info(completeMessage);
  });
}

function logWorkerStartError(error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  logger.error('Failed to start embedding worker', {
    message: errorMessage,
    stack: errorStack,
    name: error instanceof Error ? error.name : 'Unknown',
  });
}

/**
 * Automatically starts the embedding worker in the renderer process when the database is ready.
 * The worker runs in the browser context where Web Workers (workerpool) are available.
 * This is REQUIRED for desktop - without it, backfill jobs won't be processed.
 *
 * The worker uses WebGPU for inference by default (see SimpleEmbeddingService).
 * A keep-alive guard in embedding.worker.ts prevents the GPU device from idling
 * out. In desktop mode this requirement applies to the hidden embedding-host
 * window, not the visible UI window.
 * See: docs/debug-handoff-renderer-crash.md
 */
// Helper to create worker config
function createWorkerConfig(
  db: NonNullable<ReturnType<typeof useBrainstrikeDbClient>>
): Parameters<typeof startEmbeddingWorker>[0] {
  return {
    db,
    concurrency: Number(import.meta.env['VITE_EMBED_CONCURRENCY'] ?? 1) || 1,
    leaseMs: Number(import.meta.env['VITE_EMBED_LEASE_MS'] ?? 60_000) || 60_000,
    modelKey: import.meta.env['VITE_EMBED_MODEL_KEY'] || undefined,
    streamingWorkerUrl: resolveEmbeddingWorkerUrlHref(),
    log: (msg: string, meta?: unknown) => {
      if (meta) {
        logger.info(msg, meta);
      } else {
        logger.info(msg);
      }
    },
    onDownloadProgress: (modelId: string, progress: number) => {
      const store = useModelRegistryStore.getState();
      store.setDownloadProgress(modelId, progress);
      store.setDownloading(modelId, progress < 100);
    },
  };
}

export function EmbeddingWorkerProvider({ children }: { children: React.ReactNode }) {
  const db = useBrainstrikeDbClient();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!db) {
      return;
    }

    let isDisposed = false;

    const startWorker = async () => {
      if (startingRef.current || controllerRef.current) {
        return;
      }

      startingRef.current = true;

      try {
        logger.info('Starting embedding worker in renderer process...');
        const config = createWorkerConfig(db);
        const controller = await startEmbeddingWorker(config);
        if (isDisposed) {
          stopWorker(
            controller,
            'Embedding worker started after provider dispose; stopping stale worker',
            'Stale embedding worker stopped after dispose'
          );
          startingRef.current = false;
          return;
        }
        controllerRef.current = controller;
        logger.info('Embedding worker started successfully');
        startingRef.current = false;
      } catch (error) {
        logWorkerStartError(error);
        startingRef.current = false;
      }
    };

    void startWorker();

    return () => {
      isDisposed = true;
      if (controllerRef.current) {
        const currentController = controllerRef.current;
        controllerRef.current = null;
        stopWorker(currentController, 'Stopping embedding worker...', 'Embedding worker stopped');
      }
    };
  }, [db]);

  // Relay power-state events from the main process to the embedding worker via
  // BroadcastChannel. This pauses the GPU keep-alive during system suspend so
  // stale GPU commands aren't submitted on wake.
  useEffect(() => {
    const powerApi = (
      window as { power?: { onPowerState: (cb: (state: string) => void) => () => void } }
    ).power;
    if (!powerApi) {
      return;
    }

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(POWER_BROADCAST_CHANNEL);
    }

    const cleanup = powerApi.onPowerState((state) => {
      logger.info('Power state change received in renderer', { state });
      if (channel) {
        channel.postMessage(state);
      }
    });

    return () => {
      cleanup();
      channel?.close();
    };
  }, []);

  return <>{children}</>;
}
