/**
 * Drizzle-based Embedding Cache Repository (BST-170)
 *
 * Content-level embedding cache keyed by (contentHash, modelKey).
 * Enables reuse of embeddings when identical content appears in multiple chunks.
 *
 * Cache semantics:
 * - get(): Returns cached embedding and updates access time (LRU tracking)
 * - set(): Upserts embedding, resets access time on collision
 * - evictOldest(): Removes entries by accessedAt for LRU eviction
 *
 * Batch operation limits:
 * - getBatch/setBatch: Max 100 entries per call (MAX_BATCH_SIZE)
 * - Larger batches should be chunked by the caller
 *
 * Eviction strategy:
 * - LRU (Least Recently Used) based on accessedAt timestamp
 * - No automatic TTL - call evictOldest() manually or via background job
 * - Recommended eviction threshold: evict when totalEntries > MAX_CACHE_ENTRIES
 */

import { createLogger, generateUUID } from '@brainstrike/utils';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { type EmbeddingCacheEntry, embeddingCache } from '../../schema/index.js';

/**
 * Maximum batch size for getBatch/setBatch operations.
 * Larger batches may create excessively long SQL strings.
 * Operations automatically chunk larger requests.
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Threshold for alerting on fire-and-forget operation failures.
 * When cumulative failures reach multiples of this threshold, an error log is emitted
 * instead of a warning to trigger alerting systems.
 */
export const FAILURE_ALERT_THRESHOLD = 100;

/**
 * Recommended maximum cache entries before triggering eviction.
 * This is a guideline - actual limits depend on available memory.
 */
export const RECOMMENDED_MAX_CACHE_ENTRIES = 100_000;

type DrizzleDb = PgliteDatabase;

/**
 * Result from cache lookup - includes hit/miss metadata
 */
export type EmbeddingCacheLookupResult =
  | {
      hit: true;
      entry: EmbeddingCacheEntry;
    }
  | {
      hit: false;
      entry: null;
    };

/**
 * Cache statistics for monitoring and eviction decisions
 */
export interface EmbeddingCacheStats {
  /** Newest entry timestamp */
  newestAccessedAt: Date | null;
  /** Oldest entry timestamp */
  oldestAccessedAt: Date | null;
  /** Total entries in cache */
  totalEntries: number;
  /** Total cache hits (sum of accessCount) */
  totalHits: number;
}

/**
 * Batch lookup request
 */
export interface BatchLookupRequest {
  contentHash: string;
  modelKey: string;
}

/**
 * Batch lookup result
 */
export type BatchLookupResult = Map<string, EmbeddingCacheEntry>;

/**
 * Metrics for monitoring fire-and-forget operations
 */
export interface EmbeddingCacheMetrics {
  /** Count of failed access time updates */
  failedAccessTimeUpdates: number;
  /** Count of failed batch access time updates */
  failedBatchAccessTimeUpdates: number;
}

export class DrizzleEmbeddingCacheRepository {
  private readonly logger = createLogger('DrizzleEmbeddingCacheRepository');
  /** Metrics for monitoring fire-and-forget operations */
  private readonly metrics: EmbeddingCacheMetrics = {
    failedAccessTimeUpdates: 0,
    failedBatchAccessTimeUpdates: 0,
  };

  constructor(private readonly db: DrizzleDb) {}

  /**
   * Get metrics for monitoring fire-and-forget operations.
   * Useful for production monitoring and alerting.
   */
  getMetrics(): EmbeddingCacheMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics counters.
   */
  resetMetrics(): void {
    this.metrics.failedAccessTimeUpdates = 0;
    this.metrics.failedBatchAccessTimeUpdates = 0;
  }

