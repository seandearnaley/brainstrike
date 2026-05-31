/**
 * Metadata Cache for File System Operations (BST-146)
 *
 * Provides an LRU cache with TTL expiration for file metadata (mtime, size, type).
 * This avoids redundant stat() calls when re-expanding directories.
 *
 * Design principles:
 * - Map insertion order used for LRU: accessed entries are moved to end
 * - TTL checked on read (lazy expiration) for efficiency
 * - Path validation must be performed by caller before caching
 *
 * @module metadata-cache
 */

/** Cached file metadata entry */
export interface MetadataCacheEntry {
  /** When this entry was cached (for TTL) */
  cachedAt: number;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Modification time in milliseconds since epoch */
  mtimeMs: number;
  /** File size in bytes */
  size: number;
}

/** Configuration for the metadata cache */
export interface MetadataCacheConfig {
  /** Maximum number of entries (default: 10000) */
  maxEntries?: number;
  /** Time-to-live in milliseconds (default: 30000 = 30s) */
  ttlMs?: number;
}

/** Statistics for cache monitoring */
export interface MetadataCacheStats {
  /** LRU eviction count */
  evictions: number;
  /** TTL expiration count */
  expirations: number;
  /** Hit rate as percentage (0-100) */
  hitRate: number;
  /** Cache hit count */
  hits: number;
  /** Maximum allowed entries */
  maxEntries: number;
  /** Cache miss count */
  misses: number;
  /** Current number of entries */
  size: number;
}

/** Default configuration values */
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 30_000; // 30 seconds

function normalizeCachePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * LRU+TTL Metadata Cache
 *
 * Caches file metadata to avoid redundant filesystem stat() calls.
 * Uses Map's insertion order for LRU eviction with configurable TTL.
 *
 * @example
 * ```ts
 * const cache = new MetadataCache({ maxEntries: 5000, ttlMs: 60000 });
 *
 * // Set a cached entry
 * cache.set('/path/to/file.ts', { size: 1024, mtimeMs: Date.now(), isDirectory: false });
 *
 * // Get a cached entry (returns undefined if expired or missing)
 * const entry = cache.get('/path/to/file.ts');
 *
 * // Invalidate by path or pattern
 * cache.invalidatePath('/path/to/file.ts');
 * cache.invalidateDirectory('/path/to');
 * ```
 */
export class MetadataCache {
  private readonly cache = new Map<string, MetadataCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  // Stats tracking
  private hits = 0;
  private misses = 0;
  private expirations = 0;
  private evictions = 0;

  constructor(config: MetadataCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Get a cached entry by path.
   * Returns undefined if not found or expired.
   * Moves accessed entries to end for LRU ordering.
   */
  get(path: string): MetadataCacheEntry | undefined {
    const cachePath = normalizeCachePath(path);
    const entry = this.cache.get(cachePath);

    if (!entry) {
      this.misses++;
      return;
    }

    // Check TTL expiration
    if (this.isExpired(entry)) {
      this.cache.delete(cachePath);
      this.expirations++;
      this.misses++;
      return;
    }

    // Move to end for LRU (delete and re-insert)
    this.cache.delete(cachePath);
    this.cache.set(cachePath, entry);
    this.hits++;

    return entry;
  }

  /**
   * Check if an entry exists and is not expired (without updating LRU position).
   */
  has(path: string): boolean {
    const cachePath = normalizeCachePath(path);
    const entry = this.cache.get(cachePath);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.cache.delete(cachePath);
      this.expirations++;
      return false;
    }
    return true;
  }

  /**
   * Set a cache entry.
   * Automatically evicts oldest entries if at capacity.
   */
  set(path: string, metadata: Omit<MetadataCacheEntry, 'cachedAt'>): void {
    const cachePath = normalizeCachePath(path);
    // If updating existing entry, delete first to maintain insertion order
    if (this.cache.has(cachePath)) {
      this.cache.delete(cachePath);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
      this.evictions++;
    }

    this.cache.set(cachePath, {
      ...metadata,
      cachedAt: Date.now(),
    });
  }

  /**
   * Set multiple cache entries in batch.
   * More efficient than individual set() calls.
   */
  setBatch(entries: Array<{ path: string; metadata: Omit<MetadataCacheEntry, 'cachedAt'> }>): void {
    const now = Date.now();

    for (const { path, metadata } of entries) {
      const cachePath = normalizeCachePath(path);
      // Delete if exists to maintain insertion order
      if (this.cache.has(cachePath)) {
        this.cache.delete(cachePath);
      }

      // Evict oldest entries if at capacity
      while (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        this.cache.delete(oldestKey);
        this.evictions++;
      }

      this.cache.set(cachePath, {
        ...metadata,
        cachedAt: now,
      });
    }
  }

  /**
   * Invalidate a specific path.
   * Returns true if the entry existed.
   */
  invalidatePath(path: string): boolean {
    return this.cache.delete(normalizeCachePath(path));
  }

  /**
   * Invalidate all entries under a directory path.
   * Useful when a directory's contents change.
   *
   * @param dirPath Directory path (with or without trailing slash)
   * @returns Number of entries invalidated
   */
  invalidateDirectory(dirPath: string): number {
    const normalizedPath = normalizeCachePath(dirPath);
    const prefix = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
    let count = 0;

    // Also invalidate the directory itself
    if (this.cache.delete(normalizedPath)) {
      count++;
    }

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Invalidate entries matching a predicate.
   * Useful for custom invalidation strategies.
   *
   * @param predicate Function that returns true for paths to invalidate
   * @returns Number of entries invalidated
   */
  invalidateWhere(predicate: (path: string, entry: MetadataCacheEntry) => boolean): number {
    let count = 0;
    for (const [path, entry] of this.cache.entries()) {
      if (predicate(path, entry)) {
        this.cache.delete(path);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getStats(): MetadataCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      expirations: this.expirations,
      evictions: this.evictions,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
    };
  }

  /**
   * Reset statistics (useful for testing).
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.expirations = 0;
    this.evictions = 0;
  }

  /**
   * Get all cached paths (for debugging/testing).
   */
  getPaths(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Remove expired entries proactively.
   * Normally expiration is lazy (on get), but this can be called
   * periodically to reduce memory if needed.
   *
   * @returns Number of expired entries removed
   */
  pruneExpired(): number {
    let count = 0;
    for (const [path, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(path);
        this.expirations++;
        count++;
      }
    }
    return count;
  }

  private isExpired(entry: MetadataCacheEntry): boolean {
    return Date.now() - entry.cachedAt > this.ttlMs;
  }
}

/**
 * Create a metadata cache with sensible defaults.
 * Convenience factory for common use cases.
 */
export function createMetadataCache(config?: MetadataCacheConfig): MetadataCache {
  return new MetadataCache(config);
}
