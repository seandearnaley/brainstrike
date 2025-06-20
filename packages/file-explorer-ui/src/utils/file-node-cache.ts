import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';

export type FileNodeCache = Map<string, Map<string, IFileNode>>;

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
  path: string
): IFileNode | null {
  const cached = cache.get(folderId)?.get(path);
  if (cached) {
    return cached;
  }

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
