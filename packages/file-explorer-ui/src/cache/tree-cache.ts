/**
 * IndexedDB Tree Cache
 *
 * Provides persistent caching of file tree structures in IndexedDB.
 * This significantly improves startup performance for large directory trees
 * by avoiding full re-scans when the directory hasn't changed.
 *
 * Note: FileSystemHandle objects are serializable to IndexedDB in browsers
 * that support the File System Access API.
 */

import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('TreeCache');

/** Database name for tree cache */
const DB_NAME = 'brainstrike-tree-cache';

/** Current database version */
const DB_VERSION = 1;

/** Store name for cached trees */
const TREE_STORE = 'trees';

/** Cache entry TTL in milliseconds (24 hours) */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cached tree entry stored in IndexedDB
 */
export type CachedTreeEntry = {
  /** Unique identifier for the cached tree (root directory name) */
  id: string;
  /** The cached file tree nodes */
  nodes: IFileNode[];
  /** Timestamp when the cache was created */
  cachedAt: number;
  /** Total number of nodes in the tree */
  nodeCount: number;
};

/**
 * Result of a cache lookup
 */
export type CacheLookupResult =
  | { hit: true; nodes: IFileNode[]; cachedAt: number }
  | { hit: false; reason: 'miss' | 'expired' | 'error' };

/**
 * Opens the IndexedDB database, creating it if necessary
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? 'Unknown error'}`));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create the trees object store if it doesn't exist
      if (!db.objectStoreNames.contains(TREE_STORE)) {
        const store = db.createObjectStore(TREE_STORE, { keyPath: 'id' });
        store.createIndex('cachedAt', 'cachedAt', { unique: false });
      }
    };
  });
}

/**
 * Counts total nodes in a tree (including nested children)
 */
function countNodes(nodes: IFileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children) {
      count += countNodes(node.children);
    }
  }
  return count;
}

/**
 * Strips non-serializable properties from nodes for caching.
 * FileSystemHandle objects should be serializable to IndexedDB,
 * but we strip them to ensure cross-browser compatibility and
 * because handles may become invalid across sessions.
 */
function prepareNodesForCache(nodes: IFileNode[]): IFileNode[] {
  return nodes.map((node) => {
    const cached: IFileNode = {
      ...node,
      // Remove handle as it may not be valid across sessions
      handle: undefined as unknown as FileSystemFileHandle,
    };
    if (node.children) {
      cached.children = prepareNodesForCache(node.children);
    }
    return cached;
  });
}

/**
 * Gets a cached tree from IndexedDB
 *
 * @param rootId - The root directory identifier (typically the directory name)
 * @returns Cache lookup result
 */
export async function getCachedTree(rootId: string): Promise<CacheLookupResult> {
  try {
    const db = await openDatabase();

    return new Promise((resolve) => {
      const transaction = db.transaction(TREE_STORE, 'readonly');
      const store = transaction.objectStore(TREE_STORE);
      const request = store.get(rootId);

      request.onerror = () => {
        logger.warn('Failed to read from tree cache:', request.error);
        db.close();
        resolve({ hit: false, reason: 'error' });
      };

      request.onsuccess = () => {
        db.close();

        const entry = request.result as CachedTreeEntry | undefined;

        if (!entry) {
          resolve({ hit: false, reason: 'miss' });
          return;
        }

        // Check if cache has expired
        const age = Date.now() - entry.cachedAt;
        if (age > CACHE_TTL_MS) {
          logger.debug(`Tree cache expired for ${rootId} (age: ${Math.round(age / 1000 / 60)}min)`);
          resolve({ hit: false, reason: 'expired' });
          return;
        }

        logger.debug(
          `Tree cache hit for ${rootId}: ${entry.nodeCount} nodes, cached ${Math.round(age / 1000)}s ago`
        );
        resolve({
          hit: true,
          nodes: entry.nodes,
          cachedAt: entry.cachedAt,
        });
      };
    });
  } catch (error) {
    logger.warn('Failed to access tree cache:', error);
    return { hit: false, reason: 'error' };
  }
}

