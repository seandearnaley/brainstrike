/**
 * BFS Engine
 *
 * Orchestrates breadth-first expand-all operations in the worker.
 * Requests directory loads from the main thread (which has the FileSystemHandles),
 * processes results, and manages tree state.
 */

// Worker bundles must use the crypto subpath to avoid pulling the full utils barrel into esbuild.
import { generateUUID } from '@brainstrike/utils/crypto';
import { checkBudget, createTimer } from '@brainstrike/utils/perf-timing';
import { getPathDepth, isDescendantPath } from '@brainstrike/utils/tree-operations';

import {
  collectDirectoryPaths,
  collectExpandedPaths,
  discoverChildDirectories,
  getUnloadedDirectories,
} from './tree-operations';
import type {
  BatchLoadResult,
  DirectoryLoadState,
  FlattenedNode,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

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
  return `req_${generateUUID()}`;
}

/**
 * State object for subtree loading operations.
 * Tracks progress through BFS waves of directory loading.
 */
interface SubtreeLoadState {
  /** Current wave of directories to process */
  currentWave: Set<string>;
  /** Whether depth limit was reached */
  hitDepthLimit: boolean;
  /** Whether directory count limit was reached */
  hitDirectoryLimit: boolean;
  /** Number of directories successfully loaded */
  loadedCount: number;
  /** Directories already processed (to avoid duplicates) */
  processed: Set<string>;
  /** Total directories discovered so far */
  totalDiscovered: number;
}

interface IndexedTreeUpdate {
  found: boolean;
  tree: WorkerFileNode[];
  updatedPathNodes: WorkerFileNode[];
  updatedSubtree: WorkerFileNode | null;
}

/**
 * BFS Engine for tree expansion operations.
 */
export class BFSEngine {
  private tree: WorkerFileNode[] = [];
  private aborted = false;
  private readonly expandedPaths = new Set<string>();
  /**
   * Path index for O(1) node lookups.
   * Maps path strings to their corresponding nodes in the tree.
   * Rebuilt when tree structure changes (setTree, handleLoadResult).
   */
  private readonly pathIndex = new Map<string, WorkerFileNode>();
  // Track results per path to avoid race condition with mutated paths array
  private readonly pendingLoads = new Map<
    string,
    {
      operationId: number;
      paths: Set<string>; // Original paths (immutable)
      results: Map<string, BatchLoadResult>; // Collected results
      resolve: (results: BatchLoadResult[]) => void;
    }
  >();

  constructor(private readonly postMessage: (msg: WorkerToMainMessage) => void) {}

  /**
   * Build path index from tree nodes.
   * Reserved for whole-tree replacement and diagnostics. Directory load paths must use
   * subtree-local index maintenance so large trees do not pay O(total-tree) per load.
   */
  private buildPathIndex(nodes: WorkerFileNode[]): void {
    this.pathIndex.clear();
    this.addNodesToPathIndex(nodes);
  }

