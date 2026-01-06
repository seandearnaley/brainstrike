/**
 * BFS Engine
 *
 * Orchestrates breadth-first expand-all operations in the worker.
 * Requests directory loads from the main thread (which has the FileSystemHandles),
 * processes results, and manages tree state.
 */

import { checkBudget, createTimer } from '@brainstrike/utils/perf-timing';
import { getPathDepth } from '@brainstrike/utils/tree-operations';

import {
  applyBatchResultsToTree,
  collectDirectoryPaths,
  collectExpandedPaths,
  discoverChildDirectories,
  getUnloadedDirectories,
  setNodeLoadState,
} from './tree-operations';
import type { BatchLoadResult, FlattenedNode, WorkerFileNode, WorkerToMainMessage } from './types';

// ============================================================================
// Performance & Safety Constants
// ============================================================================

/** Number of directories to load per batch */
const BATCH_SIZE = 10;

/** Interval for progress snapshots (ms) - increased to reduce main thread overhead */
const SNAPSHOT_INTERVAL_MS = 1000;

/**
 * Time a batch load operation and check against budget.
 * Uses lightweight timer to avoid performance.mark overhead in worker.
 */
function timeBatchLoad<T>(
  batchSize: number,
  operation: () => Promise<T>,
  onComplete: (durationMs: number, exceededBudget: boolean) => void
): Promise<T> {
  const timer = createTimer();
  return operation().then((result) => {
    const durationMs = timer.elapsed();
    const exceededBudget = checkBudget(`batch-load-${batchSize}`, durationMs, 'expandBatch');
    onComplete(durationMs, exceededBudget);
    return result;
  });
}

/**
 * Maximum depth for expand-all operations.
 * Prevents runaway expansion in deeply nested directory structures.
 * Typical project structures rarely exceed 15 levels deep.
 */
export const MAX_EXPAND_DEPTH = 50;

/**
 * Maximum total directories to expand.
 * Prevents memory exhaustion on large codebases.
 */
export const MAX_EXPAND_DIRECTORIES = 10_000;

/**
 * Yield to the event loop to prevent blocking.
 */
