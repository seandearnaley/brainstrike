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
// Helper to check if collections exist
async function hasCollections(db: ReturnType<typeof usePGliteDatabase>): Promise<boolean> {
  if (!db) return false;
  const result = await db.query<{ count: number }>('SELECT COUNT(*) as count FROM embedding_sets');
  return (result.rows[0]?.count ?? 0) > 0;
}

// Helper to create worker config
function createWorkerConfig(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>
): Parameters<typeof startEmbeddingWorker>[0] {
  return {
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
  };
}

export function EmbeddingWorkerProvider({ children }: { children: React.ReactNode }) {
  const db = usePGliteDatabase();
  const controllerRef = useRef<EmbeddingWorkerController | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!db) return;

    const startWorker = async () => {
      if (startingRef.current || controllerRef.current) return;

      startingRef.current = true;

      try {
        const collectionsExist = await hasCollections(db);
        if (!collectionsExist) {
          logger.info(
            'No embedding sets found - worker will not start until user creates a collection'
          );
          return;
        }

        logger.info('Starting embedding worker in renderer process...');
        const config = createWorkerConfig(db);
        const controller = await startEmbeddingWorker(config);
        controllerRef.current = controller;
        logger.info('Embedding worker started successfully');
      } catch (error) {
        logger.error('Failed to start embedding worker:', error);
      } finally {
        startingRef.current = false;
      }
    };

    void startWorker();

    const handleCollectionCreated = () => {
      logger.info('Collection created event received - checking if worker needs to start');
      void startWorker();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('brainstrike:embedding-set-updated', handleCollectionCreated);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('brainstrike:embedding-set-updated', handleCollectionCreated);
      }

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
