/**
 * Worker Node Conversion Utilities
 *
 * Helpers for converting between IFileNode (with FileNodeHandle)
 * and WorkerFileNode (transferable to worker, no handle).
 */

import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';

const logger = createLogger('WorkerNodeConversion');

/**
 * Convert an IFileNode to a WorkerFileNode by stripping the handle.
 * The path serves as the handleKey for looking up handles on the main thread.
 *
 * NOTE: 'loadMore' and 'truncated' nodes are UI-only placeholders and are
 * filtered out.
 */
export function toWorkerFileNode(node: IFileNode): WorkerFileNode | null {
  // Skip 'loadMore'/'truncated' nodes - they're UI-only placeholders
  if (node.type === 'loadMore' || node.type === 'truncated') {
    return null;
  }

  const workerNode: WorkerFileNode = {
    depth: node.depth,
    name: node.name,
    path: node.path,
    rootFolderId: node.rootFolderId,
    type: node.type, // Now guaranteed to be 'file' | 'directory'
  };

  // Copy optional properties if present
  if (node.loadState !== undefined) {
    workerNode.loadState = node.loadState;
  }
  if (node.loadError !== undefined) {
    workerNode.loadError = node.loadError;
  }
  if (node.size !== undefined) {
    workerNode.size = node.size;
  }
  if (node.lastModified !== undefined) {
    workerNode.lastModified = node.lastModified;
  }

  // Recursively convert children, filtering out nulls (loadMore nodes)
  if (node.children) {
    workerNode.children = node.children
      .map(toWorkerFileNode)
      .filter((child): child is WorkerFileNode => child !== null);
  }

  return workerNode;
}

/**
 * Convert an array of IFileNodes to WorkerFileNodes.
 * Filters out 'loadMore'/'truncated' UI placeholder nodes.
 */
export function toWorkerFileNodes(nodes: IFileNode[]): WorkerFileNode[] {
  return nodes.map(toWorkerFileNode).filter((node): node is WorkerFileNode => node !== null);
}

/** Type for the handle stored in the handle map */
type FileNodeHandle = IFileNode['handle'];

/**
 * Convert a WorkerFileNode back to an IFileNode by rehydrating handles from the map.
 * Returns null if the handle is not found (should not happen in normal operation).
 */
export function rehydrateFileNode(
  workerNode: WorkerFileNode,
  handleMap: Map<string, FileNodeHandle>
): IFileNode | null {
  const handle = handleMap.get(workerNode.path);

  // Handle must exist for a valid IFileNode
  if (!handle) {
    logger.warn('rehydrateFileNode: No handle found', {
      handleMapSize: handleMap.size,
      path: workerNode.path,
      type: workerNode.type,
    });
    return null;
  }

  const fileNode: IFileNode = {
    depth: workerNode.depth,
    handle,
    name: workerNode.name,
    path: workerNode.path,
    rootFolderId: workerNode.rootFolderId,
    selectionState: 'unchecked', // Default selection state for rehydrated nodes
    type: workerNode.type,
  };

  // Copy optional properties if present
  if (workerNode.loadState !== undefined) {
    fileNode.loadState = workerNode.loadState;
  }
  if (workerNode.loadError !== undefined) {
    fileNode.loadError = workerNode.loadError;
  }
  if (workerNode.size !== undefined) {
    fileNode.size = workerNode.size;
  }
  if (workerNode.lastModified !== undefined) {
    fileNode.lastModified = workerNode.lastModified;
  }

  // Recursively rehydrate children, filtering out any that couldn't be rehydrated
  if (workerNode.children) {
    fileNode.children = workerNode.children
      .map((child) => rehydrateFileNode(child, handleMap))
      .filter((child): child is IFileNode => child !== null);
  }

  return fileNode;
}

/**
 * Rehydrate an entire tree of WorkerFileNodes to IFileNodes.
 * Filters out nodes that don't have handles in the map.
 */
export function rehydrateTree(
  workerNodes: WorkerFileNode[],
  handleMap: Map<string, FileNodeHandle>
): IFileNode[] {
  const results = workerNodes.map((node) => rehydrateFileNode(node, handleMap));
  const validNodes = results.filter((node): node is IFileNode => node !== null);
  const filteredCount = results.length - validNodes.length;

  if (filteredCount > 0) {
    logger.warn('rehydrateTree: Some root nodes filtered out', {
      filteredOut: filteredCount,
      handleMapSize: handleMap.size,
      totalWorkerNodes: workerNodes.length,
      validNodes: validNodes.length,
    });
  }

  return validNodes;
}

/**
 * Build a handle map from an IFileNode tree.
 * This extracts all handles for lookup during worker communication.
 */
export function buildHandleMap(
  nodes: IFileNode[],
  map: Map<string, FileNodeHandle> = new Map(),
  isTopLevel = true
): Map<string, FileNodeHandle> {
  for (const node of nodes) {
    if (node.handle) {
      map.set(node.path, node.handle);
    }
    if (node.children) {
      buildHandleMap(node.children, map, false);
    }
  }

  // Only log at top level to avoid spam
  if (isTopLevel) {
    logger.info('buildHandleMap complete', {
      handleMapSize: map.size,
      inputNodes: nodes.length,
    });
  }

  return map;
}

/**
 * Add handles from newly loaded children to the handle map.
 */
export function addHandlesToMap(nodes: IFileNode[], map: Map<string, FileNodeHandle>): void {
  for (const node of nodes) {
    if (node.handle) {
      map.set(node.path, node.handle);
    }
    if (node.children) {
      addHandlesToMap(node.children, map);
    }
  }
}

/** Re-export the FileNodeHandle type for consumers */
export type { FileNodeHandle };
