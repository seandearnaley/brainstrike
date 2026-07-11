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
    const filteredChildren = children
      .map((child) => filterNodeByPatterns(child, includesLower, excludesLower))
      .filter(Boolean) as IFileNode[];
    if (filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    if (shouldIncludeNode(node, includesLower, excludesLower)) {
      return { ...node, children: [] };
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
  return nodes
    .map((node) => filterNodeByPatterns(node, includesLower, excludesLower))
    .filter(Boolean) as IFileNode[];
}

/**
 * Quick-filter predicate for the RECURSIVE-SELECTION SCAN (not the display
 * tree). Unlike `applyQuickFilterToTree`, which prunes name-mismatched empty
 * directories, this keeps EVERY directory so the scan can traverse into it —
 * a matching file may live deeper in an as-yet-unloaded subtree. Only FILES
 * are name-filtered (mirrors the workspace filter's scan semantics, which also
 * keep all directories). Blank filter is a no-op (returns the same array).
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
    if (node.type === 'directory') {
      return true;
    }
    const nameText = node.name.toLowerCase();
    if (excludesLower.some((pattern) => nameText.includes(pattern))) {
      return false;
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
