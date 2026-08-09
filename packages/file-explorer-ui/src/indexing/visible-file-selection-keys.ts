/**
 * Composite keys for the files a tree is currently showing (BST-1207, D2).
 *
 * The Explorer tree is lazily enumerated, so "in the tree" already means
 * "visible or under an expanded directory" — unexpanded directories carry no
 * children to walk. Hidden (filtered-out) nodes are skipped using the same
 * `isVisible !== false` rule as `collectVisibleFiles`.
 *
 * Keys are built from `node.rootFolderId`, matching how the background
 * indexer's handle map keys its entries, so a forest with several roots
 * produces keys that stay unique to their owning root.
 */

import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';

function collectInto(nodes: readonly IFileNode[], keys: Set<string>): void {
  for (const node of nodes) {
    if (node.isVisible === false) {
      continue;
    }
    if (node.type === 'file') {
      if (node.rootFolderId) {
        keys.add(encodeFileSelection(node.rootFolderId, node.path));
      }
      continue;
    }
    if (node.children) {
      collectInto(node.children, keys);
    }
  }
}

export function collectVisibleFileSelectionKeys(nodes: readonly IFileNode[]): Set<string> {
  const keys = new Set<string>();
  collectInto(nodes, keys);
  return keys;
}
