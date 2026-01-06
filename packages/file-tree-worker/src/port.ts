/**
 * File Tree Worker Port
 *
 * Provides a typed abstraction over the raw Worker postMessage API.
 * Handles message correlation, event registration, and promise-based operations.
 */

import type {
  BatchLoadResult,
  FlattenedNode,
  MainToWorkerMessage,
  RequestLoadMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

// Handler type aliases for cleaner code
type RequestLoadHandler = (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>;
type ProgressHandler = (loaded: number, total: number, currentPath: string) => void;
type TreeSnapshotHandler = (tree: WorkerFileNode[], expandedPaths: string[]) => void;
type ErrorHandler = (message: string, path?: string) => void;
type LogHandler = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown
) => void;
type FlattenedResultHandler = (nodes: FlattenedNode[], count: number, durationMs: number) => void;

type PendingOperation = {
  resolve: (result: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
    loadedCount: number;
  }) => void;
  reject: (error: Error) => void;
  operationId: number;
};

/**
 * Handle requestLoad message - processes load requests from worker
 */
async function handleRequestLoadMessage(
  msg: RequestLoadMessage,
  worker: Worker,
  requestLoadHandler: RequestLoadHandler | null
): Promise<void> {
  if (!requestLoadHandler) {
    return;
  }

  try {
    const results = await requestLoadHandler(msg.payload.requestId, msg.payload.paths);
    sendLoadResults(worker, results);
  } catch (err) {
    sendLoadErrors(worker, msg.payload.paths, err);
  }
}

/**
 * Send load results back to worker
 */
function sendLoadResults(worker: Worker, results: BatchLoadResult[]): void {
  for (const result of results) {
    if (result.error) {
      worker.postMessage({
        type: 'loadError',
        payload: { path: result.path, error: result.error },
      } satisfies MainToWorkerMessage);
    } else if (result.children) {
      worker.postMessage({
        type: 'loadResult',
        payload: { path: result.path, children: result.children },
      } satisfies MainToWorkerMessage);
    }
  }
}

/**
 * Send load errors for all paths
 */
function sendLoadErrors(worker: Worker, paths: string[], err: unknown): void {
  for (const path of paths) {
    worker.postMessage({
      type: 'loadError',
      payload: {
        path,
        error: err instanceof Error ? err.message : String(err),
      },
    } satisfies MainToWorkerMessage);
  }
}

/**
 * Port abstraction for communicating with the file tree worker.
 */
