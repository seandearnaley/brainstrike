/**
 * Composite keys for the files a tree is currently showing (BST-1207, D2).
 *
 * The Explorer tree is lazily enumerated, so "in the tree" already means
 * "visible or under an expanded directory" — unexpanded directories carry no
 * children to walk.
 *
 * `isVisible === false` prunes DIRECTORIES as well as files, which is stricter
 * than `collectVisibleFiles` (that one gates files only, so it still descends
 * into a hidden directory). Stricter is what indexing wants: a filtered-out
 * directory is not on screen, so counting its contents is work nobody asked
 * for. Selection still uses `collectVisibleFiles` and is unaffected.
 *
 * Keys are built from `node.rootFolderId`, matching how the background
 * indexer's handle map keys its entries, so a forest with several roots
 * produces keys that stay unique to their owning root.
 */

import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { IFileNode } from '@brainstrike/types';
import { isExcludedBackgroundIndexingPath } from '@brainstrike/utils/background-indexing-policy';

/**
 * Root-relative path of a node, accumulated from directory NAMES as the walk
 * descends rather than derived from `node.path`.
 *
 * `node.path` is absolute and the tree only knows its root by id — which is a
 * UUID for DB-backed roots, so there is no prefix to strip. The walk already
 * starts at the root's children (a top-level `.claude` node is `.claude`), so
 * joining names as we go reproduces the policy's `relativePath` contract
 * exactly, with no string surgery and no root lookup.
 */
function joinRelativePath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function collectInto(nodes: readonly IFileNode[], keys: Set<string>, prefix: string): void {
  for (const node of nodes) {
    if (node.isVisible === false) {
      continue;
    }
    const relativePath = joinRelativePath(prefix, node.name);
    if (node.type === 'file') {
      if (node.rootFolderId) {
        keys.add(encodeFileSelection(node.rootFolderId, node.path));
      }
      continue;
    }
    // Prune at the DIRECTORY, matching `shouldTraverseDirectory` semantics: the
    // whole subtree is refused, so none of its files ever reach the debounce,
    // the handle map, or an IPC content read.
    if (isExcludedBackgroundIndexingPath(relativePath)) {
      continue;
    }
    if (node.children) {
      collectInto(node.children, keys, relativePath);
    }
  }
}

/**
 * Honours the SHARED background-indexing path exclusions (BST-1207 follow-up).
 * Before this, the visible-files trigger dispatched every expanded directory,
 * including `.claude/worktrees` — throwaway whole-repo copies the indexer
 * deliberately refuses. Each copy re-reads the same files over IPC, so one
 * excluded tree costs a full duplicate corpus scan per worktree.
 *
 * Only the path rule is borrowed, never the whole entry policy: the Explorer
 * must keep counting tokens for every row it SHOWS, and the policy's size and
 * extension gates would silently blank out rows the user is looking at.
 */
export function collectVisibleFileSelectionKeys(nodes: readonly IFileNode[]): Set<string> {
  const keys = new Set<string>();
  collectInto(nodes, keys, '');
  return keys;
}
