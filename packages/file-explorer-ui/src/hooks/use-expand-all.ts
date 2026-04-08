/**
 * Expand All Hook
 *
 * Manages expand-all operation state and orchestration.
 * Uses a batched renderer-side traversal session so large trees progressively
 * reveal expanded directories instead of waiting for one final commit.
 *
 * @module use-expand-all
 */

import type { IFileNode } from '@brainstrike/types';
import { isAbortError } from '@brainstrike/utils/error-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { startTransition, useCallback, useRef, useState } from 'react';

import { createDirectDirectoryTraversalSession } from './direct-directory-traversal';

const logger = createLogger('ExpandAll');

interface ExpandAllBatchConfig {
  maxBatchDurationMs?: number;
  maxConcurrentLoads?: number;
  maxDirectories?: number;
  maxDirectoriesPerBatch?: number;
}

interface ExpandAllMetrics {
  batchCount: number;
  commitDurationMs: number;
  committedBatchCount: number;
  discoveryDurationMs: number;
}

const defaultYieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function shouldSkipExpandAll(isAlreadyStarting: boolean): { skip: boolean; reason?: string } {
  if (isAlreadyStarting) {
    return { skip: true, reason: 'blocked by double-click guard' };
  }
  return { skip: false };
}

function handleExpandError(err: unknown, onError?: (error: Error) => void): void {
  const isCancelled = isAbortError(err);
  if (!isCancelled) {
    logger.error('expandAllProgressively: error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (!isCancelled && onError) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

function commitExpandedPathsBatch(args: {
  committedPaths: Set<string>;
  paths: readonly string[];
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
}): boolean {
  const { committedPaths, paths, setExpandedPaths } = args;
  if (paths.length === 0) {
    return false;
  }

  let hasNewPaths = false;
  const batchPaths: string[] = [];
  for (const path of paths) {
    if (committedPaths.has(path)) {
      continue;
    }
    committedPaths.add(path);
    batchPaths.push(path);
    hasNewPaths = true;
  }

  if (!hasNewPaths) {
    return false;
  }

  startTransition(() => {
    setExpandedPaths((previousPaths) => {
      let nextPaths: Set<string> | null = null;
      for (const path of batchPaths) {
        if ((nextPaths ?? previousPaths).has(path)) {
          continue;
        }
        if (!nextPaths) {
          nextPaths = new Set(previousPaths);
        }
        nextPaths.add(path);
      }
      return nextPaths ?? previousPaths;
    });
  });

  return true;
}

function beginExpandAllOperation(args: {
  isExpandAllStartingRef: React.RefObject<boolean>;
  isExpandingAllRef: React.RefObject<boolean>;
  setState: React.Dispatch<React.SetStateAction<ExpandAllState>>;
}): void {
  const { isExpandAllStartingRef, isExpandingAllRef, setState } = args;
  isExpandAllStartingRef.current = true;
  isExpandingAllRef.current = true;
  setState({ isExpandingAll: true });
}

function resetExpandAllOperation(args: {
  isExpandAllStartingRef: React.RefObject<boolean>;
  isExpandingAllRef: React.RefObject<boolean>;
}): void {
  const { isExpandAllStartingRef, isExpandingAllRef } = args;
  isExpandAllStartingRef.current = false;
  isExpandingAllRef.current = false;
}

function createEmptyExpandAllMetrics(): ExpandAllMetrics {
  return {
    batchCount: 0,
    commitDurationMs: 0,
    committedBatchCount: 0,
    discoveryDurationMs: 0,
  };
}

function logExpandAllOutcome(args: {
  discoveredDirectories: number;
  metrics: ExpandAllMetrics;
  outcome: 'cancelled' | 'completed';
  rootFolderId: string;
  startedAt: number;
  now: () => number;
}): void {
  const { discoveredDirectories, metrics, outcome, rootFolderId, startedAt, now } = args;
  logger.info(`expandAllProgressively: ${outcome}`, {
    ...metrics,
    discoveredDirectories,
    rootFolderId,
    totalDurationMs: now() - startedAt,
  });
}

async function runExpandAllSession(args: {
  batchConfig: ExpandAllBatchConfig | undefined;
  committedPaths: Set<string>;
  getNodeByPath: (path: string) => IFileNode | undefined;
  getRootNodes: () => IFileNode[];
  isExpandingAllRef: React.RefObject<boolean>;
  loadDirectoryPath: (path: string) => Promise<void>;
  now: () => number;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
  sessionId: number;
  sessionIdRef: React.RefObject<number>;
  setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void;
  yieldToBrowser: () => Promise<void>;
}): Promise<{
  discoveredDirectories: number;
  metrics: ExpandAllMetrics;
}> {
  const {
    batchConfig,
    committedPaths,
    getNodeByPath,
    getRootNodes,
    isExpandingAllRef,
    loadDirectoryPath,
    now,
    onProgress,
    sessionId,
    sessionIdRef,
    setExpandedPaths,
    yieldToBrowser,
  } = args;
  const initialPaths = getRootNodes()
    .filter((node) => node.type === 'directory')
    .map((node) => node.path);
  const metrics = createEmptyExpandAllMetrics();

  commitExpandedPathsBatch({
    committedPaths,
    paths: initialPaths,
    setExpandedPaths,
  });

  const traversalSession = createDirectDirectoryTraversalSession(initialPaths, {
    getDirectoryByPath: getNodeByPath,
    isActive: () => isExpandingAllRef.current && sessionIdRef.current === sessionId,
    loadDirectoryPath,
    now,
    onProgress,
    ...batchConfig,
  });

  while (isExpandingAllRef.current && sessionIdRef.current === sessionId) {
    const batchStartedAt = now();
    const batch = await traversalSession.processNextBatch();
    metrics.discoveryDurationMs += now() - batchStartedAt;

    if (batch.cancelled) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    metrics.batchCount += 1;
    const commitStartedAt = now();
    const committedBatch = commitExpandedPathsBatch({
      committedPaths,
      paths: batch.newlyDiscoveredPaths,
      setExpandedPaths,
    });
    metrics.commitDurationMs += now() - commitStartedAt;
    if (committedBatch) {
      metrics.committedBatchCount += 1;
    }

    if (batch.complete) {
      return {
        discoveredDirectories: traversalSession.snapshot().discoveredPaths.size,
        metrics,
      };
    }

    await yieldToBrowser();
  }

  throw new DOMException('Operation aborted', 'AbortError');
}

export interface ExpandAllState {
  isExpandingAll: boolean;
}

export interface UseExpandAllOptions {
  batchConfig?: ExpandAllBatchConfig;
  cancelLoadOperations: () => void;
  getNodeByPath: (path: string) => IFileNode | undefined;
  getRootNodes: () => IFileNode[];
  loadDirectoryPath: (path: string) => Promise<void>;
  now?: () => number;
  onError?: (error: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
  rootFolderId: string;
  yieldToBrowser?: () => Promise<void>;
}

export interface UseExpandAllReturn {
  cancelExpandAll: () => void;
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
  ) => Promise<void>;
  isExpandingAll: boolean;
  isExpandingAllRef: React.RefObject<boolean>;
}

export function useExpandAll(options: UseExpandAllOptions): UseExpandAllReturn {
  const {
    batchConfig,
    cancelLoadOperations,
    getNodeByPath,
    getRootNodes,
    loadDirectoryPath,
    now = () => performance.now(),
    onError,
    onProgress,
    rootFolderId,
    yieldToBrowser = defaultYieldToBrowser,
  } = options;

  const [state, setState] = useState<ExpandAllState>({
    isExpandingAll: false,
  });

  const isExpandAllStartingRef = useRef(false);
  const isExpandingAllRef = useRef(false);
  const sessionIdRef = useRef(0);

  const cancelExpandAll = useCallback(() => {
    sessionIdRef.current += 1;
    cancelLoadOperations();
    resetExpandAllOperation({
      isExpandAllStartingRef,
      isExpandingAllRef,
    });
    setState({ isExpandingAll: false });
  }, [cancelLoadOperations]);

  const expandAllProgressively = useCallback(
    async (
      setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void
    ): Promise<void> => {
      const skipCheck = shouldSkipExpandAll(isExpandAllStartingRef.current);
      if (skipCheck.skip) {
        if (skipCheck.reason) {
          logger.debug(`expandAllProgressively: ${skipCheck.reason}`);
        }
        return;
      }

      beginExpandAllOperation({
        isExpandAllStartingRef,
        isExpandingAllRef,
        setState,
      });
      const startedAt = now();
      const sessionId = sessionIdRef.current + 1;
      sessionIdRef.current = sessionId;

      const committedPaths = new Set<string>();

      try {
        const result = await runExpandAllSession({
          batchConfig,
          committedPaths,
          getNodeByPath,
          getRootNodes,
          isExpandingAllRef,
          loadDirectoryPath,
          now,
          onProgress,
          sessionId,
          sessionIdRef,
          setExpandedPaths,
          yieldToBrowser,
        });
        logExpandAllOutcome({
          discoveredDirectories: result.discoveredDirectories,
          metrics: result.metrics,
          outcome: 'completed',
          rootFolderId,
          startedAt,
          now,
        });
        setState({ isExpandingAll: false });
      } catch (err) {
        if (isAbortError(err)) {
          logExpandAllOutcome({
            discoveredDirectories: committedPaths.size,
            metrics: createEmptyExpandAllMetrics(),
            outcome: 'cancelled',
            rootFolderId,
            startedAt,
            now,
          });
        }
        handleExpandError(err, onError);
        setState({ isExpandingAll: false });
      } finally {
        resetExpandAllOperation({
          isExpandAllStartingRef,
          isExpandingAllRef,
        });
      }
    },
    [
      batchConfig,
      getNodeByPath,
      getRootNodes,
      loadDirectoryPath,
      now,
      onError,
      onProgress,
      rootFolderId,
      yieldToBrowser,
    ]
  );

  return {
    isExpandingAll: state.isExpandingAll,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAllRef,
  };
}