export type FileTreeWorkerPort = {
  /** Initialize worker with root nodes */
  init(rootNodes: WorkerFileNode[], folderId: string): void;

  /** Start expand-all operation */
  expandAll(folderId: string): Promise<{
    tree: WorkerFileNode[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Load specific paths (for restoration) */
  loadPaths(paths: string[]): Promise<{
    tree: WorkerFileNode[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Collapse all directories */
  collapseAll(): void;

  /** Abort current operation */
  abort(): void;

  /** Update tree with loaded children (single directory) */
  updateTree(path: string, children: WorkerFileNode[]): void;

  /** Send load results back to worker */
  sendLoadResult(path: string, children: WorkerFileNode[]): void;

  /** Send load error back to worker */
  sendLoadError(path: string, error: string): void;

  /** Register handler for load requests from worker */
  onRequestLoad(
    handler: (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>
  ): () => void;

  /** Register handler for progress updates */
  onProgress(handler: (loaded: number, total: number, currentPath: string) => void): () => void;

  /** Register handler for tree snapshots */
  onTreeSnapshot(handler: (tree: WorkerFileNode[], expandedPaths: string[]) => void): () => void;

  /** Register handler for errors */
  onError(handler: (message: string, path?: string) => void): () => void;

  /** Register handler for log messages */
  onLog(
    handler: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void
  ): () => void;

  /** Register handler for flattened tree results */
  onFlattenedResult(
    handler: (nodes: FlattenedNode[], count: number, durationMs: number) => void
  ): () => void;

  /** Request worker to flatten tree with given expanded paths */
  flattenTree(expandedPaths: string[]): void;

  /** Check if worker is ready */
  isReady(): boolean;

  /** Terminate the worker */
  terminate(): void;
};

/**
 * Create a port abstraction for the file tree worker.
 */
export function createFileTreeWorkerPort(worker: Worker): FileTreeWorkerPort {
  let ready = false;

  // Handler registrations (mutable state for callbacks)
  let requestLoadHandler: RequestLoadHandler | null = null;
  let progressHandler: ProgressHandler | null = null;
  let treeSnapshotHandler: TreeSnapshotHandler | null = null;
  let errorHandler: ErrorHandler | null = null;
  let logHandler: LogHandler | null = null;
  let flattenedResultHandler: FlattenedResultHandler | null = null;

  // Operation ID counter for thread-safe operation tracking
  // Must be mutable to increment for each new operation
  let operationIdCounter = 0;

  // Pending operation promise (used by expandAll and loadPaths)
  const pending: { operation: PendingOperation | null } = { operation: null };

  // Handler functions for each message type (extracted to reduce complexity)
  const handleReady = (): void => {
    ready = true;
  };

  const handleProgress = (payload: {
    loaded: number;
    total: number;
    currentPath: string;
  }): void => {
    progressHandler?.(payload.loaded, payload.total, payload.currentPath);
  };

  const handleTreeSnapshot = (payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
  }): void => {
    treeSnapshotHandler?.(payload.tree, payload.expandedPaths);
  };

  const handleComplete = (payload: {
    tree: WorkerFileNode[];
    expandedPaths: string[];
    loadedCount: number;
  }): void => {
    // Only resolve if this completion matches the current operation
    // Prevents stale completions from racing with new operations
    if (pending.operation && pending.operation.operationId === operationIdCounter) {
      pending.operation.resolve({
        tree: payload.tree,
        expandedPaths: payload.expandedPaths,
        loadedCount: payload.loadedCount,
      });
      pending.operation = null;
    }
  };

  const handleError = (payload: { message: string; path?: string }): void => {
    errorHandler?.(payload.message, payload.path);
    // Only reject if this error matches the current operation
    if (pending.operation && pending.operation.operationId === operationIdCounter) {
      pending.operation.reject(new Error(payload.message));
      pending.operation = null;
    }
  };

  const handleLog = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ): void => {
    logHandler?.(level, message, data);
  };

  const handleFlattenedResult = (payload: {
    nodes: FlattenedNode[];
    count: number;
    durationMs: number;
  }): void => {
    flattenedResultHandler?.(payload.nodes, payload.count, payload.durationMs);
  };

  /**
   * Async message handler implementation.
   * Separated from the event listener to ensure proper listener removal.
   */
  const handleMessageAsync = async (event: MessageEvent<WorkerToMainMessage>): Promise<void> => {
    const msg = event.data;

    switch (msg.type) {
      case 'ready':
        handleReady();
        break;

      case 'requestLoad':
        await handleRequestLoadMessage(msg, worker, requestLoadHandler);
        break;

      case 'progress':
        handleProgress(msg.payload);
        break;

      case 'treeSnapshot':
        handleTreeSnapshot(msg.payload);
        break;

      case 'complete':
        handleComplete(msg.payload);
        break;

      case 'error':
        handleError(msg.payload);
        break;

      case 'log':
        handleLog(msg.level, msg.message, msg.data);
        break;

      case 'flattenedResult':
        handleFlattenedResult(msg.payload);
        break;
    }
  };

  /**
   * Synchronous wrapper for event listener.
   * Using a sync wrapper ensures removeEventListener works correctly,
   * since async arrow functions create new closure instances.
   */
  const handleMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
    void handleMessageAsync(event);
  };

  worker.addEventListener('message', handleMessage);

  return {
    init(rootNodes, folderId) {
      worker.postMessage({
        type: 'init',
        payload: { rootNodes, folderId },
      } satisfies MainToWorkerMessage);
    },

    expandAll(folderId) {
      return new Promise((resolve, reject) => {
        // Increment operation ID to invalidate any stale responses
        operationIdCounter++;
        const thisOperationId = operationIdCounter;

        // Abort any existing operation
        if (pending.operation) {
          pending.operation.reject(new Error('Operation aborted by new request'));
        }

        pending.operation = { resolve, reject, operationId: thisOperationId };

        worker.postMessage({
          type: 'expandAll',
          payload: { folderId },
        } satisfies MainToWorkerMessage);
      });
    },

    loadPaths(paths) {
      return new Promise((resolve, reject) => {
        // Increment operation ID to invalidate any stale responses
        operationIdCounter++;
        const thisOperationId = operationIdCounter;

        // Abort any existing operation
        if (pending.operation) {
          pending.operation.reject(new Error('Operation aborted by new request'));
        }

        pending.operation = { resolve, reject, operationId: thisOperationId };

        worker.postMessage({
          type: 'loadPaths',
          payload: { paths },
        } satisfies MainToWorkerMessage);
      });
    },

    collapseAll() {
      worker.postMessage({
        type: 'collapseAll',
      } satisfies MainToWorkerMessage);
    },

    abort() {
      if (pending.operation) {
        pending.operation.reject(new Error('Operation aborted'));
        pending.operation = null;
      }
      worker.postMessage({
        type: 'abort',
      } satisfies MainToWorkerMessage);
    },

    updateTree(path, children) {
      worker.postMessage({
        type: 'updateTree',
        payload: { path, children, loadState: 'loaded' },
      } satisfies MainToWorkerMessage);
    },

    sendLoadResult(path, children) {
      worker.postMessage({
        type: 'loadResult',
        payload: { path, children },
      } satisfies MainToWorkerMessage);
    },

    sendLoadError(path, error) {
      worker.postMessage({
        type: 'loadError',
        payload: { path, error },
      } satisfies MainToWorkerMessage);
    },

    onRequestLoad(handler) {
      requestLoadHandler = handler;
      return () => {
        requestLoadHandler = null;
      };
    },

    onProgress(handler) {
      progressHandler = handler;
      return () => {
        progressHandler = null;
      };
    },

    onTreeSnapshot(handler) {
      treeSnapshotHandler = handler;
      return () => {
        treeSnapshotHandler = null;
      };
    },

    onError(handler) {
      errorHandler = handler;
      return () => {
        errorHandler = null;
      };
    },

    onLog(handler) {
      logHandler = handler;
      return () => {
        logHandler = null;
      };
    },

    onFlattenedResult(handler) {
      flattenedResultHandler = handler;
      return () => {
        flattenedResultHandler = null;
      };
    },

    flattenTree(expandedPaths) {
      worker.postMessage({
        type: 'flattenTree',
        payload: { expandedPaths },
      } satisfies MainToWorkerMessage);
    },

    isReady() {
      return ready;
    },

    terminate() {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
    },
  };
}
