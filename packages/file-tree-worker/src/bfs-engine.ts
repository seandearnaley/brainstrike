/**
 * BFS Engine
 *
 * Orchestrates breadth-first expand-all operations in the worker.
 * Requests directory loads from the main thread (which has the FileSystemHandles),
 * processes results, and manages tree state.
 */

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
  private readonly pendingLoads = new Map<
    string,
    { paths: string[]; resolve: (results: BatchLoadResult[]) => void }
  >();

  constructor(private readonly postMessage: (msg: WorkerToMainMessage) => void) {}

  /**
   * Set the current tree state.
   */
  setTree(nodes: WorkerFileNode[], _folderId: string): void {
    this.tree = nodes;
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
      const remainingPaths = pending.paths.filter((p) => {
        // Path is done if we got results for it or it had an error
        return p !== path;
      });

      if (remainingPaths.length === 0) {
        // All paths in this batch are loaded, resolve the promise
        const results: BatchLoadResult[] = pending.paths.map((p) => {
          if (p === path) {
            return { path: p, children };
          }
          // Other paths in the batch - they should already be in tree
          return { path: p, children: [] };
        });
        pending.resolve(results);
        this.pendingLoads.delete(requestId);
      } else {
        // Update remaining paths
        pending.paths = remainingPaths;
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
      const remainingPaths = pending.paths.filter((p) => p !== path);

      if (remainingPaths.length === 0) {
        const results: BatchLoadResult[] = pending.paths.map((p) => {
          if (p === path) {
            return { path: p, error };
          }
          return { path: p, children: [] };
        });
        pending.resolve(results);
        this.pendingLoads.delete(requestId);
      } else {
        pending.paths = remainingPaths;
      }
    }
  }

  /**
   * Request main thread to load directories.
   * Returns a promise that resolves when all paths are loaded.
   */
  private requestLoads(paths: string[]): Promise<BatchLoadResult[]> {
    return new Promise((resolve) => {
      const requestId = generateRequestId();

      // Store pending request
      this.pendingLoads.set(requestId, {
        paths: [...paths],
        resolve,
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
   */
  private sendComplete(): void {
    this.postMessage({
      type: 'complete',
      payload: { tree: this.tree, expandedPaths: collectExpandedPaths(this.tree) },
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

    // Start with root-level directories
    let currentWave = new Set<string>();
    collectDirectoryPaths(this.tree, currentWave);
    totalDiscovered = currentWave.size;

    this.logDebug(`[expand-all] Starting with ${currentWave.size} root directories`);

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
    this.sendComplete();
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
   * Collapse all directories (reset tree to only show roots).
   */
  collapseAll(): void {
    // Reset all directories to unloaded state, clear children
    function resetNode(node: WorkerFileNode): WorkerFileNode {
      if (node.type === 'directory') {
        const { children: _children, loadError: _loadError, ...rest } = node;
        return {
          ...rest,
          loadState: 'unloaded',
        };
      }
      return node;
    }

    this.tree = this.tree.map(resetNode);

    this.postMessage({
      type: 'treeSnapshot',
      payload: {
        tree: this.tree,
        expandedPaths: [],
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
   * Load specific directory paths (for restoration).
   * Unlike expandAll, this doesn't do BFS discovery - it only loads the requested paths.
   * Paths should be sorted by depth (shallowest first) to ensure parents load before children.
   */
  async loadPaths(paths: string[]): Promise<void> {
    this.resetAbort();

    if (paths.length === 0) {
      this.sendComplete();
      return;
    }

    const total = paths.length;
    let loadedCount = 0;
    let skippedCount = 0;

    this.logInfo(`[loadPaths] Starting restoration of ${total} directories`);

    // Process paths in batches
    for (let i = 0; i < paths.length && !this.aborted; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      const { toLoad, skipped } = this.filterPathsForLoading(batch);
      skippedCount += skipped;

      if (toLoad.length > 0) {
        this.markBatchAsLoading(toLoad);
        const results = await this.requestLoads(toLoad);

        if (this.aborted) {
          break;
        }

        loadedCount += results.filter((r) => r.children).length;
      }

      this.sendProgress(loadedCount + skippedCount, total, batch[0] ?? '');
      await yieldControl();
    }

    if (this.aborted) {
      this.logInfo('[loadPaths] Aborted');
      return;
    }

    this.logInfo(`[loadPaths] Complete. Loaded ${loadedCount}, skipped ${skippedCount}`);
    this.sendComplete();
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
}
