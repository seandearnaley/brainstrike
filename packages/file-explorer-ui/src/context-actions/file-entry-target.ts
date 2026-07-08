import { type ContextTarget, isAbsolutePath, toRelativePath } from '@brainstrike/context-actions';
import type { IFileNode } from '@brainstrike/types';

/**
 * Adapts an IFileNode into the shared ContextTarget shape. Desktop nodes carry
 * absolute paths (electron adapter joins from the absolute root); web nodes
 * carry root-relative paths — the data itself tells us which.
 */
export function fileNodeToTarget(node: IFileNode): ContextTarget | null {
  if (node.type === 'loadMore') {
    return null;
  }
  const absolute = isAbsolutePath(node.path) ? node.path : null;
  return {
    absolutePath: absolute,
    entryType: node.type,
    kind: 'file-entry',
    name: node.name,
    relativePath: absolute ? toRelativePath(node.path, node.rootFolderId) : node.path,
    rootFolderId: node.rootFolderId,
  };
}
