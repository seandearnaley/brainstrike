import type { IDatabase } from '@brainstrike/db';
import type { EmbeddingWorkerOptions } from '@brainstrike/embeddings/worker';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('EmbeddingWorkerConfig');
// Foreground responsiveness wins over raw indexing throughput in desktop mode.
// Each completed job writes through the main-process PGlite connection, so keep
// background commits small and leave a deliberate gap between claims.
const DESKTOP_EMBED_CLAIM_BATCH_SIZE = 1;
const DESKTOP_EMBED_INTER_BATCH_DELAY_MS = 150;

function parsePositiveIntegerEnv(
  name:
    | 'VITE_EMBED_CLAIM_BATCH_SIZE'
    | 'VITE_EMBED_CONCURRENCY'
    | 'VITE_EMBED_INTER_BATCH_DELAY_MS'
    | 'VITE_EMBED_LEASE_MS',
  fallback: number
): number {
  const raw = import.meta.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return parsed;
}

export function createEmbeddingWorkerConfig(db: IDatabase): EmbeddingWorkerOptions {
  const claimBatchSize = parsePositiveIntegerEnv(
    'VITE_EMBED_CLAIM_BATCH_SIZE',
    DESKTOP_EMBED_CLAIM_BATCH_SIZE
  );
  const concurrency = parsePositiveIntegerEnv('VITE_EMBED_CONCURRENCY', 1);
  const interBatchDelayMs = parsePositiveIntegerEnv(
    'VITE_EMBED_INTER_BATCH_DELAY_MS',
    DESKTOP_EMBED_INTER_BATCH_DELAY_MS
  );
  const leaseMs = parsePositiveIntegerEnv('VITE_EMBED_LEASE_MS', 60_000);
  const modelKey = import.meta.env['VITE_EMBED_MODEL_KEY'];

  return {
    db,
    claimBatchSize,
    concurrency,
    interBatchDelayMs,
    leaseMs,
    ...(modelKey ? { modelKey } : {}),
    log: (msg: string, meta?: unknown) => {
      if (meta) {
        logger.info(msg, meta);
        return;
      }
      logger.info(msg);
    },
    onDownloadProgress: (modelId: string, progress: number) => {
      const store = useModelRegistryStore.getState();
      store.setDownloadProgress(modelId, progress);
      store.setDownloading(modelId, progress < 100);
    },
  };
}
