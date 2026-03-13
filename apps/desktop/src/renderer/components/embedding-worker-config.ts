import type { IDatabase } from '@brainstrike/db';
import type { EmbeddingWorkerOptions } from '@brainstrike/embeddings/worker';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('EmbeddingWorkerConfig');
// Keep the hidden host responsive, but avoid the one-job-at-a-time churn that
// creates excessive DB/queue pressure during large backfills.
const DESKTOP_EMBED_CLAIM_BATCH_SIZE = 4;
// Leave a short gap between claimed batches so the hidden host yields without
// stretching backfills into a long sequence of tiny bursts.
const DESKTOP_EMBED_INTER_BATCH_DELAY_MS = 75;

function parsePositiveIntegerEnv(
  name: 'VITE_EMBED_CONCURRENCY' | 'VITE_EMBED_LEASE_MS',
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
  const concurrency = parsePositiveIntegerEnv('VITE_EMBED_CONCURRENCY', 1);
  const leaseMs = parsePositiveIntegerEnv('VITE_EMBED_LEASE_MS', 60_000);
  const modelKey = import.meta.env['VITE_EMBED_MODEL_KEY'];

  return {
    db,
    claimBatchSize: DESKTOP_EMBED_CLAIM_BATCH_SIZE,
    concurrency,
    interBatchDelayMs: DESKTOP_EMBED_INTER_BATCH_DELAY_MS,
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