async function yieldControl(): Promise<void> {
  // Workers don't have scheduler.yield, use setTimeout
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * BFS Engine for tree expansion operations.
 */
export class BFSEngine {
  private tree: WorkerFileNode[] = [];
  private aborted = false;
  // Track results per path to avoid race condition with mutated paths array
  private readonly pendingLoads = new Map<
    string,
    {
      paths: Set<string>; // Original paths (immutable)
      results: Map<string, BatchLoadResult>; // Collected results
      resolve: (results: BatchLoadResult[]) => void;
    }
  >();

  constructor(private readonly postMessage: (msg: WorkerToMainMessage) => void) {}

  /**
   * Set the current tree state.
   */
  setTree(nodes: WorkerFileNode[], _folderId: string): void {
    const prevNodeCount = this.countTreeNodes(this.tree);
    const prevLoadedDirs = this.countLoadedDirectories(this.tree);
    this.tree = nodes;
    const newNodeCount = this.countTreeNodes(this.tree);
    const newLoadedDirs = this.countLoadedDirectories(this.tree);
    this.logInfo(
      `[setTree] Tree replaced: ${prevNodeCount} nodes (${prevLoadedDirs} loaded) → ${newNodeCount} nodes (${newLoadedDirs} loaded)`
    );
    // folderId is passed for future use (e.g., multi-root support)
  }

  /**
   * Get the current tree.
   */
  getTree(): WorkerFileNode[] {
    return this.tree;
  }

  /**
   * Handle load result from main thread.
   */
  handleLoadResult(path: string, children: WorkerFileNode[]): void {
    // Update tree with loaded children
    this.tree = applyBatchResultsToTree(this.tree, [{ path, children }]);

    // Check all pending loads to see if any batch is complete
    for (const [requestId, pending] of this.pendingLoads) {
      if (!pending.paths.has(path)) {
        continue;
      }

      // Store the actual result for this path
      pending.results.set(path, { path, children });

      // Check if all paths in this batch have results
      if (pending.results.size === pending.paths.size) {
        // Collect results in order, using actual stored results
        const results = Array.from(pending.paths).map(
          (p) => pending.results.get(p) ?? { path: p, children: [] }
        );
        pending.resolve(results);
        this.pendingLoads.delete(requestId);
      }
    }
  }

  /**
   * Handle load error from main thread.
   */
  handleLoadError(path: string, error: string): void {
    // Update tree with error state
    this.tree = setNodeLoadState(this.tree, path, 'error', error);

    // Check all pending loads
    for (const [requestId, pending] of this.pendingLoads) {
      if (!pending.paths.has(path)) {
        continue;
      }

      // Store the error result for this path
      pending.results.set(path, { path, error });

      // Check if all paths in this batch have results
      if (pending.results.size === pending.paths.size) {
        // Collect results in order, using actual stored results
        const results = Array.from(pending.paths).map(
          (p) => pending.results.get(p) ?? { path: p, children: [] }
        );
        pending.resolve(results);
        this.pendingLoads.delete(requestId);
      }
    }
  }

  /**
   * Request main thread to load directories.
   * Returns a promise that resolves when all paths are loaded.
   */
  private requestLoads(paths: string[]): Promise<BatchLoadResult[]> {
    return new Promise((resolve, reject) => {
      // Check abort before starting
      if (this.aborted) {
        reject(new Error('Operation aborted'));
        return;
      }

      const requestId = generateRequestId();

      // Timeout to prevent hanging forever if main thread doesn't respond
      const LoadTimeoutMs = 30_000;
      const timeoutId = setTimeout(() => {
        this.pendingLoads.delete(requestId);
        reject(new Error(`Load timeout for: ${paths.join(', ')}`));
      }, LoadTimeoutMs);

      // Store pending request with Set for paths and Map for results
      this.pendingLoads.set(requestId, {
        paths: new Set(paths),
        results: new Map(),
        resolve: (results) => {
          clearTimeout(timeoutId);
          resolve(results);
        },
      });

      // Request load from main thread
      this.postMessage({
        type: 'requestLoad',
        payload: {
          requestId,
          paths,
        },
      });
    });
  }

  /**
   * Abort the current operation.
   */
  abort(): void {
    this.aborted = true;
    // Resolve all pending loads with empty results
    for (const [, pending] of this.pendingLoads) {
      pending.resolve([]);
    }
    this.pendingLoads.clear();
  }

  /**
   * Reset abort flag for new operation.
   */
  private resetAbort(): void {
    this.aborted = false;
  }

  /**
   * Log a debug message via the worker protocol.
   */
  private logDebug(message: string): void {
    this.postMessage({ type: 'log', level: 'debug', message });
  }

  /**
   * Log an info message via the worker protocol.
   */
  private logInfo(message: string): void {
    this.postMessage({ type: 'log', level: 'info', message });
  }

  /**
   * Mark directories as loading in tree.
   */
  private markBatchAsLoading(batch: string[]): void {
    for (const path of batch) {
      this.tree = setNodeLoadState(this.tree, path, 'loading');
    }
  }

  /**
   * Send progress update message.
   */
  private sendProgress(loaded: number, total: number, currentPath: string): void {
    this.postMessage({
      type: 'progress',
      payload: { loaded, total, currentPath },
    });
  }

  /**
   * Send tree snapshot message.
   */
  private sendTreeSnapshot(): void {
    this.postMessage({
      type: 'treeSnapshot',
      payload: { tree: this.tree, expandedPaths: collectExpandedPaths(this.tree) },
    });
  }

  /**
   * Send completion message.
   * @param loadedCount - Number of directories actually loaded (0 means all were cached)
   */
  private sendComplete(loadedCount: number): void {
    this.postMessage({
      type: 'complete',
      payload: { tree: this.tree, expandedPaths: collectExpandedPaths(this.tree), loadedCount },
    });
  }

  /**
   * Expand all directories using BFS traversal.
   *
   * Safety limits:
   * - MAX_EXPAND_DEPTH: Stops at maximum depth to prevent runaway expansion
   * - MAX_EXPAND_DIRECTORIES: Limits total directories to prevent memory exhaustion
   */
  async expandAll(): Promise<void> {
    this.resetAbort();

    const processed = new Set<string>();
    let totalDiscovered = 0;
    let loadedCount = 0;
    let maxDepthReached = 0;
    let hitDepthLimit = false;
    let hitDirectoryLimit = false;

    // Log tree state for debugging
    const treeNodeCount = this.countTreeNodes(this.tree);
    const loadedDirs = this.countLoadedDirectories(this.tree);
    this.logInfo(
      `[expand-all] Tree state: ${treeNodeCount} nodes, ${loadedDirs} loaded directories`
    );

    // Start with root-level directories
    let currentWave = new Set<string>();
    collectDirectoryPaths(this.tree, currentWave);
    totalDiscovered = currentWave.size;

    this.logDebug(`[expand-all] Starting with ${currentWave.size} root directories`);

    // Send initial progress immediately so UI shows "0 of X" right away
    this.sendProgress(0, totalDiscovered, '');

    // Throttling for tree snapshots
    let lastSnapshotTime = Date.now();

    while (currentWave.size > 0 && !this.aborted) {
      // Safety check: directory limit
      if (loadedCount >= MAX_EXPAND_DIRECTORIES) {
        hitDirectoryLimit = true;
        this.logInfo(
          `[expand-all] Reached directory limit (${MAX_EXPAND_DIRECTORIES}), stopping expansion`
        );
        break;
      }

      // Filter out directories that exceed depth limit
      const toLoadUnfiltered = getUnloadedDirectories(currentWave, processed, this.tree);
      const toLoad = toLoadUnfiltered.filter((path) => {
        const depth = getPathDepth(path);
        if (depth > maxDepthReached) {
          maxDepthReached = depth;
        }
        if (depth > MAX_EXPAND_DEPTH) {
          hitDepthLimit = true;
          return false;
        }
        return true;
      });

      if (toLoad.length === 0 && toLoadUnfiltered.length > 0) {
        // All remaining directories exceeded depth limit
        this.logInfo(
          `[expand-all] All remaining directories exceed depth limit (${MAX_EXPAND_DEPTH})`
        );
        break;
      }

      // Process batches
      const batchResult = await this.processExpandBatches(
        toLoad,
        loadedCount,
        totalDiscovered,
        lastSnapshotTime
      );

      if (this.aborted) {
        this.logInfo('[expand-all] Aborted');
        return;
      }

      loadedCount = batchResult.loadedCount;
      lastSnapshotTime = batchResult.lastSnapshotTime;

      // Discover child directories from loaded nodes
      const { nextWave, newCount } = discoverChildDirectories(currentWave, processed, this.tree);
      totalDiscovered += newCount;
      currentWave = nextWave;

      await yieldControl();
    }

    // Log completion with safety limit info
    const limitInfo = [];
    if (hitDepthLimit) {
      limitInfo.push(`depth limit ${MAX_EXPAND_DEPTH}`);
    }
    if (hitDirectoryLimit) {
      limitInfo.push(`directory limit ${MAX_EXPAND_DIRECTORIES}`);
    }
    const limitMsg = limitInfo.length > 0 ? ` (hit ${limitInfo.join(', ')})` : '';

    this.logInfo(
      `[expand-all] Complete. Loaded ${loadedCount} directories, max depth ${maxDepthReached}${limitMsg}`
    );
    this.sendComplete(loadedCount);
  }

  /**
   * Process directory batches for expand-all operation.
   * Includes performance timing to detect slow batches.
   */
  private async processExpandBatches(
    toLoad: string[],
    loadedCount: number,
    totalDiscovered: number,
    lastSnapshotTime: number
  ): Promise<{ loadedCount: number; lastSnapshotTime: number }> {
    let currentLoadedCount = loadedCount;
    let currentSnapshotTime = lastSnapshotTime;
    let slowBatchCount = 0;

    for (let i = 0; i < toLoad.length && !this.aborted; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);

      this.markBatchAsLoading(batch);

      // Time the batch load operation against expandBatch budget
      const results = await timeBatchLoad(
        batch.length,
        () => this.requestLoads(batch),
        (durationMs, exceededBudget) => {
          if (exceededBudget) {
            slowBatchCount++;
            this.logDebug(
              `[expand-all] Slow batch: ${batch.length} dirs in ${Math.round(durationMs)}ms`
            );
          }
        }
      );

      if (this.aborted) {
        break;
      }

      currentLoadedCount += results.filter((r) => r.children).length;
      this.sendProgress(currentLoadedCount, totalDiscovered, batch[0] ?? '');

      // Check abort before expensive tree snapshot
      if (this.aborted) {
        break;
      }

      // Send tree snapshot if interval has passed
      const now = Date.now();
      if (now - currentSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        currentSnapshotTime = now;
        this.sendTreeSnapshot();
      }

      await yieldControl();
    }

    // Log summary if there were slow batches
    if (slowBatchCount > 0) {
      this.logInfo(`[expand-all] ${slowBatchCount} batch(es) exceeded performance budget`);
    }

    return { loadedCount: currentLoadedCount, lastSnapshotTime: currentSnapshotTime };
  }

  /**
   * Collapse all directories (hide but keep data cached).
   *
   * Unlike the old implementation, this does NOT reset loadState or clear children.
   * The tree data remains cached so re-expanding doesn't require re-fetching.
   * Only the visual expansion state (expandedPaths) is cleared.
   */
  collapseAll(): void {
    // Tree stays the same - we keep the loaded data cached
    // Only the expandedPaths are cleared to collapse the UI
    this.postMessage({
      type: 'treeSnapshot',
      payload: {
        tree: this.tree,
        expandedPaths: [], // Collapsed - no paths expanded
      },
    });
  }

  /**
   * Flatten the tree for virtualized rendering.
   *
   * Computes a flat list of visible nodes based on the current tree state
   * and the set of expanded paths. This moves the O(n) flattening operation
   * off the main thread.
   *
   * @param expandedPaths - Set of paths that should be considered expanded
   */
  flattenTree(expandedPaths: string[]): void {
    const timer = createTimer();
    const expandedSet = new Set(expandedPaths);
    const result: FlattenedNode[] = [];

    this.flattenNodes(this.tree, 0, expandedSet, result);

    const durationMs = timer.elapsed();

    // Check against flattenTree budget (50ms)
    checkBudget('worker-flattenTree', durationMs, 'flattenTree');

    this.postMessage({
      type: 'flattenedResult',
      payload: {
        nodes: result,
        count: result.length,
        durationMs,
      },
    });
  }

  /**
   * Recursively flatten nodes into the result array.
   * Only includes visible nodes and respects expansion state.
   */
  private flattenNodes(
    nodes: WorkerFileNode[],
    depth: number,
    expandedSet: Set<string>,
    result: FlattenedNode[]
  ): void {
    for (const node of nodes) {
      // Add this node to the flattened list
      result.push({ node, depth });

      // If directory is expanded, loaded, and has children, recurse
      if (
        node.type === 'directory' &&
        expandedSet.has(node.path) &&
        node.loadState === 'loaded' &&
        node.children
      ) {
        this.flattenNodes(node.children, depth + 1, expandedSet, result);
      }
    }
  }

  /**
   * Filter paths that need loading (exist in tree and not already loaded/loading).
   * Returns:
   * - toLoad: paths that should be loaded now
   * - skipped: count of permanently skipped paths (already loaded or not a directory)
   * - notFound: paths that weren't found in tree (may need retry after parents load)
   */
  private filterPathsForLoading(batch: string[]): {
    toLoad: string[];
    skipped: number;
    notFound: string[];
  } {
    const toLoad: string[] = [];
    const notFound: string[] = [];
    let skipped = 0;
    const skipReasons: { path: string; reason: string }[] = [];

    for (const path of batch) {
      const node = this.findNode(path);
      if (!node) {
        // Node not found - may appear later after parent loads
        notFound.push(path);
        skipReasons.push({ path, reason: 'node not found in tree' });
        continue;
      }
      if (node.type !== 'directory') {
        skipped++;
        skipReasons.push({ path, reason: `not a directory (type: ${node.type})` });
        continue;
      }
      if (node.loadState === 'loaded' || node.loadState === 'loading') {
        skipped++;
        skipReasons.push({ path, reason: `already ${node.loadState}` });
        continue;
      }
      toLoad.push(path);
    }

    // Log skip reasons if any paths were skipped or not found
    if (skipReasons.length > 0) {
      const skipReasonsStr = skipReasons
        .slice(0, 5)
        .map((r) => `${r.path}: ${r.reason}`)
        .join(', ');
      const rootPaths = this.tree
        .slice(0, 5)
        .map((n) => n.path)
        .join(', ');
      this.logDebug(
        `[filterPathsForLoading] ${batch.length} paths: ${toLoad.length} to load, ${skipped} skipped, ${notFound.length} not found. Details: [${skipReasonsStr}]. Tree roots: [${rootPaths}]`
      );
    }

    return { toLoad, skipped, notFound };
  }

  /**
   * Group paths by depth level.
   * Uses getPathDepth from @brainstrike/utils to avoid duplication.
   */
  private groupPathsByDepth(paths: string[]): Map<number, string[]> {
    const groups = new Map<number, string[]>();
    for (const path of paths) {
      const depth = getPathDepth(path);
      const group = groups.get(depth) ?? [];
      group.push(path);
      groups.set(depth, group);
    }
    return groups;
  }

  /**
   * Process a batch of paths for loadPaths operation.
   * Returns not found paths that may need retry.
   */
  private async processLoadPathsBatch(
    batch: string[],
    counters: { loadedCount: number; skippedCount: number },
    total: number
  ): Promise<{ notFound: string[]; aborted: boolean }> {
    const { toLoad, skipped, notFound } = this.filterPathsForLoading(batch);
    counters.skippedCount += skipped;

    if (toLoad.length > 0) {
      this.markBatchAsLoading(toLoad);
      const results = await this.requestLoads(toLoad);

      if (this.aborted) {
        return { notFound: [], aborted: true };
      }

      counters.loadedCount += results.filter((r) => r.children).length;
    }

    this.sendProgress(counters.loadedCount + counters.skippedCount, total, batch[0] ?? '');
    await yieldControl();
    return { notFound, aborted: false };
  }

  /**
   * Process all paths at a given set of depth levels, returning not found paths.
   * Used by loadPaths for both initial processing and retries.
   */
  private async processPathsByDepth(
    paths: string[],
    counters: { loadedCount: number; skippedCount: number },
    total: number
  ): Promise<string[]> {
    const notFoundPaths: string[] = [];
    const depthGroups = this.groupPathsByDepth(paths);
    const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);

    for (const depth of sortedDepths) {
      if (this.aborted) {
        break;
      }

      const pathsAtDepth = depthGroups.get(depth) ?? [];

      for (let i = 0; i < pathsAtDepth.length && !this.aborted; i += BATCH_SIZE) {
        const batch = pathsAtDepth.slice(i, i + BATCH_SIZE);
        const result = await this.processLoadPathsBatch(batch, counters, total);
        if (result.aborted) {
          return notFoundPaths;
        }
        notFoundPaths.push(...result.notFound);
      }
    }

    return notFoundPaths;
  }

  /**
   * Load specific directory paths (for restoration).
   * Unlike expandAll, this doesn't do BFS discovery - it only loads the requested paths.
   *
   * IMPORTANT: Paths are processed by depth level to ensure parents load before children.
   * This prevents "Handle not found" errors when a child path is in the same batch as its parent,
   * since the parent's handles must be added to the map before the child can be loaded.
   *
   * Paths that aren't found in the tree are collected and retried after all depths are processed,
   * since they may become available after their parent directories are loaded.
   */
  async loadPaths(paths: string[]): Promise<void> {
    this.resetAbort();

    if (paths.length === 0) {
      this.sendComplete(0);
      return;
    }

    const total = paths.length;
    const counters = { loadedCount: 0, skippedCount: 0 };

    this.logInfo(`[loadPaths] Starting restoration of ${total} directories`);

    // Initial pass - process all paths by depth
    let pathsToRetry = await this.processPathsByDepth(paths, counters, total);

    // Retry paths that weren't found initially (they may exist now after parents loaded)
    // Use multiple retry rounds since deeper children may need multiple parent loads
    const maxRetries = 3;
    for (let retry = 0; retry < maxRetries && pathsToRetry.length > 0 && !this.aborted; retry++) {
      this.logInfo(
        `[loadPaths] Retry ${retry + 1}/${maxRetries}: ${pathsToRetry.length} paths not found initially`
      );
      pathsToRetry = await this.processPathsByDepth(pathsToRetry, counters, total);
    }

    // Count remaining not found paths as skipped
    if (pathsToRetry.length > 0) {
      const samplePaths = pathsToRetry.slice(0, 3).join(', ');
      const suffix = pathsToRetry.length > 3 ? '...' : '';
      this.logDebug(
        `[loadPaths] ${pathsToRetry.length} paths still not found after retries: ${samplePaths}${suffix}`
      );
      counters.skippedCount += pathsToRetry.length;
    }

    if (this.aborted) {
      this.logInfo('[loadPaths] Aborted');
      return;
    }

    this.logInfo(
      `[loadPaths] Complete. Loaded ${counters.loadedCount}, skipped ${counters.skippedCount}`
    );
    this.sendComplete(counters.loadedCount);
  }

  /**
   * Find a node by path in the tree.
   */
  private findNode(targetPath: string): WorkerFileNode | null {
    function search(nodes: WorkerFileNode[]): WorkerFileNode | null {
      for (const node of nodes) {
        if (node.path === targetPath) {
          return node;
        }
        if (targetPath.startsWith(`${node.path}/`) && node.children) {
          const found = search(node.children);
          if (found) {
            return found;
          }
        }
      }
      return null;
    }
    return search(this.tree);
  }

  /**
   * Count total nodes in the tree (for debugging).
   */
  private countTreeNodes(nodes: WorkerFileNode[]): number {
    let count = 0;
    for (const node of nodes) {
      count += 1;
      if (node.children) {
        count += this.countTreeNodes(node.children);
      }
    }
    return count;
  }

  /**
   * Count directories with loadState='loaded' (for debugging).
   */
  private countLoadedDirectories(nodes: WorkerFileNode[]): number {
    let count = 0;
    for (const node of nodes) {
      if (node.type === 'directory' && node.loadState === 'loaded') {
        count += 1;
      }
      if (node.children) {
        count += this.countLoadedDirectories(node.children);
      }
    }
    return count;
  }
}
