/**
 * File Tree Worker Port
 *
 * Provides a typed abstraction over the raw Worker postMessage API.
 * Handles message correlation, event registration, and promise-based operations.
 */

import { createWorkerRuntimeClient } from '@brainstrike/worker-runtime';
import type {
  BatchLoadResult,
  DirectoryLoadState,
  FileTreePatchMessage,
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
type ChildrenLoadedHandler = (path: string, children: WorkerFileNode[]) => void;
type NodeLoadStateChangedHandler = (
  path: string,
  loadState: DirectoryLoadState,
  loadError?: string
) => void;
type ExpandedPathsDeltaHandler = (added: string[], removed: string[]) => void;
type ErrorHandler = (message: string, path?: string) => void;
type LogHandler = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown
) => void;
type FlattenedResultHandler = (nodes: FlattenedNode[], count: number, durationMs: number) => void;

interface PendingOperation {
  operationId: number;
  patches: FileTreePatchMessage[];
  reject: (error: Error) => void;
  resolve: (result: {
    patches: FileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }) => void;
}

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
    sendLoadResults(worker, msg.payload.requestId, results);
  } catch (err) {
    sendLoadErrors(worker, msg.payload.requestId, msg.payload.paths, err);
  }
}

/**
 * Send load results back to worker
 */
function sendLoadResults(
  worker: Worker,
  requestId: string | undefined,
  results: BatchLoadResult[]
): void {
  for (const result of results) {
    if (result.error) {
      worker.postMessage({
        type: 'loadError',
        payload: {
          path: result.path,
          error: result.error,
          ...(requestId === undefined ? {} : { requestId }),
        },
      } satisfies MainToWorkerMessage);
    } else if (result.children) {
      worker.postMessage({
        type: 'loadResult',
        payload: {
          path: result.path,
          children: result.children,
          ...(requestId === undefined ? {} : { requestId }),
        },
      } satisfies MainToWorkerMessage);
    }
  }
}

/**
 * Send load errors for all paths
 */
function sendLoadErrors(
  worker: Worker,
  requestId: string | undefined,
  paths: string[],
  err: unknown
): void {
  for (const path of paths) {
    worker.postMessage({
      type: 'loadError',
      payload: {
        ...(requestId === undefined ? {} : { requestId }),
        path,
        error: err instanceof Error ? err.message : String(err),
      },
    } satisfies MainToWorkerMessage);
  }
}

/**
 * Port abstraction for communicating with the file tree worker.
 */
export interface FileTreeWorkerPort {
  /** Abort current operation */
  abort(): void;

  /** Collapse all directories */
  collapseAll(): void;