  /**
   * Look up a cached embedding by content hash and model key.
   * Updates access time on hit for LRU tracking.
   *
   * @param contentHash - SHA-256 hash of the content
   * @param modelKey - Composite model key (e.g., "local::all-MiniLM-L6-v2")
   * @returns Cache entry if found, null otherwise
   */
  async get(contentHash: string, modelKey: string): Promise<EmbeddingCacheLookupResult> {
    const [row] = await this.db
      .select()
      .from(embeddingCache)
      .where(
        and(eq(embeddingCache.contentHash, contentHash), eq(embeddingCache.modelKey, modelKey))
      );

    if (!row) {
      return { hit: false, entry: null };
    }

    // Update access time and increment access count (fire-and-forget)
    // This is done asynchronously to not slow down cache lookups
    this.updateAccessTime(row.id).catch((error) => {
      this.metrics.failedAccessTimeUpdates++;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Alert if failure rate exceeds threshold (triggers error-level logging)
      if (this.metrics.failedAccessTimeUpdates % FAILURE_ALERT_THRESHOLD === 0) {
        this.logger.error('Cache access time update failures exceeded threshold', {
          totalFailures: this.metrics.failedAccessTimeUpdates,
          threshold: FAILURE_ALERT_THRESHOLD,
          lastError: errorMsg,
        });
      } else {
        this.logger.warn('Failed to update cache access time', {
          id: row.id,
          error: errorMsg,
          totalFailures: this.metrics.failedAccessTimeUpdates,
        });
      }
    });

    return { hit: true, entry: row };
  }

  /**
   * Batch lookup for multiple content hashes with the same model key.
   * More efficient than individual lookups when processing batches.
   *
   * Note: Automatically chunks large batches using MAX_BATCH_SIZE (100).
   *
   * @param requests - Array of (contentHash, modelKey) pairs to look up
   * @returns Map of "contentHash:modelKey" -> entry for hits only
   */
  async getBatch(requests: BatchLookupRequest[]): Promise<BatchLookupResult> {
    if (requests.length === 0) {
      return new Map();
    }

    // Auto-chunk large batches to prevent excessively long SQL strings
    if (requests.length > MAX_BATCH_SIZE) {
      this.logger.debug('getBatch auto-chunking large batch', {
        batchSize: requests.length,
        chunkSize: MAX_BATCH_SIZE,
        chunks: Math.ceil(requests.length / MAX_BATCH_SIZE),
      });

      const result = new Map<string, EmbeddingCacheEntry>();
      for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
        const chunk = requests.slice(i, i + MAX_BATCH_SIZE);
        const chunkResult = await this.getBatchInternal(chunk);
        for (const [key, entry] of chunkResult) {
          result.set(key, entry);
        }
      }
      return result;
    }

