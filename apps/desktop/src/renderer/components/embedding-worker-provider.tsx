import { usePGliteDatabase } from '@brainstrike/db';
import { type EmbeddingWorkerController, startEmbeddingWorker } from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';

const logger = createLogger('EmbeddingWorkerProvider');

/**
 * Automatically starts the embedding worker in the renderer process when the database is ready.
 * The worker runs in the browser context where Web Workers (workerpool) are available.
 * This is REQUIRED for desktop - without it, backfill jobs won't be processed.
 */
export function EmbeddingWorkerProvider({ children }: { children: React.ReactNode }) {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);

  useEffect(() => {
    if (!db) {
      return;
    }

    // Start the worker once database is ready
    const startWorker = async () => {
      try {
        logger.info('Starting embedding worker in renderer process...');
        const controller = await startEmbeddingWorker({
          db,
          concurrency: Number(import.meta.env['VITE_EMBED_CONCURRENCY'] ?? 1) || 1,
          leaseMs: Number(import.meta.env['VITE_EMBED_LEASE_MS'] ?? 60000) || 60000,
          modelKey: import.meta.env['VITE_EMBED_MODEL_KEY'] || undefined,
          log: (msg: string, meta?: unknown) => {
            if (meta) {
              logger.info(msg, meta);
            } else {
              logger.info(msg);
            }
          },
        });
        controllerRef.current = controller;
        logger.info('Embedding worker started successfully');
      } catch (error) {
        logger.error('Failed to start embedding worker:', error);
      }
    };

    void startWorker();

    // Cleanup: stop worker when component unmounts
    return () => {
      if (controllerRef.current) {
        logger.info('Stopping embedding worker...');
        void controllerRef.current.stop().then(() => {
          logger.info('Embedding worker stopped');
          controllerRef.current = null;
        });
      }
    };
  }, [db]);

  return <>{children}</>;
}
