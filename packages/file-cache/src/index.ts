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
export { FolderService } from './folder-service';
export {
  createFileCache,
  createTestFileCache,
  createFileCacheWithDataDir,
  createFolderService,
  createTestFolderService,
} from './factory';

// Type exports
export type {
  FileCacheAdapter,
  FileCacheConfig,
  CachedFileEntry,
  FolderFileEntry,
  FolderInfo,
  BulkFileEntry,
  FileCacheStats,
  PGlite,
} from './types';

export type { FileTreeNode } from './folder-service';