  /**
   * Set the current tree state.
   */
  setTree(nodes: WorkerFileNode[], _folderId: string): void {
    const prevNodeCount = this.countTreeNodes(this.tree);
    const prevLoadedDirs = this.countLoadedDirectories(this.tree);
    this.tree = nodes;
    // Rebuild path index for O(1) lookups
    this.buildPathIndex(nodes);
    this.replaceExpandedPaths(collectExpandedPaths(nodes));
    const newNodeCount = this.countTreeNodes(this.tree);
    const newLoadedDirs = this.countLoadedDirectories(this.tree);
    this.logInfo(
      `[setTree] Tree replaced: ${prevNodeCount} nodes (${prevLoadedDirs} loaded) → ${newNodeCount} nodes (${newLoadedDirs} loaded), index size: ${this.pathIndex.size}`
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
  handleLoadResult(path: string, children: WorkerFileNode[], requestId?: string): void {
    const operationId = this.resolveLoadOperationId(path, requestId);
    this.applyDirectoryChildrenUpdate(path, children, 'loaded', operationId);

    // Check all pending loads to see if any batch is complete
    for (const [pendingRequestId, pending] of this.pendingLoads) {
      if (requestId !== undefined && pendingRequestId !== requestId) {
        continue;
      }
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
        this.pendingLoads.delete(pendingRequestId);
      }
    }
  }

  /**
   * Apply an externally supplied directory update and emit the same patch protocol as load results.
   *
   * `operationId` is present for bulk-operation load results. The `updateTree` worker message calls
   * this without an operation id so listeners receive live patches without attaching them to a
   * pending bulk-operation result.
   */
  applyDirectoryChildrenUpdate(
    path: string,
    children: WorkerFileNode[],
    loadState: DirectoryLoadState,
    operationId?: number
  ): void {
    const updatedNode = this.updateIndexedNode(path, (node) =>
      this.createNodeWithChildren(node, children, loadState)
    );

    if (!updatedNode) {
      return;
    }

    if (loadState === 'loaded') {
      this.postChildrenLoaded(path, children, operationId);
    } else {
      this.postNodeLoadStateChanged(path, loadState, undefined, operationId);
    }
    this.sendExpandedPathsForDirectoryUpdate(path, children, loadState, operationId);
  }

  /**
   * Handle load error from main thread.
   */
  handleLoadError(path: string, error: string, requestId?: string): void {
    const operationId = this.resolveLoadOperationId(path, requestId);
    const updatedNode = this.updateIndexedNode(path, (node) =>
      this.createNodeWithLoadState(node, 'error', error)
    );

    if (updatedNode) {
      this.postNodeLoadStateChanged(path, 'error', error, operationId);
    }

    // Check all pending loads
    for (const [pendingRequestId, pending] of this.pendingLoads) {
      if (requestId !== undefined && pendingRequestId !== requestId) {
        continue;
      }
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
        this.pendingLoads.delete(pendingRequestId);
      }
    }
  }

  /**
   * Request main thread to load directories.
   * Returns a promise that resolves when all paths are loaded.
   */
  private resolveLoadOperationId(path: string, requestId: string | undefined): number | undefined {
    if (requestId !== undefined) {
      return this.pendingLoads.get(requestId)?.operationId;
    }

    // Id-less load results come only from the legacy non-correlated path. The port keeps a
    // single active bulk operation, so the first pending load containing this path is its owner.
    if (this.pendingLoads.size > 1) {
      this.logWarn(
        `Legacy id-less load result resolved while ${this.pendingLoads.size} loads were pending`
      );
    }
    for (const pending of this.pendingLoads.values()) {
      if (pending.paths.has(path)) {
        return pending.operationId;
      }
    }

    return;
  }

