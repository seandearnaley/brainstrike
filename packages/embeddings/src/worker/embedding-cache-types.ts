/**
 * Minimal cached embedding entry returned from cache lookups.
 */
export interface CachedEmbedding {
  contentHash: string;
  dimensions: number;
  embedding: number[];
  modelKey: string;
}

/**
 * Interface for embedding cache operations.
 * Allows dependency injection without coupling to the Drizzle implementation.
 * BST-170: Content-level embedding deduplication.
 */
export interface EmbeddingCacheInterface {
  /**
   * Evict stale entries when cache size exceeds its configured cap.
   * Called cooperatively after the embedding queue drains.
   */
  evictIfNeeded?: () => Promise<{ needed: boolean; evicted: number; totalEntries: number }>;

  /**
   * Flush pending LRU access-time updates before worker shutdown.
   */
  flushPendingAccessTimeUpdates?: () => Promise<void>;

  /**
   * Get a cached embedding by content hash and model key.
   * Returns hit: true with the entry if found, or hit: false if not cached.
   */
  get(
    contentHash: string,
    modelKey: string
  ): Promise<{ hit: true; entry: CachedEmbedding } | { hit: false; entry: null }>;

  /**
   * Get multiple cached embeddings in a single query.
   * Returns a Map keyed by "contentHash:modelKey".
   */
  getBatch(
    requests: ReadonlyArray<{ contentHash: string; modelKey: string }>
  ): Promise<Map<string, CachedEmbedding>>;

  /**
   * Return cache diagnostics for worker metrics/log output.
   */
  getStats?: () => Promise<{
    newestAccessedAt: Date | null;
    oldestAccessedAt: Date | null;
    totalEntries: number;
    totalHits: number;
  }>;

  /**
   * Store an embedding in the cache.
   */
  set(
    contentHash: string,
    modelKey: string,
    embedding: number[],
    dimensions: number
  ): Promise<unknown>;

  /**
   * Store multiple embeddings in the cache atomically.
   */
  setBatch(
    entries: ReadonlyArray<{
      contentHash: string;
      modelKey: string;
      embedding: number[];
      dimensions: number;
    }>
  ): Promise<number>;
}
