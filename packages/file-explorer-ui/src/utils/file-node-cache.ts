import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('FileNodeCache');

export type FileNodeCache = Map<string, Map<string, IFileNode>>;

interface FileNodeCacheLookupOptions {
  readonly warnOnMiss?: boolean;
}

export function buildFileNodeCache(tree: IFileNode[]): FileNodeCache {
  const cache: FileNodeCache = new Map();

  const populate = (nodes: IFileNode[]) => {
    for (const node of nodes) {
      const folderMap = cache.get(node.rootFolderId) ?? new Map<string, IFileNode>();
      folderMap.set(node.path, node);
      cache.set(node.rootFolderId, folderMap);

      if (node.type === 'directory' && node.children) {
        populate(node.children);
      }
    }
  };

  populate(tree);
  return cache;
}

export function getFileNodeFromCache(
  cache: FileNodeCache,
  tree: IFileNode[],
  folderId: string,
  path: string,
  options: FileNodeCacheLookupOptions = {}
): IFileNode | null {
  const cached = cache.get(folderId)?.get(path);
  if (cached) {
    return cached;
  }

  // Cache miss - try fallback search
  const folderCacheSize = cache.get(folderId)?.size ?? 0;
  const node = fileExplorer.findNodeByPath(tree, path, folderId);

  if (node) {
    let folderMap = cache.get(folderId);
    if (!folderMap) {
      folderMap = new Map<string, IFileNode>();
      cache.set(folderId, folderMap);
    }
    folderMap.set(path, node);
    logger.debug('Cache miss, found via fallback', { folderCacheSize, folderId, path });
  } else {
    // Both cache and fallback failed
    // Use debug level when tree is empty (expected during startup race condition)
    // Use warn level when tree exists but node not found (unexpected)
    const logLevel = tree.length === 0 || options.warnOnMiss === false ? 'debug' : 'warn';
    logger[logLevel]('Node not found in cache or tree', {
      folderCacheSize,
      folderId,
      path,
      totalCacheFolders: cache.size,
      treeRootCount: tree.length,
    });
  }

  return node ?? null;
}

export function refreshFileNodeCacheEntry(
  cache: FileNodeCache,
  tree: IFileNode[],
  folderId: string,
  path: string
): IFileNode | null {
  const node = fileExplorer.findNodeByPath(tree, path, folderId);
  if (node) {
    let folderMap = cache.get(folderId);
    if (!folderMap) {
      folderMap = new Map<string, IFileNode>();
      cache.set(folderId, folderMap);
    }
    folderMap.set(path, node);
  }
  return node ?? null;
}
