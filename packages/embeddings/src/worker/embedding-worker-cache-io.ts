import type { CachedEmbedding, EmbeddingCacheInterface } from './embedding-cache-types';

export interface CacheableLoadedChunkItem {
  chunk: {
    contentHash: string;
  };
}

export interface EmbeddingWorkerCacheIoLogger {
  debug: (message: string, meta?: unknown) => void;
}

export async function lookupCacheHits<TItem extends CacheableLoadedChunkItem>(
  cache: EmbeddingCacheInterface | undefined,
  items: TItem[],
  modelKey: string,
  logger: EmbeddingWorkerCacheIoLogger
): Promise<Map<string, CachedEmbedding>> {
  if (!cache) {
    return new Map();
  }

  const requests = items.map((item) => ({
    contentHash: item.chunk.contentHash,
    modelKey,
  }));
  const hits = await cache.getBatch(requests);
  logger.debug('Cache lookup complete', {
    requested: items.length,
    hits: hits.size,
    modelKey,
  });
  return hits;
}

export function filterCacheMisses<TItem extends CacheableLoadedChunkItem>(
  items: TItem[],
  cacheHits: Map<string, CachedEmbedding>,
  modelKey: string
): TItem[] {
  return items.filter((item) => {
    const cacheKey = `${item.chunk.contentHash}:${modelKey}`;
    return !cacheHits.has(cacheKey);
  });
}

export function storeToCacheAsync<TItem extends CacheableLoadedChunkItem>(
  cache: EmbeddingCacheInterface | undefined,
  items: TItem[],
  embeddings: number[][],
  modelKey: string,
  dimensions: number,
  trackCacheWrite: (write: Promise<number>) => void
): void {
  if (!cache || embeddings.length === 0) {
    return;
  }

  const entries = items
    .map((item, idx) => {
      const embedding = embeddings[idx];
      return embedding
        ? { contentHash: item.chunk.contentHash, modelKey, embedding, dimensions }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  trackCacheWrite(cache.setBatch(entries));
}

export function reconstructResults<TItem extends CacheableLoadedChunkItem>(
  items: TItem[],
  cacheHits: Map<string, CachedEmbedding>,
  generated: number[][],
  modelKey: string
): number[][] {
  const results: number[][] = [];
  let generatedIndex = 0;
  for (const item of items) {
    const cacheKey = `${item.chunk.contentHash}:${modelKey}`;
    const cached = cacheHits.get(cacheKey);
    if (cached) {
      results.push(cached.embedding);
    } else {
      const embedding = generated[generatedIndex++];
      if (!embedding) {
        throw new Error(`Missing generated embedding at index ${generatedIndex - 1}`);
      }
      results.push(embedding);
    }
  }
  return results;
}
