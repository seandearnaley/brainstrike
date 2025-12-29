/**
 * BFS Engine
 *
 * Orchestrates breadth-first expand-all operations in the worker.
 * Requests directory loads from the main thread (which has the FileSystemHandles),
 * processes results, and manages tree state.
 */

import { getPathDepth } from '@brainstrike/utils/tree-operations';

import {
  applyBatchResultsToTree,
  collectDirectoryPaths,
  collectExpandedPaths,
  discoverChildDirectories,
  getUnloadedDirectories,
  setNodeLoadState,
} from './tree-operations';
import type { BatchLoadResult, WorkerFileNode, WorkerToMainMessage } from './types';

/** Number of directories to load per batch */
const BATCH_SIZE = 10;

/** Interval for progress snapshots (ms) - increased to reduce main thread overhead */
const SNAPSHOT_INTERVAL_MS = 1000;

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
   */
  async expandAll(): Promise<void> {
    this.resetAbort();

    const processed = new Set<string>();
    let totalDiscovered = 0;
    let loadedCount = 0;

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
      const toLoad = getUnloadedDirectories(currentWave, processed, this.tree);
      this.logDebug(`[expand-all] Wave has ${currentWave.size} dirs, toLoad: ${toLoad.length}`);

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

      this.logDebug(`[expand-all] Discovered ${newCount} new dirs, nextWave: ${nextWave.size}`);
      currentWave = nextWave;

      await yieldControl();
    }

    this.logInfo(`[expand-all] Complete. Loaded ${loadedCount} directories`);
    this.sendComplete(loadedCount);
  }

  /**
   * Process directory batches for expand-all operation.
   */
  private async processExpandBatches(
    toLoad: string[],
    loadedCount: number,
    totalDiscovered: number,
    lastSnapshotTime: number
  ): Promise<{ loadedCount: number; lastSnapshotTime: number }> {
    let currentLoadedCount = loadedCount;
    let currentSnapshotTime = lastSnapshotTime;

    for (let i = 0; i < toLoad.length && !this.aborted; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);

      this.markBatchAsLoading(batch);
      const results = await this.requestLoads(batch);

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
   * Filter paths that need loading (exist in tree and not already loaded/loading).
   * Returns paths to load and count of skipped paths.
   */
  private filterPathsForLoading(batch: string[]): { toLoad: string[]; skipped: number } {
    const toLoad: string[] = [];
    let skipped = 0;

    for (const path of batch) {
      const node = this.findNode(path);
      if (!node || node.type !== 'directory') {
        skipped++;
        continue;
      }
      if (node.loadState === 'loaded' || node.loadState === 'loading') {
        skipped++;
        continue;
      }
      toLoad.push(path);
    }

    return { toLoad, skipped };
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
   * Returns the count of loaded and skipped paths.
   */
  private async processLoadPathsBatch(
    batch: string[],
    counters: { loadedCount: number; skippedCount: number },
    total: number
  ): Promise<boolean> {
    const { toLoad, skipped } = this.filterPathsForLoading(batch);
    counters.skippedCount += skipped;

    if (toLoad.length > 0) {
      this.markBatchAsLoading(toLoad);
      const results = await this.requestLoads(toLoad);

      if (this.aborted) {
        return false; // Signal abort
      }

      counters.loadedCount += results.filter((r) => r.children).length;
    }

    this.sendProgress(counters.loadedCount + counters.skippedCount, total, batch[0] ?? '');
    await yieldControl();
    return true; // Continue processing
  }

  /**
   * Load specific directory paths (for restoration).
   * Unlike expandAll, this doesn't do BFS discovery - it only loads the requested paths.
   *
   * IMPORTANT: Paths are processed by depth level to ensure parents load before children.
   * This prevents "Handle not found" errors when a child path is in the same batch as its parent,
   * since the parent's handles must be added to the map before the child can be loaded.
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

    // Group paths by depth and process each level sequentially
    // This ensures parent directories load before their children
    const depthGroups = this.groupPathsByDepth(paths);
    const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);

    for (const depth of sortedDepths) {
      if (this.aborted) {
        break;
      }

      const pathsAtDepth = depthGroups.get(depth) ?? [];
      this.logDebug(`[loadPaths] Processing depth ${depth} with ${pathsAtDepth.length} paths`);

      // Process paths at this depth in batches
      for (let i = 0; i < pathsAtDepth.length && !this.aborted; i += BATCH_SIZE) {
        const batch = pathsAtDepth.slice(i, i + BATCH_SIZE);
        const shouldContinue = await this.processLoadPathsBatch(batch, counters, total);
        if (!shouldContinue) {
          break;
        }
      }
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
