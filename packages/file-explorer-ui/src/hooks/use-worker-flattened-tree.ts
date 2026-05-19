/**
 * Worker Flattened Tree Hook
 *
 * Provides worker-backed tree flattening for large trees.
 * Uses main thread flattening for small trees (fast enough)
 * and worker flattening for large trees (>WORKER_THRESHOLD nodes).
 *
 * @module use-worker-flattened-tree
 */

import type { FileTreeWorkerPort, FlattenedNode } from '@brainstrike/file-tree-worker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { recordFileTreeTelemetry } from '../utils/file-tree-telemetry';

/**
 * Node count threshold above which we use worker flattening.
 * Below this, main thread flattening is fast enough (~0.5ms for 7K nodes).
 */
const WORKER_THRESHOLD = 10_000;

export interface UseWorkerFlattenedTreeOptions {
  /** Approximate node count (for threshold decision) */
  approximateNodeCount: number;
  /** Current set of expanded directory paths */
  expandedPaths: Set<string>;
  /** Whether to force worker flattening regardless of threshold */
  forceWorker?: boolean;
  /** Ref to the worker port */
  portRef: React.RefObject<FileTreeWorkerPort | null>;
  /** Token that changes when tree contents mutate without expansion changes */
  treeRevision?: unknown;
}

export interface UseWorkerFlattenedTreeReturn {
  /** Latest flattened result from worker (null if not available) */
  flattenedNodes: FlattenedNode[] | null;
  /** Whether worker flattening is enabled (based on threshold) */
  isWorkerEnabled: boolean;
  /** Duration of last flatten operation in ms */
  lastDurationMs: number | null;
  /** Request worker to flatten the tree */
  requestFlatten: () => void;
}

/**
 * Hook for worker-backed tree flattening.
 *
 * Uses threshold-based switching:
 * - Below WORKER_THRESHOLD: Returns null, caller should use main thread flattening
 * - Above WORKER_THRESHOLD: Uses worker flattening
 *
 * @param options - Configuration options
 * @returns Worker flattening state and controls
 */
export function useWorkerFlattenedTree(
  options: UseWorkerFlattenedTreeOptions
): UseWorkerFlattenedTreeReturn {
  const {
    portRef,
    expandedPaths,
    approximateNodeCount,
    forceWorker = false,
    treeRevision,
  } = options;

  // State for flattened result
  const [flattenedNodes, setFlattenedNodes] = useState<FlattenedNode[] | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);

  // Track if worker flattening is enabled
  const isWorkerEnabled = forceWorker || approximateNodeCount > WORKER_THRESHOLD;

  // Store cleanup function ref
  const cleanupRef = useRef<(() => void) | null>(null);

  // Register onFlattenedResult handler
  useEffect(() => {
    const port = portRef.current;
    if (!(port && isWorkerEnabled)) {
      return;
    }

    // Register handler for flattened results
    cleanupRef.current = port.onFlattenedResult((nodes, count, durationMs) => {
      setFlattenedNodes(nodes);
      setLastDurationMs(durationMs);
      recordFileTreeTelemetry({
        durationMs,
        event: 'file-tree.flatten',
        nodeCount: count,
        rowCount: nodes.length,
        source: 'worker',
      });
    });

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [portRef, isWorkerEnabled]);

  // Request flatten from worker
  const requestFlatten = useCallback(() => {
    const port = portRef.current;
    if (!(port && isWorkerEnabled)) {
      return;
    }

    // Convert Set to array for worker
    port.flattenTree(Array.from(expandedPaths));
  }, [portRef, expandedPaths, isWorkerEnabled]);

  // Auto-request flatten when visible paths or tree contents change.
  useEffect(() => {
    if (!isWorkerEnabled) {
      return;
    }
    const port = portRef.current;
    if (!port) {
      return;
    }
    port.flattenTree(Array.from(expandedPaths));
  }, [isWorkerEnabled, portRef, expandedPaths, treeRevision]);

  return {
    requestFlatten,
    flattenedNodes,
    isWorkerEnabled,
    lastDurationMs,
  };
}

/**
 * Check if a tree size warrants worker flattening.
 * Useful for pre-emptively deciding before the full tree is known.
 */
export function shouldUseWorkerFlattening(nodeCount: number): boolean {
  return nodeCount > WORKER_THRESHOLD;
}