  private requestLoads(paths: string[], operationId: number): Promise<BatchLoadResult[]> {
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
        operationId,
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
        operationId,
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

  private logWarn(message: string): void {
    this.postMessage({ type: 'log', level: 'warn', message });
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
  private markBatchAsLoading(batch: string[], operationId: number): void {
    for (const path of batch) {
      const updatedNode = this.updateIndexedNode(path, (node) =>
        this.createNodeWithLoadState(node, 'loading')
      );
      if (updatedNode) {
        this.postNodeLoadStateChanged(path, 'loading', undefined, operationId);
      }
    }
  }

  private updateIndexedNode(
    targetPath: string,
    createNextNode: (node: WorkerFileNode) => WorkerFileNode
  ): WorkerFileNode | null {
    const previousSubtree = this.pathIndex.get(targetPath) ?? null;
    if (!previousSubtree) {
      return null;
    }

    const update = this.replaceIndexedNode(this.tree, targetPath, createNextNode);
    if (!(update.found && update.updatedSubtree)) {
      return null;
    }

    this.removeSubtreeFromPathIndex(previousSubtree);
    this.tree = update.tree;
    for (const node of update.updatedPathNodes) {
      this.pathIndex.set(node.path, node);
    }
    this.addNodeSubtreeToPathIndex(update.updatedSubtree);
    return update.updatedSubtree;
  }

  private replaceIndexedNode(
    nodes: WorkerFileNode[],
    targetPath: string,
    createNextNode: (node: WorkerFileNode) => WorkerFileNode
  ): IndexedTreeUpdate {
    let found = false;
    let updatedSubtree: WorkerFileNode | null = null;
    const updatedPathNodes: WorkerFileNode[] = [];

    const tree = nodes.map((node): WorkerFileNode => {
      if (node.path === targetPath) {
        found = true;
        const nextNode = createNextNode(node);
        updatedSubtree = nextNode;
        updatedPathNodes.push(nextNode);
        return nextNode;
      }

      if (!(node.children && isDescendantPath(targetPath, node.path))) {
        return node;
      }

      const childUpdate = this.replaceIndexedNode(node.children, targetPath, createNextNode);
      if (!childUpdate.found) {
        return node;
      }

      found = true;
      updatedSubtree = childUpdate.updatedSubtree;
      const nextNode = { ...node, children: childUpdate.tree };
      updatedPathNodes.push(nextNode, ...childUpdate.updatedPathNodes);
      return nextNode;
    });

    return { found, tree: found ? tree : nodes, updatedPathNodes, updatedSubtree };
  }

  private createNodeWithChildren(
    node: WorkerFileNode,
    children: WorkerFileNode[],
    loadState: DirectoryLoadState
  ): WorkerFileNode {
    const { loadError: _loadError, ...rest } = node;
    return {
      ...rest,
      children,
      loadState,
    };
  }

  private createNodeWithLoadState(
    node: WorkerFileNode,
    loadState: DirectoryLoadState,
    error?: string
  ): WorkerFileNode {
    const { loadError: _loadError, ...rest } = node;
    const updated: WorkerFileNode = {
      ...rest,
      loadState,
    };
    if (error !== undefined) {
      updated.loadError = error;
    }
    return updated;
  }

  private addNodesToPathIndex(nodes: WorkerFileNode[]): void {
    for (const node of nodes) {
      this.addNodeSubtreeToPathIndex(node);
    }
  }

  private addNodeSubtreeToPathIndex(node: WorkerFileNode): void {
    const queue: WorkerFileNode[] = [node];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (!current) {
        continue;
      }
      this.pathIndex.set(current.path, current);
      if (current.children) {
        for (const child of current.children) {
          queue.push(child);
        }
      }
    }
  }

  private removeSubtreeFromPathIndex(node: WorkerFileNode): void {
    const queue: WorkerFileNode[] = [node];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (!current) {
        continue;
      }
      this.pathIndex.delete(current.path);
      if (current.children) {
        for (const child of current.children) {
          queue.push(child);
        }
      }
    }
  }

  private postChildrenLoaded(
    path: string,
    children: WorkerFileNode[],
    operationId: number | undefined
  ): void {
    this.postMessage({
      type: 'childrenLoaded',
      ...(operationId === undefined ? {} : { operationId }),
      payload: { path, children, loadState: 'loaded' },
    });
  }

  private postNodeLoadStateChanged(
    path: string,
    loadState: DirectoryLoadState,
    loadError?: string,
    operationId?: number
  ): void {
    const payload = loadError === undefined ? { path, loadState } : { path, loadState, loadError };
    this.postMessage({
      type: 'nodeLoadStateChanged',
      ...(operationId === undefined ? {} : { operationId }),
      payload,
    });
  }

  private replaceExpandedPaths(nextPaths: string[]): void {
    this.expandedPaths.clear();
    for (const path of nextPaths) {
      this.expandedPaths.add(path);
    }
  }

  private sendExpandedPathsForDirectoryUpdate(
    path: string,
    children: WorkerFileNode[],
    loadState: DirectoryLoadState,
    operationId?: number
  ): void {
    const nextPaths: string[] = [];
    for (const expandedPath of this.expandedPaths) {
      if (expandedPath === path || isDescendantPath(expandedPath, path)) {
        continue;
      }
      nextPaths.push(expandedPath);
    }

    if (loadState === 'loaded') {
      nextPaths.push(path, ...collectExpandedPaths(children));
    }

    this.sendExpandedPathsDelta(nextPaths, operationId);
  }

  private sendExpandedPathsDelta(nextPaths: string[], operationId?: number): void {
    const nextSet = new Set(nextPaths);
    const added = nextPaths.filter((path) => !this.expandedPaths.has(path));
    const removed = [...this.expandedPaths].filter((path) => !nextSet.has(path));
    this.applyExpandedPathsDelta(nextPaths, added, removed, operationId);
  }

  private applyExpandedPathsDelta(
    nextPaths: string[],
    added: string[],
    removed: string[],
    operationId?: number
  ): void {
    if (added.length > 0 || removed.length > 0) {
      this.postMessage({
        type: 'expandedPathsDelta',
        ...(operationId === undefined ? {} : { operationId }),
        payload: { added, removed },
      });
    }
    this.replaceExpandedPaths(nextPaths);
  }

