export interface EmbeddingCacheMaintenanceCache {
  evictIfNeeded?: () => Promise<{ needed: boolean; evicted: number; totalEntries: number }>;
  getStats?: () => Promise<{
    newestAccessedAt: Date | null;
    oldestAccessedAt: Date | null;
    totalEntries: number;
    totalHits: number;
  }>;
}

interface EmbeddingCacheMaintenanceLogger {
  readonly log: (msg: string, meta?: unknown) => void;
  readonly warn: (msg: string, meta?: unknown) => void;
}

function serializeCacheDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export class EmbeddingCacheMaintenanceController {
  readonly #cache: EmbeddingCacheMaintenanceCache;
  readonly #logger: EmbeddingCacheMaintenanceLogger;
  readonly #pendingCacheWrites = new Set<Promise<void>>();
  #activeMaintenance: Promise<void> | null = null;
  #cacheWriteGeneration = 0;
  #maintainedGeneration = 0;

  constructor(cache: EmbeddingCacheMaintenanceCache, logger: EmbeddingCacheMaintenanceLogger) {
    this.#cache = cache;
    this.#logger = logger;
  }

  async flushPendingWrites(): Promise<void> {
    if (this.#pendingCacheWrites.size === 0) {
      return;
    }
    await Promise.allSettled([...this.#pendingCacheWrites]);
  }

  trackCacheWrite(write: Promise<number>): void {
    const tracked = write
      .then((stored) => {
        if (stored > 0) {
          this.#cacheWriteGeneration += 1;
        }
      })
      .catch((error: unknown) => {
        this.#logger.warn('Failed to cache embeddings', { error });
      })
      .finally(() => {
        this.#pendingCacheWrites.delete(tracked);
      });
    this.#pendingCacheWrites.add(tracked);
  }

  async run(reason: 'queue-idle'): Promise<void> {
    if (this.#activeMaintenance) {
      await this.#activeMaintenance;
      if (
        this.#pendingCacheWrites.size > 0 ||
        this.#cacheWriteGeneration !== this.#maintainedGeneration
      ) {
        await this.run(reason);
      }
      return;
    }

    const maintenance = this.#runExclusive(reason).finally(() => {
      if (this.#activeMaintenance === maintenance) {
        this.#activeMaintenance = null;
      }
    });
    this.#activeMaintenance = maintenance;
    await maintenance;
  }

  async #runExclusive(reason: 'queue-idle'): Promise<void> {
    await this.flushPendingWrites();
    const generationToMaintain = this.#cacheWriteGeneration;
    if (generationToMaintain === this.#maintainedGeneration) {
      return;
    }

    try {
      const eviction = await this.#cache.evictIfNeeded?.();
      if (eviction) {
        this.#logger.log('embedding_cache_eviction', {
          evicted: eviction.evicted,
          needed: eviction.needed,
          reason,
          totalEntries: eviction.totalEntries,
        });
      }

      const stats = await this.#cache.getStats?.();
      if (stats) {
        this.#logger.log('embedding_cache_stats', {
          newestAccessedAt: serializeCacheDate(stats.newestAccessedAt),
          oldestAccessedAt: serializeCacheDate(stats.oldestAccessedAt),
          reason,
          totalEntries: stats.totalEntries,
          totalHits: stats.totalHits,
        });
      }

      this.#maintainedGeneration = generationToMaintain;
    } catch (error) {
      this.#logger.warn('Embedding cache maintenance failed', { error });
    }
  }
}
