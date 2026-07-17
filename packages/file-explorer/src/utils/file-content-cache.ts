import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('FileContentCache');
export const fileContentCacheLogger = logger;

/**
 * LRU Cache for file contents with automatic eviction based on memory limits.
 *
 * Uses Map's insertion-order iteration for O(1) amortized LRU eviction:
 * - On access (`get`), the entry is deleted and re-inserted to move it to the back.
 * - Eviction iterates from the front (oldest access) — no sorting required.
 * - A running `currentSize` counter avoids O(n) size recomputation.
 */

export interface CacheEntry {
  content: string;
  lastAccessed: number;
  size: number; // in bytes
  timestamp: number;
}

export interface CacheStats {
  entryCount: number;
  evictionCount: number;
  hitRate: number;
  totalSize: number;
}

/** Shared encoder instance for byte-length measurement (avoids Blob allocation). */
const textEncoder = new TextEncoder();

export class FileContentCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSizeBytes: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private currentSize = 0;

  constructor(
    maxSizeBytes = 10 * 1024 * 1024, // 10MB default (much more aggressive)
    maxEntries = 100 // Max 100 files (much lower limit)
  ) {
    this.maxSizeBytes = maxSizeBytes;
    this.maxEntries = maxEntries;
  }

  /**
   * Get file content from cache.
   *
   * Moves the entry to the back of the Map (most-recently-used position)
   * via delete + re-insert. This is O(1) amortized.
   */
  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      // Move to back of Map (most-recently-used) via delete + re-insert
      this.cache.delete(key);
      this.cache.set(key, entry);
      this.hits++;
      return entry.content;
    }
    this.misses++;
    return;
  }

  /**
   * Set file content in cache with automatic eviction.
   */
  set(key: string, content: string): void {
    const size = textEncoder.encode(content).byteLength;
    const now = Date.now();

    // Don't cache large files (>1MB) - much more aggressive
    if (size > 1024 * 1024) {
      logger.warn('File is too large to cache', {
        key,
        sizeKb: Math.round(size / 1024),
      });
      return;
    }

    const entry: CacheEntry = {
      content,
      lastAccessed: now,
      size,
      timestamp: now,
    };

    // Remove existing entry if it exists (adjusting running size counter)
    const existing = this.cache.get(key);
    if (existing) {
      this.currentSize -= existing.size;
      this.cache.delete(key);
    }

    // Add new entry at the back (most-recently-used position)
    this.cache.set(key, entry);
    this.currentSize += size;

    // Evict if necessary
    this.evictIfNecessary();
  }

  /**
   * Remove entry from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      return this.cache.delete(key);
    }
    return false;
  }

  /**
   * Clear multiple entries
   */
  deleteKeys(keys: string[]): void {
    for (const key of keys) {
      this.delete(key);
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get cache statistics. O(1) — uses running counter for totalSize.
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      entryCount: this.cache.size,
      evictionCount: this.evictions,
      hitRate,
      totalSize: this.currentSize,
    };
  }

  /**
   * Get all cached keys
   */
  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Evict entries if cache exceeds limits. O(evicted) amortized.
   *
   * Iterates from the front of the Map (least-recently-used) and deletes
   * entries until the cache is within limits. No sorting required.
   */
  private evictIfNecessary(): void {
    if (this.currentSize > this.maxSizeBytes) {
      this.evictBySize();
    }

    if (this.cache.size > this.maxEntries) {
      this.evictByCount();
    }
  }

  /**
   * Evict entries by size (LRU). Iterates from front of Map (oldest access first).
   * Deleting the current key during `for...of` iteration is safe per ES spec §24.1.5.4.
   */
  private evictBySize(): void {
    const targetSize = this.maxSizeBytes * 0.5; // Evict to 50% of max (more aggressive)

    for (const [key, entry] of this.cache) {
      if (this.currentSize <= targetSize) {
        break;
      }
      this.cache.delete(key);
      this.currentSize -= entry.size;
      this.evictions++;
    }

    logger.info('Evicted entries by size', {
      currentSizeMb: Math.round(this.currentSize / 1024 / 1024),
      evictions: this.evictions,
    });
  }

  /**
   * Evict entries by count (LRU). Iterates from front of Map (oldest access first).
   * Deleting the current key during `for...of` iteration is safe per ES spec §24.1.5.4.
   */
  private evictByCount(): void {
    const targetCount = Math.floor(this.maxEntries * 0.5); // Evict to 50% of max (more aggressive)
    const toRemoveCount = this.cache.size - targetCount;
    let removed = 0;

    for (const [key, entry] of this.cache) {
      if (removed >= toRemoveCount) {
        break;
      }
      this.cache.delete(key);
      this.currentSize -= entry.size;
      this.evictions++;
      removed++;
    }

    logger.info('Evicted entries by count', {
      currentCount: this.cache.size,
      removedEntries: removed,
    });
  }

  /**
   * Get entries sorted by last accessed (for debugging).
   * Returns most-recently-accessed first (reverse iteration order).
   */
  getEntriesByAccess(): Array<{ key: string; lastAccessed: number; size: number }> {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      lastAccessed: entry.lastAccessed,
      size: entry.size,
    }));

    // Map iteration is oldest-first, so reverse for most-recent-first
    entries.reverse();
    return entries;
  }

  /**
   * Force eviction of oldest entries.
   * Iterates from front of Map (oldest access first).
   */
  evictOldest(count: number): void {
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (removed >= count) {
        break;
      }
      this.cache.delete(key);
      this.currentSize -= entry.size;
      this.evictions++;
      removed++;
    }

    logger.info('Force evicted oldest cache entries', { removedEntries: removed });
  }
}
