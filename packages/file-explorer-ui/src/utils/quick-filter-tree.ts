/**
 * Quick-filter (search box) tree filtering, shared by the single-root panel
 * AND every forest section. The quick filter is workspace-global state
 * (store.quickFilter) — applying it only to the focused panel tree left the
 * forest sections unfiltered, so the search box silently did nothing in
 * multi-root workspaces.
 */

import type { IFileNode } from '@brainstrike/types';
import { parseFilterString } from '@brainstrike/utils/quick-filter-utils';
import { useDeferredValue, useMemo } from 'react';
import { useFileExplorerStoreSelector } from '../shell/file-explorer-provider';

/**
 * Check if a node should be included based on filter patterns.
 * IMPORTANT: Both include and exclude patterns match ONLY against the
 * filename to avoid false positives from path components (e.g., "test"
 * matching "test-project/" in the path when only files named "test" should
 * match).
 */
function shouldIncludeNode(node: IFileNode, includes: string[], excludes: string[]): boolean {
  const nameText = node.name.toLowerCase();
  if (excludes.some((excludePattern) => nameText.includes(excludePattern))) {
    return false;
  }
  return (
    includes.length === 0 || includes.some((includePattern) => nameText.includes(includePattern))
  );
}

/**
 * Copy-on-write children filter: returns the ORIGINAL array when every child
 * is retained with identical identity. Fully matching subtrees keep their
 * node objects across (deferred) keystrokes — the previous clone-everything
 * pass allocated a full retained tree per query settle, and its fresh
 * identities defeated memo'd rows and WeakMap-keyed derivation caches.
 */
function filterChildrenByPatterns(
  children: IFileNode[],
  includesLower: string[],
  excludesLower: string[]
): IFileNode[] {
  let diverged: IFileNode[] | null = null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) {
      continue;
    }
    const filtered = filterNodeByPatterns(child, includesLower, excludesLower);
    if (diverged === null) {
      if (filtered === child) {
        continue;
      }
      diverged = children.slice(0, index);
      if (filtered) {
        diverged.push(filtered);
      }
      continue;
    }
    if (filtered) {
      diverged.push(filtered);
    }
  }
  return diverged ?? children;
}

function filterNodeByPatterns(
  node: IFileNode,
  includesLower: string[],
  excludesLower: string[]
): IFileNode | null {
  // Check exclusion FIRST (before children) so excluded directories are
  // completely removed even when they contain include-matching files.
  const nameText = node.name.toLowerCase();
  if (excludesLower.some((excludePattern) => nameText.includes(excludePattern))) {
    return null;
  }

  if (node.type === 'directory') {
    const children = node.children ?? [];
    const filteredChildren = filterChildrenByPatterns(children, includesLower, excludesLower);
    if (filteredChildren.length > 0) {
      // All children retained by identity → the directory itself is unchanged.
      return filteredChildren === node.children ? node : { ...node, children: filteredChildren };
    }
    if (shouldIncludeNode(node, includesLower, excludesLower)) {
      return node.children !== undefined && node.children.length === 0
        ? node
        : { ...node, children: [] };
    }
    return null;
  }
  return includesLower.length === 0 ||
    includesLower.some((includePattern) => nameText.includes(includePattern))
    ? node
    : null;
}

export function filterTreeByPatterns(
  nodes: IFileNode[],
  includesLower: string[],
  excludesLower: string[]
): IFileNode[] {
  return filterChildrenByPatterns(nodes, includesLower, excludesLower);
}

/**
 * Quick-filter predicate for the RECURSIVE-SELECTION SCAN (not the display
 * tree). Two rules, matching the display filter's directory semantics
 * (`filterNodeByPatterns`):
 *  - An EXCLUDE term matching a node's name drops it — for FILES **and
 *    DIRECTORIES**. A directory whose name matches an exclude term (e.g.
 *    `-node_modules`, `-dist`) is pruned so the scan never traverses into it,
 *    exactly as the display filter removes the whole excluded subtree.
 *  - A non-excluded DIRECTORY is always kept for traversal (a matching file
 *    may live deeper in an as-yet-unloaded subtree), unlike the display filter
 *    which additionally prunes name-mismatched empty dirs. FILES are then
 *    include-filtered.
 * Blank filter is a no-op (returns the same array).
 */
export function filterSelectionScanNodesByQuickFilter(
  nodes: IFileNode[],
  quickFilter: string
): IFileNode[] {
  if (!quickFilter.trim()) {
    return nodes;
  }
  const { includes, excludes } = parseFilterString(quickFilter);
  const includesLower = includes.map((value: string) => value.toLowerCase());
  const excludesLower = excludes.map((value: string) => value.toLowerCase());
  return nodes.filter((node) => {
    const nameText = node.name.toLowerCase();
    // Exclusion applies to files AND directories (an excluded directory is
    // never traversed) — checked FIRST, mirroring the display filter.
    if (excludesLower.some((pattern) => nameText.includes(pattern))) {
      return false;
    }
    if (node.type === 'directory') {
      return true;
    }
    return (
      includesLower.length === 0 || includesLower.some((pattern) => nameText.includes(pattern))
    );
  });
}

/** Collect the visible FILE paths of a (filtered) tree. */
export function collectVisibleFiles(nodes: IFileNode[], fileSet: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'file' && node.isVisible !== false) {
      fileSet.add(node.path);
    } else if (node.type === 'directory' && node.children) {
      collectVisibleFiles(node.children, fileSet);
    }
  }
}

/** Apply a raw quick-filter string to a tree (no-op for blank filters). */
export function applyQuickFilterToTree(tree: IFileNode[], quickFilter: string): IFileNode[] {
  if (!quickFilter.trim()) {
    return tree;
  }
  const { includes, excludes } = parseFilterString(quickFilter);
  return filterTreeByPatterns(
    tree,
    includes.map((value: string) => value.toLowerCase()),
    excludes.map((value: string) => value.toLowerCase())
  );
}

/**
 * The workspace quick filter applied to a tree, deferred behind keystrokes.
 * Every surface that DISPLAYS a tree must use this so the search box filters
 * what the user actually sees — panel and forest sections alike.
 */
export function useQuickFilteredTree(tree: IFileNode[]): {
  isQuickFilterActive: boolean;
  quickFilter: string;
  tree: IFileNode[];
} {
  const quickFilter = useFileExplorerStoreSelector((s) => s.quickFilter);
  const deferredQuickFilter = useDeferredValue(quickFilter);
  const filtered = useMemo(
    () => applyQuickFilterToTree(tree, deferredQuickFilter),
    [tree, deferredQuickFilter]
  );
  return {
    isQuickFilterActive: deferredQuickFilter.trim().length > 0,
    quickFilter: deferredQuickFilter,
    tree: filtered,
  };
}
