// Minimal Web wrapper for the Phase 4 embedding worker.
// This is not auto-started; call from a user action and pass an IDatabase
// instance (e.g., from DbProvider via usePGliteDatabase()).

import type { IDatabase } from '@brainstrike/db';
import { type EmbeddingWorkerController, startEmbeddingWorker } from '@brainstrike/embeddings';

export async function startEmbeddingWorkerWeb(db: IDatabase): Promise<EmbeddingWorkerController> {
  // On web, the env default may be false; allow explicit runtime start from UI.
  return startEmbeddingWorker({ db, enable: true });
}
