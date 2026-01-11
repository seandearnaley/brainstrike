import { usePGliteDatabase } from '@brainstrike/db';
import { type EmbeddingWorkerController, startEmbeddingWorker } from '@brainstrike/embeddings';
import { useModelRegistryStore } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';

const logger = createLogger('EmbeddingWorkerProvider');

/**
 * Automatically starts the embedding worker in the renderer process when the database is ready.
 * The worker runs in the browser context where Web Workers (workerpool) are available.
 * This is REQUIRED for desktop - without it, backfill jobs won't be processed.
 */
// Helper to create worker config
function createWorkerConfig(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>
): Parameters<typeof startEmbeddingWorker>[0] {
  return {
    db,
    concurrency: Number(import.meta.env['VITE_EMBED_CONCURRENCY'] ?? 1) || 1,
    leaseMs: Number(import.meta.env['VITE_EMBED_LEASE_MS'] ?? 60_000) || 60_000,
    modelKey: import.meta.env['VITE_EMBED_MODEL_KEY'] || undefined,
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
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!db) {
      return;
    }

    const startWorker = async () => {
      if (startingRef.current || controllerRef.current) {
        return;
      }

      startingRef.current = true;

      try {
        logger.info('Starting embedding worker in renderer process...');
        const config = createWorkerConfig(db);
        const controller = await startEmbeddingWorker(config);
        controllerRef.current = controller;
        logger.info('Embedding worker started successfully');
      } catch (error) {
        // Error objects don't serialize to JSON - extract message and stack explicitly
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error('Failed to start embedding worker', {
          message: errorMessage,
          stack: errorStack,
          name: error instanceof Error ? error.name : 'Unknown',
        });
      } finally {
        startingRef.current = false;
      }
    };

    void startWorker();

    return () => {
      if (controllerRef.current) {
        logger.info('Stopping embedding worker...');
        const currentController = controllerRef.current;
        controllerRef.current = null;
        void currentController.stop().then(() => {
          logger.info('Embedding worker stopped');
        });
      }
    };
  }, [db]);

  return <>{children}</>;
}
