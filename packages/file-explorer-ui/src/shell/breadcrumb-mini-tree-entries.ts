import type { IFileNode } from '@brainstrike/types';
import { buildFileBreadcrumbSegments } from './file-tab-breadcrumb-segments';

/**
 * Pure resolution behind the breadcrumb popover mini-tree (BST-1319).
 *
 * A clicked breadcrumb segment lists its PARENT directory's contents (the
 * segment's siblings, VS Code idiom) — so the first-level segment maps to the
 * workspace root level. Paths are treated as opaque strings sliced from the
 * original tab path: both '/' and Windows '\\' separators are honored and
 * never normalized, matching how segment paths feed the tree (see
 * file-tab-breadcrumb-segments.ts).
 */

export interface MiniTreeEntry {
  readonly depth: number;
  readonly node: IFileNode;
}

function lastSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/**
 * The directory whose contents the popover lists for a clicked segment, or
 * null for the workspace root level (first-level segments, or a parent that
 * IS the root).
 */
export function resolveMiniTreeParentPath(
  segmentPath: string,
  rootPath: string | null
): string | null {
  const separatorIndex = lastSeparatorIndex(segmentPath);
  if (separatorIndex <= 0) {
    return null;
  }
  const parent = segmentPath.slice(0, separatorIndex);
  if (rootPath !== null && parent.length <= rootPath.length) {
    // The parent is the workspace root itself (or would escape it) — the
    // root level is rendered from the tree's top-level nodes, not a node.
    return null;
  }
  return parent;
}

/**
 * Cumulative ancestor directories (shallowest first, parent included) to feed
 * `loadSpecificPaths` so the parent's children are materialized in a fresh
 * provider. Empty at the root level — the provider loads the root itself.
 */
export function collectMiniTreeLoadChain(
  parentPath: string | null,
  rootPath: string | null
): string[] {
  if (parentPath === null) {
    return [];
  }
  return buildFileBreadcrumbSegments(parentPath, rootPath).map((segment) => segment.path);
}

/** Locate a node by path, descending only through ancestors of the target. */
export function findMiniTreeNode(nodes: readonly IFileNode[], path: string): IFileNode | null {
  for (const candidate of nodes) {
    if (candidate.path === path) {
      return candidate;
    }
    if (
      candidate.type === 'directory' &&
      candidate.children &&
      (path.startsWith(`${candidate.path}/`) || path.startsWith(`${candidate.path}\\`))
    ) {
      const found = findMiniTreeNode(candidate.children, path);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Flatten the parent's contents into visible rows, recursing only into
 * expanded directories. Sentinel node types (loadMore/truncated) are filtered
 * — the popover is a quick navigator; full browsing (incl. huge-directory
 * pagination) lives in the explorer pane. An unknown parent yields [] and the
 * caller renders an explicit unavailable state — never a silent empty tree.
 */
export function flattenMiniTreeEntries(
  fileTree: readonly IFileNode[],
  parentPath: string | null,
  expandedPaths: ReadonlySet<string>
): MiniTreeEntry[] {
  const rootNodes =
    parentPath === null ? fileTree : (findMiniTreeNode(fileTree, parentPath)?.children ?? []);
  const entries: MiniTreeEntry[] = [];
  const visit = (nodes: readonly IFileNode[], depth: number): void => {
    for (const candidate of nodes) {
      if (candidate.type !== 'file' && candidate.type !== 'directory') {
        continue;
      }
      entries.push({ depth, node: candidate });
      if (
        candidate.type === 'directory' &&
        expandedPaths.has(candidate.path) &&
        candidate.children
      ) {
        visit(candidate.children, depth + 1);
      }
    }
  };
  visit(rootNodes, 0);
  return entries;
}