  /**
   * Send progress update message.
   */
  private sendProgress(
    loaded: number,
    total: number,
    currentPath: string,
    operationId: number
  ): void {
    this.postMessage({
      type: 'progress',
      operationId,
      payload: { loaded, total, currentPath },
    });
  }

  /**
   * Emit an expanded-path delta for the current tree without sending a full-tree snapshot.
   */
  private syncExpandedPaths(operationId: number): void {
    this.sendExpandedPathsDelta(collectExpandedPaths(this.tree), operationId);
  }

  /**
   * Send completion message.
   * @param loadedCount - Number of directories actually loaded (0 means all were cached)
   */
  private sendComplete(loadedCount: number, operationId: number): void {
    this.postMessage({
      type: 'complete',
      operationId,
      payload: { expandedPaths: [...this.expandedPaths], loadedCount },
    });
  }

  /**
   * Expand all directories using BFS traversal.
   *
   * Safety limits:
   * - MAX_EXPAND_DEPTH: Stops at maximum depth to prevent runaway expansion
   * - MAX_EXPAND_DIRECTORIES: Limits total directories to prevent memory exhaustion
   */
  async expandAll(operationId: number): Promise<void> {
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
    this.sendProgress(0, totalDiscovered, '', operationId);

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
        lastSnapshotTime,
        operationId
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
    this.sendComplete(loadedCount, operationId);
  }

