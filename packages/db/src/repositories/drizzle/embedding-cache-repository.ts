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
 */

import { createLogger, generateUUID } from '@brainstrike/utils';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { type EmbeddingCacheEntry, embeddingCache } from '../../schema/index.js';

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
export type EmbeddingCacheStats = {
  /** Total entries in cache */
  totalEntries: number;
  /** Total cache hits (sum of accessCount) */
  totalHits: number;
  /** Oldest entry timestamp */
  oldestAccessedAt: Date | null;
  /** Newest entry timestamp */
  newestAccessedAt: Date | null;
};

/**
 * Batch lookup request
 */
export type BatchLookupRequest = {
  contentHash: string;
  modelKey: string;
};

/**
 * Batch lookup result
 */
export type BatchLookupResult = Map<string, EmbeddingCacheEntry>;

export class DrizzleEmbeddingCacheRepository {
  private readonly logger = createLogger('DrizzleEmbeddingCacheRepository');

  constructor(private readonly db: DrizzleDb) {}

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
      this.logger.warn('Failed to update cache access time', {
        id: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return { hit: true, entry: row };
  }

  /**
   * Batch lookup for multiple content hashes with the same model key.
   * More efficient than individual lookups when processing batches.
   *
   * @param requests - Array of (contentHash, modelKey) pairs to look up
   * @returns Map of "contentHash:modelKey" -> entry for hits only
   */
  async getBatch(requests: BatchLookupRequest[]): Promise<BatchLookupResult> {
    if (requests.length === 0) {
      return new Map();
    }

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
      // Use SQL IN clause for batch lookup
      const rows = await this.db
        .select()
        .from(embeddingCache)
        .where(
          and(
            eq(embeddingCache.modelKey, modelKey),
            sql`${embeddingCache.contentHash} IN (${sql.join(
              contentHashes.map((h) => sql`${h}`),
              sql`, `
            )})`
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
        this.logger.warn('Failed to batch update cache access times', {
          count: idsToUpdate.length,
          error: error instanceof Error ? error.message : String(error),
        });
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
    const chunkSize = 100;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);

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
   * @param maxEntries - Maximum entries to evict
   * @returns Number of entries evicted
   */
  async evictOldest(maxEntries: number): Promise<number> {
    // Find oldest entries by accessedAt
    const oldestIds = await this.db
      .select({ id: embeddingCache.id })
      .from(embeddingCache)
      .orderBy(asc(embeddingCache.accessedAt))
      .limit(maxEntries);

    if (oldestIds.length === 0) {
      return 0;
    }

    const ids = oldestIds.map((row) => row.id);

    // Delete the oldest entries
    const deleted = await this.db
      .delete(embeddingCache)
      .where(
        sql`${embeddingCache.id} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
      .returning({ id: embeddingCache.id });

    this.logger.info('Evicted oldest cache entries', {
      evicted: deleted.length,
      requested: maxEntries,
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

    await this.db
      .update(embeddingCache)
      .set({
        accessedAt: new Date(),
        accessCount: sql`${embeddingCache.accessCount} + 1`,
      })
      .where(
        sql`${embeddingCache.id} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
  }
}
