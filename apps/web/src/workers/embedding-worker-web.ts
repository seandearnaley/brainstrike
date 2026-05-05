// Minimal Web wrapper for the Phase 4 embedding worker.
// This is not auto-started; call from a user action and pass an IDatabase
// instance (e.g., from DbProvider via usePGliteDatabase()).

import {
  createDatabasePressureController,
  createEmbeddingCacheRepository,
  getDatabaseWorkScheduler,
  type IDatabase,
} from '@brainstrike/db';
import type { EmbeddingWorkerController } from '@brainstrike/embeddings/worker';
import { resolveEmbeddingWorkerUrlHref } from '../resolve-embedding-worker-url';

export async function startEmbeddingWorkerWeb(db: IDatabase): Promise<EmbeddingWorkerController> {
  const { startEmbeddingWorker } = await import('@brainstrike/embeddings/worker');
  const scheduler = getDatabaseWorkScheduler(db);
  if (!scheduler) {
    throw new Error('Web embedding worker requires a scheduled database handle for QoS.');
  }
  const pressureController = createDatabasePressureController({ scheduler });
  // On web, the env default may be false; allow explicit runtime start from UI.
  return startEmbeddingWorker({
    db,
    embeddingCache: createEmbeddingCacheRepository(db),
    enable: true,
    streamingWorkerUrl: resolveEmbeddingWorkerUrlHref(),
    waitForBackgroundPermit: pressureController.waitForBackgroundPermit,
  });
}
