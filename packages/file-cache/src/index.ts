/**
 * @brainstrike/file-cache
 *
 * Persistent file caching using PGlite database
 *
 * Features:
 * - Cross-platform storage (IndexedDB for web, filesystem for Electron)
 * - Efficient caching with PostgreSQL query capabilities
 * - Automatic cache initialization and table creation
 * - Cache statistics and cleanup utilities
 * - Environment-specific configuration
 */

// Main exports
export { FileCacheService } from './cache-service';
export {
  createFileCache,
  createTestFileCache,
  createFileCacheWithDataDir,
} from './factory';

// Type exports
export type {
  FileCacheAdapter,
  FileCacheConfig,
  CachedFileEntry,
  FileCacheStats,
  PGlite,
} from './types';
