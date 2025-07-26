/**
 * LRU Cache for file contents with automatic eviction based on memory limits
 */

export interface CacheEntry {
  content: string;
  timestamp: number;
  lastAccessed: number;
  size: number; // in bytes
}

export interface CacheStats {
  totalSize: number;
  entryCount: number;
  hitRate: number;
  evictionCount: number;
}

export class FileContentCache {
  private cache = new Map<string, CacheEntry>();
  private maxSizeBytes: number;
  private maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    maxSizeBytes = 10 * 1024 * 1024, // 10MB default (much more aggressive)
    maxEntries = 100 // Max 100 files (much lower limit)
  ) {
    this.maxSizeBytes = maxSizeBytes;
    this.maxEntries = maxEntries;
  }

  /**
   * Get file content from cache
   */
  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      this.hits++;
      return entry.content;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Set file content in cache with automatic eviction
   */
  set(key: string, content: string): void {
    const size = new Blob([content]).size;
    const now = Date.now();

    // Don't cache large files (>1MB) - much more aggressive
    if (size > 1024 * 1024) {
      console.warn(`File ${key} is too large (${Math.round(size / 1024)}KB) - skipping cache`);
      return;
    }

    const entry: CacheEntry = {
      content,
      timestamp: now,
      lastAccessed: now,
      size,
    };

    // Remove existing entry if it exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add new entry
    this.cache.set(key, entry);

    // Evict if necessary
    this.evictIfNecessary();
  }

  /**
   * Remove entry from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear multiple entries
   */
  deleteKeys(keys: string[]): void {
    keys.forEach((key) => this.cache.delete(key));
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
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
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalSize = Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.size, 0);
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      totalSize,
      entryCount: this.cache.size,
      hitRate,
      evictionCount: this.evictions,
    };
  }

  /**
   * Get all cached keys
   */
  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Evict entries if cache exceeds limits
   */
  private evictIfNecessary(): void {
    const currentSize = this.getCurrentSize();

    // Evict by size
    if (currentSize > this.maxSizeBytes) {
      this.evictBySize();
    }

    // Evict by count
    if (this.cache.size > this.maxEntries) {
      this.evictByCount();
    }
  }

  /**
   * Evict entries by size (LRU)
   */
  private evictBySize(): void {
    const entries = Array.from(this.cache.entries());

    // Sort by last accessed (oldest first)
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    let currentSize = this.getCurrentSize();
    const targetSize = this.maxSizeBytes * 0.5; // Evict to 50% of max (more aggressive)

    for (const [key, entry] of entries) {
      if (currentSize <= targetSize) {
        break;
      }

      this.cache.delete(key);
      currentSize -= entry.size;
      this.evictions++;
    }

    console.log(
      `FileContentCache: Evicted ${this.evictions} entries by size. Current size: ${Math.round(currentSize / 1024 / 1024)}MB`
    );
  }

  /**
   * Evict entries by count (LRU)
   */
  private evictByCount(): void {
    const entries = Array.from(this.cache.entries());

    // Sort by last accessed (oldest first)
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    const targetCount = Math.floor(this.maxEntries * 0.5); // Evict to 50% of max (more aggressive)
    const toRemove = entries.slice(0, this.cache.size - targetCount);

    for (const [key] of toRemove) {
      this.cache.delete(key);
      this.evictions++;
    }

    console.log(
      `FileContentCache: Evicted ${toRemove.length} entries by count. Current count: ${this.cache.size}`
    );
  }

  /**
   * Get current total size of cache
   */
  private getCurrentSize(): number {
    return Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.size, 0);
  }

  /**
   * Get entries sorted by last accessed (for debugging)
   */
  getEntriesByAccess(): Array<{ key: string; lastAccessed: number; size: number }> {
    return Array.from(this.cache.entries())
      .map(([key, entry]) => ({
        key,
        lastAccessed: entry.lastAccessed,
        size: entry.size,
      }))
      .sort((a, b) => b.lastAccessed - a.lastAccessed);
  }

  /**
   * Force eviction of oldest entries
   */
  evictOldest(count: number): void {
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    const toRemove = entries.slice(0, count);
    for (const [key] of toRemove) {
      this.cache.delete(key);
      this.evictions++;
    }

    console.log(`FileContentCache: Force evicted ${toRemove.length} oldest entries`);
  }
}
