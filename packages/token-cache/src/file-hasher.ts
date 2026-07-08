/**
 * File Hasher
 *
 * Uses xxHash64 (WebAssembly) for fast, non-cryptographic content hashing.
 * This is used for cache invalidation - when content changes, the hash changes.
 *
 * xxHash is ~20x faster than SHA-256 and perfectly suitable for deduplication.
 */

import type { FileMetadata } from './types';

/**
 * xxHash WASM module type
 */
interface XXHashModule {
  create64: () => {
    update: (input: string) => void;
    digest: () => bigint;
  };
  h64: (input: string) => bigint;
}

/**
 * Convert bigint hash to hex string
 */
function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

let hasherPromise: Promise<XXHashModule> | null = null;
let hasherInstance: XXHashModule | null = null;

/**
 * Lazily initialize the xxHash WASM module
 */
async function initHasher(): Promise<XXHashModule> {
  if (hasherInstance) {
    return hasherInstance;
  }

  if (!hasherPromise) {
    hasherPromise = (async () => {
      // Dynamic import to support both browser and Node environments
      const xxhashModule = await import('xxhash-wasm');
      // Handle both ESM default export and CJS module.exports
      const xxhashFn =
        typeof xxhashModule.default === 'function' ? xxhashModule.default : xxhashModule;
      hasherInstance = (await (xxhashFn as () => Promise<XXHashModule>)()) as XXHashModule;
      return hasherInstance;
    })();
  }

  return hasherPromise;
}

/**
 * FileHasher provides fast content hashing for cache invalidation.
 *
 * Usage:
 * ```typescript
 * const hasher = new FileHasher();
 * const hash = await hasher.hashContent(fileContent);
 * ```
 */
export class FileHasher {
  private initialized = false;

  /**
   * Initialize the hasher (optional - will auto-init on first use)
   */
  async init(): Promise<void> {
    await initHasher();
    this.initialized = true;
  }

  /**
   * Check if the hasher is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Hash file content using xxHash64.
   *
   * @param content - File content to hash
   * @returns 16-character hex string (64-bit hash)
   */
  async hashContent(content: string): Promise<string> {
    const h = await initHasher();
    return hashToHex(h.h64(content));
  }

  /**
   * Hash content in a streaming fashion for very large files.
   * Uses xxHash64 incremental API.
   *
   * @param chunks - Iterator of content chunks
   * @returns 16-character hex string (64-bit hash)
   */
  async hashContentStreaming(chunks: AsyncIterable<string>): Promise<string> {
    const h = await initHasher();
    const state = h.create64();

    for await (const chunk of chunks) {
      state.update(chunk);
    }

    return state.digest().toString(16).padStart(16, '0');
  }

  /**
   * Quick check if a file may have changed based on metadata.
   * Use this before reading content to avoid unnecessary I/O.
   *
   * @param cached - Cached file metadata
   * @param current - Current file metadata
   * @returns true if file may have changed (needs revalidation)
   */
  shouldRevalidate(cached: FileMetadata, current: FileMetadata): boolean {
    // Size change is a definite indicator
    if (cached.size !== current.size) {
      return true;
    }

    // If we have mtime for both, compare them
    if (cached.mtimeMs !== undefined && current.mtimeMs !== undefined) {
      return cached.mtimeMs !== current.mtimeMs;
    }

    // If we don't have mtime, assume unchanged if size matches
    // This is a heuristic - worst case we serve slightly stale data
    return false;
  }

  /**
   * Create a composite cache key from folder ID and file path.
   */
  createCacheKey(folderId: string, filePath: string): string {
    return `${folderId}::${filePath}`;
  }

  /**
   * Parse a composite cache key back to folder ID and file path.
   */
  parseCacheKey(key: string): { folderId: string; filePath: string } | null {
    const separatorIndex = key.indexOf('::');
    if (separatorIndex === -1) {
      return null;
    }
    return {
      filePath: key.slice(separatorIndex + 2),
      folderId: key.slice(0, separatorIndex),
    };
  }
}

/**
 * Singleton instance for convenience
 */
export const fileHasher = new FileHasher();

/**
 * Reset the hasher (for testing)
 */
export function __resetHasherForTests(): void {
  hasherPromise = null;
  hasherInstance = null;
}
