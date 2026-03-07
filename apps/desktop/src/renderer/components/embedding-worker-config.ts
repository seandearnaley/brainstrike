import type { IDatabase } from '@brainstrike/db';
import type { EmbeddingWorkerOptions } from '@brainstrike/embeddings';
import { useModelRegistryStore } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('EmbeddingWorkerConfig');

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
    concurrency,
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