/**
 * Stores a tree in IndexedDB cache
 *
 * @param rootId - The root directory identifier
 * @param nodes - The file tree nodes to cache
 */
export async function setCachedTree(rootId: string, nodes: IFileNode[]): Promise<void> {
  try {
    const db = await openDatabase();
    const preparedNodes = prepareNodesForCache(nodes);
    const nodeCount = countNodes(nodes);

    const entry: CachedTreeEntry = {
      id: rootId,
      nodes: preparedNodes,
      cachedAt: Date.now(),
      nodeCount,
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TREE_STORE, 'readwrite');
      const store = transaction.objectStore(TREE_STORE);
      const request = store.put(entry);

      request.onerror = () => {
        logger.warn('Failed to write to tree cache:', request.error);
        db.close();
        reject(new Error(`Failed to cache tree: ${request.error?.message ?? 'Unknown error'}`));
      };

      request.onsuccess = () => {
        logger.debug(`Tree cached for ${rootId}: ${nodeCount} nodes`);
        db.close();
        resolve();
      };
    });
  } catch (error) {
    logger.warn('Failed to cache tree:', error);
    // Don't throw - caching failures shouldn't break the app
  }
}

/**
 * Removes a cached tree from IndexedDB
 *
 * @param rootId - The root directory identifier to remove
 */
export async function removeCachedTree(rootId: string): Promise<void> {
  try {
    const db = await openDatabase();

    return new Promise((resolve) => {
      const transaction = db.transaction(TREE_STORE, 'readwrite');
      const store = transaction.objectStore(TREE_STORE);
      const request = store.delete(rootId);

      request.onerror = () => {
        logger.warn('Failed to remove from tree cache:', request.error);
        db.close();
        resolve();
      };

      request.onsuccess = () => {
        logger.debug(`Tree cache removed for ${rootId}`);
        db.close();
        resolve();
      };
    });
  } catch (error) {
    logger.warn('Failed to remove cached tree:', error);
  }
}

/**
 * Clears all cached trees from IndexedDB
 */
export async function clearTreeCache(): Promise<void> {
  try {
    const db = await openDatabase();

    return new Promise((resolve) => {
      const transaction = db.transaction(TREE_STORE, 'readwrite');
      const store = transaction.objectStore(TREE_STORE);
      const request = store.clear();

      request.onerror = () => {
        logger.warn('Failed to clear tree cache:', request.error);
        db.close();
        resolve();
      };

      request.onsuccess = () => {
        logger.debug('Tree cache cleared');
        db.close();
        resolve();
      };
    });
  } catch (error) {
    logger.warn('Failed to clear tree cache:', error);
  }
}

/**
 * Gets cache statistics
 */
export async function getTreeCacheStats(): Promise<{
  entryCount: number;
  totalNodes: number;
  oldestEntry: number | null;
}> {
  try {
    const db = await openDatabase();

    return new Promise((resolve) => {
      const transaction = db.transaction(TREE_STORE, 'readonly');
      const store = transaction.objectStore(TREE_STORE);
      const request = store.getAll();

      request.onerror = () => {
        db.close();
        resolve({ entryCount: 0, totalNodes: 0, oldestEntry: null });
      };

      request.onsuccess = () => {
        db.close();
        const entries = request.result as CachedTreeEntry[];
        const totalNodes = entries.reduce((sum, e) => sum + e.nodeCount, 0);
        const oldestEntry = entries.length > 0 ? Math.min(...entries.map((e) => e.cachedAt)) : null;

        resolve({
          entryCount: entries.length,
          totalNodes,
          oldestEntry,
        });
      };
    });
  } catch {
    return { entryCount: 0, totalNodes: 0, oldestEntry: null };
  }
}