  /**
   * Process directory batches for expand-all operation.
   * Includes performance timing to detect slow batches.
   */
  private async processExpandBatches(
    toLoad: string[],
    loadedCount: number,
    totalDiscovered: number,
    lastSnapshotTime: number,
    operationId: number
  ): Promise<{ loadedCount: number; lastSnapshotTime: number }> {
    let currentLoadedCount = loadedCount;
    let currentSnapshotTime = lastSnapshotTime;
    let slowBatchCount = 0;

    for (let i = 0; i < toLoad.length && !this.aborted; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);

      this.markBatchAsLoading(batch, operationId);

      // Time the batch load operation against expandBatch budget
      const results = await timeBatchLoad(
        batch.length,
        () => this.requestLoads(batch, operationId),
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
      this.sendProgress(currentLoadedCount, totalDiscovered, batch[0] ?? '', operationId);

      // Check abort before expensive tree snapshot
      if (this.aborted) {
        break;
      }

      // Send tree snapshot if interval has passed
      const now = Date.now();
      if (now - currentSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        currentSnapshotTime = now;
        this.syncExpandedPaths(operationId);
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
    this.sendExpandedPathsDelta([]);
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
      type: 'flattenedRows',
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
    total: number,
    operationId: number
  ): Promise<{ notFound: string[]; aborted: boolean }> {
    const { toLoad, skipped, notFound } = this.filterPathsForLoading(batch);
    counters.skippedCount += skipped;

    if (toLoad.length > 0) {
      this.markBatchAsLoading(toLoad, operationId);
      const results = await this.requestLoads(toLoad, operationId);

      if (this.aborted) {
        return { notFound: [], aborted: true };
      }

      counters.loadedCount += results.filter((r) => r.children).length;
    }

    this.sendProgress(
      counters.loadedCount + counters.skippedCount,
      total,
      batch[0] ?? '',
      operationId
    );
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
    total: number,
    operationId: number
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
        const result = await this.processLoadPathsBatch(batch, counters, total, operationId);
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
  async loadPaths(paths: string[], operationId: number): Promise<void> {
    this.resetAbort();

    if (paths.length === 0) {
      this.sendComplete(0, operationId);
      return;
    }

    const total = paths.length;
    const counters = { loadedCount: 0, skippedCount: 0 };

    this.logInfo(`[loadPaths] Starting restoration of ${total} directories`);

    // Initial pass - process all paths by depth
    let pathsToRetry = await this.processPathsByDepth(paths, counters, total, operationId);

    // Retry paths that weren't found initially (they may exist now after parents loaded)
    // Use multiple retry rounds since deeper children may need multiple parent loads
    const maxRetries = 3;
    for (let retry = 0; retry < maxRetries && pathsToRetry.length > 0 && !this.aborted; retry++) {
      this.logInfo(
        `[loadPaths] Retry ${retry + 1}/${maxRetries}: ${pathsToRetry.length} paths not found initially`
      );
      pathsToRetry = await this.processPathsByDepth(pathsToRetry, counters, total, operationId);
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
    this.sendComplete(counters.loadedCount, operationId);
  }

  /**
   * Load all descendants of a specific directory (for recursive folder selection).
   * Uses BFS like expandAll but scoped to a subtree starting from the given path.
   *
   * This is used when a user clicks a folder checkbox on an unloaded folder -
   * we need to load all children first before we can collect file paths for selection.
   *
   * Safety limits:
   * - MAX_EXPAND_DEPTH: Relative depth from startPath is capped
   * - MAX_EXPAND_DIRECTORIES: Limits total directories to prevent memory exhaustion
   */
  async loadSubtree(startPath: string, operationId: number): Promise<void> {
    this.resetAbort();

    // Find and validate the start node
    const startNode = this.findNode(startPath);
    if (!this.validateSubtreeStart(startNode, startPath, operationId)) {
      return;
    }

    const baseDepth = getPathDepth(startPath);
    this.logInfo(`[loadSubtree] Starting from ${startPath} (base depth: ${baseDepth})`);

    // Initialize the first wave of directories to load
    const state = this.initializeSubtreeState(startNode as WorkerFileNode, startPath);

    // Send initial progress
    this.sendProgress(0, Math.max(state.totalDiscovered, 1), startPath, operationId);

    // Process waves until complete or aborted
    await this.processSubtreeWaves(state, baseDepth, operationId);

    // Log completion
    this.logSubtreeCompletion(state);
    this.sendComplete(state.loadedCount, operationId);
  }

  /**
   * Validate the start node for subtree loading.
   */
  private validateSubtreeStart(
    startNode: WorkerFileNode | null,
    startPath: string,
    operationId: number
  ): boolean {
    if (!startNode) {
      this.logInfo(`[loadSubtree] Start path not found in tree: ${startPath}`);
      this.sendComplete(0, operationId);
      return false;
    }

    if (startNode.type !== 'directory') {
      this.logInfo(`[loadSubtree] Start path is not a directory: ${startPath}`);
      this.sendComplete(0, operationId);
      return false;
    }

    return true;
  }

  /**
   * Initialize state for subtree loading.
   *
   * Important: We need to discover ALL unloaded directories in the subtree,
   * including those nested under already-loaded directories. This is done
   * via recursive traversal so that clicking a parent folder selects all
   * descendants even if some intermediate directories were previously expanded.
   */
  private initializeSubtreeState(startNode: WorkerFileNode, startPath: string): SubtreeLoadState {
    const currentWave = new Set<string>();

    // Add the start directory if unloaded
    if (startNode.loadState !== 'loaded') {
      currentWave.add(startPath);
    }

    // Recursively discover all unloaded directories in the subtree
    // This handles the case where some directories are already loaded
    // but have unloaded descendants
    if (startNode.children) {
      this.collectUnloadedDescendants(startNode.children, currentWave);
    }

    this.logDebug(`[loadSubtree] Starting with ${currentWave.size} directories to load`);

    return {
      processed: new Set<string>(),
      currentWave,
      totalDiscovered: currentWave.size,
      loadedCount: 0,
      hitDepthLimit: false,
      hitDirectoryLimit: false,
    };
  }

  /**
   * Recursively collect all unloaded directory paths from nodes.
   * Also traverses into loaded directories to find deeper unloaded descendants.
   */
  private collectUnloadedDescendants(nodes: WorkerFileNode[], result: Set<string>): void {
    for (const node of nodes) {
      if (node.type !== 'directory') {
        continue;
      }

      if (node.loadState !== 'loaded') {
        // Unloaded directory - add to wave
        result.add(node.path);
      } else if (node.children) {
        // Loaded directory - traverse into it to find unloaded descendants
        this.collectUnloadedDescendants(node.children, result);
      }
    }
  }

  /**
   * Process BFS waves for subtree loading.
   */
  private async processSubtreeWaves(
    state: SubtreeLoadState,
    baseDepth: number,
    operationId: number
  ): Promise<void> {
    while (state.currentWave.size > 0 && !this.aborted) {
      // Safety check: directory limit
      if (state.loadedCount >= MAX_EXPAND_DIRECTORIES) {
        state.hitDirectoryLimit = true;
        this.logInfo(`[loadSubtree] Reached directory limit (${MAX_EXPAND_DIRECTORIES}), stopping`);
        break;
      }

      // Filter directories to load in this wave
      const { toLoad, hitDepth } = this.filterSubtreeWave(state, baseDepth);
      if (hitDepth) {
        state.hitDepthLimit = true;
      }

      if (toLoad.length === 0) {
        // Discover next wave from current paths
        state.currentWave = this.discoverSubtreeChildren(state);
        continue;
      }

      // Process batches
      const aborted = await this.processSubtreeBatches(toLoad, state, operationId);
      if (aborted) {
        break;
      }

      // Discover next wave
      state.currentWave = this.discoverSubtreeChildren(state);
    }
  }

  /**
   * Filter the current wave to find directories that need loading.
   */
  private filterSubtreeWave(
    state: SubtreeLoadState,
    baseDepth: number
  ): { toLoad: string[]; hitDepth: boolean } {
    const toLoad: string[] = [];
    let hitDepth = false;

    for (const path of state.currentWave) {
      if (state.processed.has(path)) {
        continue;
      }

      const node = this.findNode(path);
      if (!node || node.type !== 'directory') {
        continue;
      }
      if (node.loadState === 'loaded' || node.loadState === 'loading') {
        continue;
      }

      // Check relative depth from startPath
      const relativeDepth = getPathDepth(path) - baseDepth;
      if (relativeDepth > MAX_EXPAND_DEPTH) {
        hitDepth = true;
        continue;
      }

      toLoad.push(path);
    }

    return { toLoad, hitDepth };
  }

  /**
   * Discover child directories from current wave for next iteration.
   */
  private discoverSubtreeChildren(state: SubtreeLoadState): Set<string> {
    const nextWave = new Set<string>();

    for (const path of state.currentWave) {
      state.processed.add(path);
      const node = this.findNode(path);
      if (!node?.children) {
        continue;
      }

      for (const child of node.children) {
        if (
          child.type === 'directory' &&
          child.loadState !== 'loaded' &&
          !state.processed.has(child.path)
        ) {
          nextWave.add(child.path);
          state.totalDiscovered++;
        }
      }
    }

    return nextWave;
  }

  /**
   * Process directory batches for subtree loading.
   * Returns true if aborted.
   */
  private async processSubtreeBatches(
    toLoad: string[],
    state: SubtreeLoadState,
    operationId: number
  ): Promise<boolean> {
    for (let i = 0; i < toLoad.length && !this.aborted; i += BATCH_SIZE) {
      const batch = toLoad.slice(i, i + BATCH_SIZE);

      this.markBatchAsLoading(batch, operationId);
      const results = await this.requestLoads(batch, operationId);

      if (this.aborted) {
        return true;
      }

      state.loadedCount += results.filter((r) => r.children).length;
      this.sendProgress(state.loadedCount, state.totalDiscovered, batch[0] ?? '', operationId);

      // Mark processed
      for (const path of batch) {
        state.processed.add(path);
      }

      await yieldControl();
    }

    return this.aborted;
  }

  /**
   * Log completion info for subtree loading.
   */
  private logSubtreeCompletion(state: SubtreeLoadState): void {
    const limitInfo = [];
    if (state.hitDepthLimit) {
      limitInfo.push(`depth limit ${MAX_EXPAND_DEPTH}`);
    }
    if (state.hitDirectoryLimit) {
      limitInfo.push(`directory limit ${MAX_EXPAND_DIRECTORIES}`);
    }
    const limitMsg = limitInfo.length > 0 ? ` (hit ${limitInfo.join(', ')})` : '';

    this.logInfo(`[loadSubtree] Complete. Loaded ${state.loadedCount} directories${limitMsg}`);
  }

  /**
   * Find a node by path in the tree.
   * Uses O(1) index lookup instead of O(n) recursive search.
   */
  private findNode(targetPath: string): WorkerFileNode | null {
    return this.pathIndex.get(targetPath) ?? null;
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
