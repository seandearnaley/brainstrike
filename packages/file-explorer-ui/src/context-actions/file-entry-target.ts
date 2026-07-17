import type { ContextTarget } from '@brainstrike/context-actions';
import type { IFileNode } from '@brainstrike/types';
import { resolveFileTargetIdentity } from './file-target-identity';

/**
 * Adapts an IFileNode into the shared ContextTarget shape. Desktop nodes carry
 * absolute paths (electron adapter joins from the absolute root); web nodes
 * carry root-relative paths — the data itself tells us which.
 */
export function fileNodeToTarget(node: IFileNode, rootPath?: string | null): ContextTarget | null {
  if (node.type === 'loadMore') {
    return null;
  }
  return {
    entryType: node.type,
    kind: 'file-entry',
    ...resolveFileTargetIdentity({
      name: node.name,
      path: node.path,
      rootFolderId: node.rootFolderId,
      ...(rootPath === undefined ? {} : { rootPath }),
    }),
  };
}
