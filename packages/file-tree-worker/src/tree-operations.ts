/**
 * Tree Operations
 *
 * Worker-specific tree operations that extend the shared utilities.
 * Generic operations are imported from @brainstrike/utils.
 */

import {
  canLoadNode as canLoadNodeGeneric,
  collectDirectoryPaths as collectDirectoryPathsGeneric,
  collectExpandedPaths as collectExpandedPathsGeneric,
  findNodeByPath as findNodeByPathGeneric,
  needsLoading as needsLoadingGeneric,
  setNodeLoadState as setNodeLoadStateGeneric,
  sortTreeNodes,
  updateNodeChildren as updateNodeChildrenGeneric,
} from '@brainstrike/utils/tree-operations';
import type { BatchLoadResult, DirectoryLoadState, WorkerFileNode } from './types';

// Re-export generic functions typed for WorkerFileNode
export function sortFileNodes(nodes: WorkerFileNode[]): WorkerFileNode[] {
  return sortTreeNodes(nodes);
}

export function findNodeByPath(tree: WorkerFileNode[], targetPath: string): WorkerFileNode | null {
  return findNodeByPathGeneric(tree, targetPath);
}

export function needsLoading(node: WorkerFileNode): boolean {
  return needsLoadingGeneric(node);
}

export function updateNodeChildren(
  tree: WorkerFileNode[],
  targetPath: string,
  children: WorkerFileNode[],
  loadState: DirectoryLoadState = 'loaded'
): WorkerFileNode[] {
  return updateNodeChildrenGeneric(tree, targetPath, children, loadState);
}

export function setNodeLoadState(
  tree: WorkerFileNode[],
  targetPath: string,
  loadState: DirectoryLoadState,
  error?: string
): WorkerFileNode[] {
  return setNodeLoadStateGeneric(tree, targetPath, loadState, error);
}

export function collectDirectoryPaths(nodes: WorkerFileNode[], paths: Set<string>): void {
  collectDirectoryPathsGeneric(nodes, paths);
}

export function canLoadNode(node: WorkerFileNode | null | undefined): node is WorkerFileNode {
  return canLoadNodeGeneric(node);
}

export function collectExpandedPaths(tree: WorkerFileNode[]): string[] {
  return collectExpandedPathsGeneric(tree);
}

/**
 * Get directories that need loading from a wave of paths.
 * Worker-specific: orchestrates BFS expansion.
 */
export function getUnloadedDirectories(
  currentWave: Set<string>,
  processed: Set<string>,
  tree: WorkerFileNode[]
): string[] {
  const toLoad: string[] = [];
  for (const path of currentWave) {
    if (processed.has(path)) {
      continue;
    }
    processed.add(path);
    const node = findNodeByPath(tree, path);
    if (canLoadNode(node)) {
      toLoad.push(path);
    }
  }
  return toLoad;
}

/**
 * Discover child directories from loaded nodes.
 * Worker-specific: orchestrates BFS expansion.
 */
export function discoverChildDirectories(
  currentWave: Set<string>,
  processed: Set<string>,
  tree: WorkerFileNode[]
): { nextWave: Set<string>; newCount: number } {
  const nextWave = new Set<string>();
  let newCount = 0;
  for (const path of currentWave) {
    const node = findNodeByPath(tree, path);
    if (node?.children) {
      for (const child of node.children) {
        if (child.type === 'directory' && !processed.has(child.path)) {
          nextWave.add(child.path);
          newCount++;
        }
      }
    }
  }
  return { newCount, nextWave };
}

/**
 * Apply batch results to the tree.
 * Worker-specific: handles BatchLoadResult format.
 */
export function applyBatchResultsToTree(
  tree: WorkerFileNode[],
  results: BatchLoadResult[]
): WorkerFileNode[] {
  let newTree = tree;
  for (const result of results) {
    if (result.children) {
      newTree = updateNodeChildren(newTree, result.path, result.children, 'loaded');
    } else if (result.error) {
      newTree = setNodeLoadState(newTree, result.path, 'error', result.error);
    }
  }
  return newTree;
}