    return this.getBatchInternal(requests);
  }

  /**
   * Internal batch lookup implementation (assumes batch is within size limits).
   */
  private async getBatchInternal(requests: BatchLookupRequest[]): Promise<BatchLookupResult> {
    // Group by model key for more efficient queries
    const byModelKey = new Map<string, string[]>();
    for (const req of requests) {
      const hashes = byModelKey.get(req.modelKey) ?? [];
      hashes.push(req.contentHash);
      byModelKey.set(req.modelKey, hashes);
    }

    const result = new Map<string, EmbeddingCacheEntry>();
    const idsToUpdate: string[] = [];

    // Query each model key group
    for (const [modelKey, contentHashes] of byModelKey) {
      // Use Drizzle's inArray for type-safe parameterized queries
      const rows = await this.db
        .select()
        .from(embeddingCache)
        .where(
          and(
            eq(embeddingCache.modelKey, modelKey),
            inArray(embeddingCache.contentHash, contentHashes)
          )
        );

      for (const row of rows) {
        const key = `${row.contentHash}:${row.modelKey}`;
        result.set(key, row);
        idsToUpdate.push(row.id);
      }
    }

    // Batch update access times (fire-and-forget)
    if (idsToUpdate.length > 0) {
      this.batchUpdateAccessTime(idsToUpdate).catch((error) => {
        this.metrics.failedBatchAccessTimeUpdates++;
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Alert if failure rate exceeds threshold (triggers error-level logging)
        if (this.metrics.failedBatchAccessTimeUpdates % FAILURE_ALERT_THRESHOLD === 0) {
          this.logger.error('Batch cache access time update failures exceeded threshold', {
            totalFailures: this.metrics.failedBatchAccessTimeUpdates,
            threshold: FAILURE_ALERT_THRESHOLD,
            lastError: errorMsg,
            lastBatchSize: idsToUpdate.length,
          });
        } else {
          this.logger.warn('Failed to batch update cache access times', {
            count: idsToUpdate.length,
            error: errorMsg,
            totalFailures: this.metrics.failedBatchAccessTimeUpdates,
          });
        }
      });
    }

    this.logger.debug('Batch cache lookup completed', {
      requested: requests.length,
      hits: result.size,
      misses: requests.length - result.size,
    });

    return result;
  }

  /**
   * Store an embedding in the cache.
   * Uses upsert semantics - updates access time if entry already exists.
   *
   * @param contentHash - SHA-256 hash of the content
   * @param modelKey - Composite model key
   * @param embedding - The embedding vector
   * @param dimensions - Vector dimensions (for validation)
   * @returns The created or updated cache entry
   */
  async set(
    contentHash: string,
    modelKey: string,
    embedding: number[],
    dimensions: number
  ): Promise<EmbeddingCacheEntry> {
    const id = generateUUID();
    const now = new Date();

    // Validate embedding dimensions match
    if (embedding.length !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`
      );
    }

    // Use INSERT ... ON CONFLICT for upsert
    const [row] = await this.db
      .insert(embeddingCache)
      .values({
        id,
        contentHash,
        modelKey,
        embedding,
        dimensions,
        createdAt: now,
        accessedAt: now,
        accessCount: 1,
      })
      .onConflictDoUpdate({
        target: [embeddingCache.contentHash, embeddingCache.modelKey],
        set: {
          // On conflict, update access time and increment count
          accessedAt: now,
          accessCount: sql`${embeddingCache.accessCount} + 1`,
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to cache embedding for ${contentHash}:${modelKey}`);
    }

    return row;
  }

  /**
   * Batch store multiple embeddings.
   * More efficient than individual inserts for batch operations.
   *
   * Note: Automatically chunks large batches using MAX_BATCH_SIZE (100).
   *
   * @param entries - Array of entries to store
   * @returns Number of entries stored/updated
   */
  async setBatch(
    entries: Array<{
      contentHash: string;
      modelKey: string;
      embedding: number[];
      dimensions: number;
    }>
  ): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }

    const now = new Date();
    let stored = 0;

    // Process in chunks to avoid query size limits
    for (let i = 0; i < entries.length; i += MAX_BATCH_SIZE) {
      const chunk = entries.slice(i, i + MAX_BATCH_SIZE);

      const values = chunk.map((entry) => {
        // Validate dimensions
        if (entry.embedding.length !== entry.dimensions) {
          throw new Error(
            `Embedding dimension mismatch for ${entry.contentHash}: ` +
              `expected ${entry.dimensions}, got ${entry.embedding.length}`
          );
        }

        return {
          id: generateUUID(),
          contentHash: entry.contentHash,
          modelKey: entry.modelKey,
          embedding: entry.embedding,
          dimensions: entry.dimensions,
          createdAt: now,
          accessedAt: now,
          accessCount: 1,
        };
      });

      const result = await this.db
        .insert(embeddingCache)
        .values(values)
        .onConflictDoUpdate({
          target: [embeddingCache.contentHash, embeddingCache.modelKey],
          set: {
            accessedAt: now,
            accessCount: sql`${embeddingCache.accessCount} + 1`,
          },
        })
        .returning({ id: embeddingCache.id });

      stored += result.length;
    }

    this.logger.info('Batch cached embeddings', {
      requested: entries.length,
      stored,
    });

    return stored;
  }

  /**
   * Evict the oldest entries from the cache.
   * Used for LRU eviction when cache grows too large.
   *
   * @param count - Number of oldest entries to evict
   * @returns Number of entries evicted
   */
  async evictOldest(count: number): Promise<number> {
    if (count <= 0) {
      return 0;
    }

    // Find oldest entries by accessedAt
    const oldestIds = await this.db
      .select({ id: embeddingCache.id })
      .from(embeddingCache)
      .orderBy(asc(embeddingCache.accessedAt))
      .limit(count);

    if (oldestIds.length === 0) {
      return 0;
    }

    const ids = oldestIds.map((row) => row.id);

    // Delete the oldest entries using Drizzle's inArray for type-safe queries
    const deleted = await this.db
      .delete(embeddingCache)
      .where(inArray(embeddingCache.id, ids))
      .returning({ id: embeddingCache.id });

    this.logger.info('Evicted oldest cache entries', {
      evicted: deleted.length,
      requested: count,
    });

    return deleted.length;
  }

  /**
   * Delete a specific cache entry.
   *
   * @param contentHash - SHA-256 hash of the content
   * @param modelKey - Composite model key
   * @returns True if entry was deleted
   */
  async delete(contentHash: string, modelKey: string): Promise<boolean> {
    const result = await this.db
      .delete(embeddingCache)
      .where(
        and(eq(embeddingCache.contentHash, contentHash), eq(embeddingCache.modelKey, modelKey))
      )
      .returning({ id: embeddingCache.id });

    return result.length > 0;
  }

  /**
   * Delete all cache entries for a specific model.
   * Useful when a model is updated or removed.
   *
   * @param modelKey - Composite model key to clear
   * @returns Number of entries deleted
   */
  async deleteByModel(modelKey: string): Promise<number> {
    const result = await this.db
      .delete(embeddingCache)
      .where(eq(embeddingCache.modelKey, modelKey))
      .returning({ id: embeddingCache.id });

    this.logger.info('Cleared cache for model', {
      modelKey,
      deleted: result.length,
    });

    return result.length;
  }

  /**
   * Check if eviction is needed and optionally perform it.
   *
   * LRU eviction strategy: removes oldest entries (by accessedAt) when cache
   * exceeds RECOMMENDED_MAX_CACHE_ENTRIES threshold.
   *
   * @param options.dryRun - If true, only returns stats without evicting
   * @param options.targetUtilization - Target utilization ratio (default 0.9 = 90%)
   * @returns Object with eviction decision and count of entries evicted (or would be evicted)
   */
  async evictIfNeeded(
    options: { dryRun?: boolean; targetUtilization?: number } = {}
  ): Promise<{ needed: boolean; evicted: number; totalEntries: number }> {
    const { dryRun = false, targetUtilization = 0.9 } = options;

    const [countResult] = await this.db.select({ count: count() }).from(embeddingCache);
    const totalEntries = countResult?.count ?? 0;

    if (totalEntries <= RECOMMENDED_MAX_CACHE_ENTRIES) {
      return { needed: false, evicted: 0, totalEntries };
    }

    // Calculate how many entries to evict to reach target utilization
    const targetCount = Math.floor(RECOMMENDED_MAX_CACHE_ENTRIES * targetUtilization);
    const toEvict = totalEntries - targetCount;

    if (dryRun) {
      this.logger.info('Cache eviction dry run', {
        totalEntries,
        threshold: RECOMMENDED_MAX_CACHE_ENTRIES,
        wouldEvict: toEvict,
        targetCount,
      });
      return { needed: true, evicted: toEvict, totalEntries };
    }

    const evicted = await this.evictOldest(toEvict);
    this.logger.info('Cache eviction completed', {
      totalEntries,
      threshold: RECOMMENDED_MAX_CACHE_ENTRIES,
      evicted,
      newTotal: totalEntries - evicted,
    });

    return { needed: true, evicted, totalEntries };
  }

  /**
   * Get cache statistics for monitoring.
   */
  async getStats(): Promise<EmbeddingCacheStats> {
    const [countResult] = await this.db.select({ count: count() }).from(embeddingCache);

    const [hitsResult] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${embeddingCache.accessCount}), 0)` })
      .from(embeddingCache);

    const [oldestResult] = await this.db
      .select({ accessedAt: embeddingCache.accessedAt })
      .from(embeddingCache)
      .orderBy(asc(embeddingCache.accessedAt))
      .limit(1);

    const [newestResult] = await this.db
      .select({ accessedAt: embeddingCache.accessedAt })
      .from(embeddingCache)
      .orderBy(sql`${embeddingCache.accessedAt} DESC`)
      .limit(1);

    return {
      totalEntries: countResult?.count ?? 0,
      totalHits: Number(hitsResult?.total ?? 0),
      oldestAccessedAt: oldestResult?.accessedAt ?? null,
      newestAccessedAt: newestResult?.accessedAt ?? null,
    };
  }

  /**
   * Update access time for a single entry (internal use).
   */
  private async updateAccessTime(id: string): Promise<void> {
    await this.db
      .update(embeddingCache)
      .set({
        accessedAt: new Date(),
        accessCount: sql`${embeddingCache.accessCount} + 1`,
      })
      .where(eq(embeddingCache.id, id));
  }

  /**
   * Batch update access times (internal use).
   */
  private async batchUpdateAccessTime(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    // Use Drizzle's inArray for type-safe parameterized queries
    await this.db
      .update(embeddingCache)
      .set({
        accessedAt: new Date(),
        accessCount: sql`${embeddingCache.accessCount} + 1`,
      })
      .where(inArray(embeddingCache.id, ids));
  }
}