  /** Start expand-all operation */
  expandAll(folderId: string): Promise<{
    patches: FileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Request worker to flatten tree with given expanded paths */
  flattenTree(expandedPaths: string[]): void;
  /** Initialize worker with root nodes */
  init(rootNodes: WorkerFileNode[], folderId: string): void;

  /** Check if worker is ready */
  isReady(): boolean;

  /** Load specific paths (for restoration) */
  loadPaths(paths: string[]): Promise<{
    patches: FileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Load all descendants of a specific directory (for recursive folder selection) */
  loadSubtree(startPath: string): Promise<{
    patches: FileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Register handler for loaded-children patches */
  onChildrenLoaded(handler: (path: string, children: WorkerFileNode[]) => void): () => void;

  /** Register handler for errors */
  onError(handler: (message: string, path?: string) => void): () => void;

  /** Register handler for expanded-path delta patches */
  onExpandedPathsDelta(handler: (added: string[], removed: string[]) => void): () => void;

  /** Register handler for flattened tree results */
  onFlattenedResult(
    handler: (nodes: FlattenedNode[], count: number, durationMs: number) => void
  ): () => void;

  /** Register handler for log messages */
  onLog(
    handler: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void
  ): () => void;

  /** Register handler for node load-state patches */
  onNodeLoadStateChanged(
    handler: (path: string, loadState: DirectoryLoadState, loadError?: string) => void
  ): () => void;

  /** Register handler for progress updates */
  onProgress(handler: (loaded: number, total: number, currentPath: string) => void): () => void;

  /** Register handler for load requests from worker */
  onRequestLoad(
    handler: (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>
  ): () => void;

  /** Register handler for tree snapshots */
  onTreeSnapshot(handler: (tree: WorkerFileNode[], expandedPaths: string[]) => void): () => void;

  /** Send load error back to worker */
  sendLoadError(path: string, error: string): void;

  /** Send load results back to worker */
  sendLoadResult(path: string, children: WorkerFileNode[]): void;

  /** Terminate the worker */
  terminate(): void;

  /** Update tree with loaded children (single directory) */
  updateTree(path: string, children: WorkerFileNode[]): void;
}

/**
 * Create a port abstraction for the file tree worker.
 */
export function createFileTreeWorkerPort(worker: Worker): FileTreeWorkerPort {
  let removeMessageListener = () => {};

  // Handler registrations (mutable state for callbacks)
  let requestLoadHandler: RequestLoadHandler | null = null;
  let progressHandler: ProgressHandler | null = null;
  let treeSnapshotHandler: TreeSnapshotHandler | null = null;
  let childrenLoadedHandler: ChildrenLoadedHandler | null = null;
  let nodeLoadStateChangedHandler: NodeLoadStateChangedHandler | null = null;
  let expandedPathsDeltaHandler: ExpandedPathsDeltaHandler | null = null;
  let errorHandler: ErrorHandler | null = null;
  let logHandler: LogHandler | null = null;
  let flattenedResultHandler: FlattenedResultHandler | null = null;

  // Operation ID counter for thread-safe operation tracking
  // Must be mutable to increment for each new operation
  let operationIdCounter = 0;

  // Pending operation promise (used by expandAll and loadPaths)
  const pending: { operation: PendingOperation | null } = { operation: null };

  const rejectPendingOperation = (error: Error): void => {
    if (!pending.operation) {
      return;
    }
    pending.operation.reject(error);
    pending.operation = null;
  };

  const runtime = createWorkerRuntimeClient(worker, {
    createErrorFromEvent: (event) =>
      new Error(
        event.message
          ? `File tree worker runtime error: ${event.message}`
          : 'File tree worker runtime error (missing ErrorEvent.message)'
      ),
    onFailure: (failure) => {
      errorHandler?.(failure.message);
      rejectPendingOperation(failure);
      removeMessageListener();
      runtime.dispose();
      worker.terminate();
    },
  });
  const transport = runtime.transport;

  // Handler functions for each message type (extracted to reduce complexity)
  const handleReady = (): void => {
    runtime.markReady();
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

  const recordPatch = (patch: FileTreePatchMessage): void => {
    const operation = pending.operation;
    if (!operation || operation.operationId !== patch.operationId) {
      // Patch event handlers still run below; only operation result accumulation is scoped.
      return;
    }
    operation.patches.push(patch);
  };

  const handleChildrenLoaded = (
    patch: Extract<FileTreePatchMessage, { type: 'childrenLoaded' }>
  ): void => {
    recordPatch(patch);
    childrenLoadedHandler?.(patch.payload.path, patch.payload.children);
  };

  const handleNodeLoadStateChanged = (
    patch: Extract<FileTreePatchMessage, { type: 'nodeLoadStateChanged' }>
  ): void => {
    recordPatch(patch);
    nodeLoadStateChangedHandler?.(
      patch.payload.path,
      patch.payload.loadState,
      patch.payload.loadError
    );
  };

  const handleExpandedPathsDelta = (
    patch: Extract<FileTreePatchMessage, { type: 'expandedPathsDelta' }>
  ): void => {
    recordPatch(patch);
    expandedPathsDeltaHandler?.(patch.payload.added, patch.payload.removed);
  };

  const handleComplete = (message: Extract<WorkerToMainMessage, { type: 'complete' }>): void => {
    // Only resolve if this completion matches the current operation
    // Prevents stale completions from racing with new operations
    if (pending.operation && pending.operation.operationId === message.operationId) {
      pending.operation.resolve({
        patches: pending.operation.patches,
        expandedPaths: message.payload.expandedPaths,
        loadedCount: message.payload.loadedCount,
      });
      pending.operation = null;
    }
  };

  const handleError = (message: Extract<WorkerToMainMessage, { type: 'error' }>): void => {
    errorHandler?.(message.payload.message, message.payload.path);
    // Only reject if this error matches the current operation
    if (
      pending.operation &&
      message.operationId !== undefined &&
      pending.operation.operationId === message.operationId
    ) {
      pending.operation.reject(new Error(message.payload.message));
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

      case 'childrenLoaded':
        handleChildrenLoaded(msg);
        break;

      case 'nodeLoadStateChanged':
        handleNodeLoadStateChanged(msg);
        break;

      case 'expandedPathsDelta':
        handleExpandedPathsDelta(msg);
        break;

      case 'complete':
        handleComplete(msg);
        break;

      case 'error':
        handleError(msg);
        break;

      case 'log':
        handleLog(msg.level, msg.message, msg.data);
        break;

      case 'flattenedRows':
        handleFlattenedResult(msg.payload);
        break;
    }
  };

  /**
   * Synchronous wrapper for event listener.
   * Using a sync wrapper ensures removeEventListener works correctly,
   * since async arrow functions create new closure instances.
   */
  const handleMessage = (message: WorkerToMainMessage): void => {
    void handleMessageAsync({ data: message } as MessageEvent<WorkerToMainMessage>);
  };

  removeMessageListener = transport.onMessage((message) => {
    handleMessage(message as WorkerToMainMessage);
  });

  return {
    init(rootNodes, folderId) {
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'init',
        payload: { rootNodes, folderId },
      } satisfies MainToWorkerMessage);
    },

    expandAll(folderId) {
      runtime.throwIfFailed();
      return new Promise((resolve, reject) => {
        // Increment operation ID to invalidate any stale responses
        operationIdCounter++;
        const thisOperationId = operationIdCounter;

        // Abort any existing operation
        if (pending.operation) {
          pending.operation.reject(new Error('Operation aborted by new request'));
        }

        pending.operation = { resolve, reject, operationId: thisOperationId, patches: [] };

        transport.postMessage({
          type: 'expandAll',
          operationId: thisOperationId,
          payload: { folderId },
        } satisfies MainToWorkerMessage);
      });
    },

    loadPaths(paths) {
      runtime.throwIfFailed();
      return new Promise((resolve, reject) => {
        // Increment operation ID to invalidate any stale responses
        operationIdCounter++;
        const thisOperationId = operationIdCounter;

        // Abort any existing operation
        if (pending.operation) {
          pending.operation.reject(new Error('Operation aborted by new request'));
        }

        pending.operation = { resolve, reject, operationId: thisOperationId, patches: [] };

        transport.postMessage({
          type: 'loadPaths',
          operationId: thisOperationId,
          payload: { paths },
        } satisfies MainToWorkerMessage);
      });
    },

    loadSubtree(startPath) {
      runtime.throwIfFailed();
      return new Promise((resolve, reject) => {
        // Increment operation ID to invalidate any stale responses
        operationIdCounter++;
        const thisOperationId = operationIdCounter;

        // Abort any existing operation
        if (pending.operation) {
          pending.operation.reject(new Error('Operation aborted by new request'));
        }

        pending.operation = { resolve, reject, operationId: thisOperationId, patches: [] };

        transport.postMessage({
          type: 'loadSubtree',
          operationId: thisOperationId,
          payload: { startPath },
        } satisfies MainToWorkerMessage);
      });
    },

    collapseAll() {
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'collapseAll',
      } satisfies MainToWorkerMessage);
    },

    abort() {
      if (pending.operation) {
        pending.operation.reject(new Error('Operation aborted'));
        pending.operation = null;
      }
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'abort',
      } satisfies MainToWorkerMessage);
    },

    updateTree(path, children) {
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'updateTree',
        payload: { path, children, loadState: 'loaded' },
      } satisfies MainToWorkerMessage);
    },

    sendLoadResult(path, children) {
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'loadResult',
        payload: { path, children },
      } satisfies MainToWorkerMessage);
    },

    sendLoadError(path, error) {
      runtime.throwIfFailed();
      transport.postMessage({
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

    onChildrenLoaded(handler) {
      childrenLoadedHandler = handler;
      return () => {
        childrenLoadedHandler = null;
      };
    },

    onNodeLoadStateChanged(handler) {
      nodeLoadStateChangedHandler = handler;
      return () => {
        nodeLoadStateChangedHandler = null;
      };
    },

    onExpandedPathsDelta(handler) {
      expandedPathsDeltaHandler = handler;
      return () => {
        expandedPathsDeltaHandler = null;
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
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'flattenTree',
        payload: { expandedPaths },
      } satisfies MainToWorkerMessage);
    },

    isReady() {
      return runtime.isReady();
    },

    terminate() {
      removeMessageListener();
      runtime.dispose();
      runtime.resetReady();
      worker.terminate();
    },
  };
}
