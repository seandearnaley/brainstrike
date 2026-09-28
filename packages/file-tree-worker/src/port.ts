/**
 * File Tree Worker Port
 *
 * Provides a typed abstraction over the raw Worker postMessage API.
 * Handles message correlation, event registration, and promise-based operations.
 */

import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createWorkerRuntimeClient } from '@brainstrike/worker-runtime';
import { Data, Effect } from 'effect';
import type {
  AccumulatedFileTreePatchMessage,
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
type RequestLoadHandler = (
  requestId: string,
  paths: string[],
  abortSignal: AbortSignal
) => Promise<BatchLoadResult[]>;
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
type FlattenedRowsHandler = (nodes: FlattenedNode[], count: number, durationMs: number) => void;
interface LoadOperationResult {
  expandedPaths: string[];
  loadedCount: number;
  patches: AccumulatedFileTreePatchMessage[];
}

interface PendingOperation {
  operationId: number;
  patches: AccumulatedFileTreePatchMessage[];
  reject: (error: unknown) => void;
  resolve: (result: LoadOperationResult) => void;
}

class FileTreeOperationFailure extends Data.TaggedError('FileTreeOperationFailure')<{
  readonly error: unknown;
}> {}

/**
 * Handle requestLoad message - processes load requests from worker
 */
async function handleRequestLoadMessage(
  msg: RequestLoadMessage,
  worker: Worker,
  requestLoadHandler: RequestLoadHandler | null,
  activeRequestLoads: Map<string, AbortController>
): Promise<void> {
  if (!requestLoadHandler) {
    return;
  }

  const { requestId } = msg.payload;
  const previousController = activeRequestLoads.get(requestId);
  previousController?.abort(new DOMException('Request load was superseded', 'AbortError'));
  const abortController = new AbortController();
  activeRequestLoads.set(requestId, abortController);

  try {
    const results = await requestLoadHandler(requestId, msg.payload.paths, abortController.signal);
    if (activeRequestLoads.get(requestId) !== abortController) {
      return;
    }
    sendLoadResults(worker, requestId, results);
  } catch (err) {
    if (activeRequestLoads.get(requestId) !== abortController) {
      return;
    }
    sendLoadErrors(worker, requestId, msg.payload.paths, err);
  } finally {
    if (activeRequestLoads.get(requestId) === abortController) {
      activeRequestLoads.delete(requestId);
    }
  }
}

/**
 * Send load results back to worker
 */
function sendLoadResults(worker: Worker, requestId: string, results: BatchLoadResult[]): void {
  for (const result of results) {
    if (result.error) {
      worker.postMessage({
        payload: {
          error: result.error,
          path: result.path,
          requestId,
        },
        type: 'loadError',
      } satisfies MainToWorkerMessage);
    } else if (result.children) {
      worker.postMessage({
        payload: {
          children: result.children,
          path: result.path,
          requestId,
        },
        type: 'loadResult',
      } satisfies MainToWorkerMessage);
    }
  }
}

/**
 * Send load errors for all paths
 */
function sendLoadErrors(worker: Worker, requestId: string, paths: string[], err: unknown): void {
  for (const path of paths) {
    worker.postMessage({
      payload: {
        error: err instanceof Error ? err.message : String(err),
        path,
        requestId,
      },
      type: 'loadError',
    } satisfies MainToWorkerMessage);
  }
}

/**
 * Port abstraction for communicating with the file tree worker.
 */
export interface FileTreeWorkerPort {
  /** Abort current operation */
  abort: () => void;

  /** Collapse all directories */
  collapseAll: () => void;

  /** Start expand-all operation */
  expandAll: (folderId: string) => Promise<{
    patches: AccumulatedFileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Request worker to flatten tree with given expanded paths */
  flattenTree: (expandedPaths: string[]) => void;
  /** Initialize worker with root nodes */
  init: (rootNodes: WorkerFileNode[], folderId: string) => void;

  /** Check if worker is ready */
  isReady: () => boolean;

  /** Load specific paths (for restoration) */
  loadPaths: (paths: string[]) => Promise<{
    patches: AccumulatedFileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Load all descendants of a specific directory (for recursive folder selection) */
  loadSubtree: (startPath: string) => Promise<{
    patches: AccumulatedFileTreePatchMessage[];
    expandedPaths: string[];
    loadedCount: number;
  }>;

  /** Register handler for loaded-children patches */
  onChildrenLoaded: (handler: (path: string, children: WorkerFileNode[]) => void) => () => void;

  /** Register handler for errors */
  onError: (handler: (message: string, path?: string) => void) => () => void;

  /** Register handler for expanded-path delta patches */
  onExpandedPathsDelta: (handler: (added: string[], removed: string[]) => void) => () => void;

  /** Register handler for flattened tree results */
  onFlattenedRows: (
    handler: (nodes: FlattenedNode[], count: number, durationMs: number) => void
  ) => () => void;

  /** Register handler for log messages */
  onLog: (
    handler: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void
  ) => () => void;

  /** Register handler for node load-state patches */
  onNodeLoadStateChanged: (
    handler: (path: string, loadState: DirectoryLoadState, loadError?: string) => void
  ) => () => void;

  /** Register handler for progress updates */
  onProgress: (handler: (loaded: number, total: number, currentPath: string) => void) => () => void;

  /** Register handler for load requests from worker */
  onRequestLoad: (
    handler: (
      requestId: string,
      paths: string[],
      abortSignal: AbortSignal
    ) => Promise<BatchLoadResult[]>
  ) => () => void;

  /** Register handler for tree snapshots */
  onTreeSnapshot: (
    handler: (tree: WorkerFileNode[], expandedPaths: string[]) => void
  ) => () => void;

  /** Send load error back to worker */
  sendLoadError: (path: string, error: string) => void;

  /** Send load results back to worker */
  sendLoadResult: (path: string, children: WorkerFileNode[]) => void;

  /** Terminate the worker */
  terminate: () => void;

  /** Update tree with loaded children (single directory) */
  updateTree: (path: string, children: WorkerFileNode[]) => void;
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
  let flattenedRowsHandler: FlattenedRowsHandler | null = null;

  // Operation ID counter for thread-safe operation tracking
  // Must be mutable to increment for each new operation
  let operationIdCounter = 0;
  let terminated = false;

  // Pending operation promise (used by expandAll and loadPaths)
  const pending: { operation: PendingOperation | null } = { operation: null };
  const activeRequestLoads = new Map<string, AbortController>();

  const abortActiveRequestLoads = (reason: DOMException): void => {
    const controllers = [...activeRequestLoads.values()];
    activeRequestLoads.clear();
    for (const controller of controllers) {
      controller.abort(reason);
    }
  };

  const rejectPendingOperation = (error: Error): void => {
    if (!pending.operation) {
      return;
    }
    pending.operation.reject(error);
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
      abortActiveRequestLoads(new DOMException('File tree worker runtime failed', 'AbortError'));
      removeMessageListener();
      runtime.dispose();
      worker.terminate();
    },
  });
  const transport = runtime.transport;

  const runOperation = (send: (operationId: number) => void): Promise<LoadOperationResult> => {
    const operation = Effect.gen(function* () {
      if (terminated) {
        return yield* new FileTreeOperationFailure({
          error: new Error('File tree worker port terminated'),
        });
      }
      const owner = yield* Effect.acquireRelease(
        Effect.sync(() => {
          operationIdCounter++;
          const owner: PendingOperation = {
            operationId: operationIdCounter,
            patches: [],
            reject: () => {},
            resolve: () => {},
          };
          return owner;
        }),
        (owner) =>
          Effect.sync(() => {
            if (pending.operation === owner) {
              pending.operation = null;
            }
          })
      );
      return yield* Effect.callback<LoadOperationResult, FileTreeOperationFailure>((resume) => {
        let settled = false;
        const detach = (): boolean => {
          if (settled) {
            return false;
          }
          settled = true;
          if (pending.operation === owner) {
            pending.operation = null;
          }
          return true;
        };
        owner.resolve = (result) => {
          if (detach()) {
            resume(Effect.succeed(result));
          }
        };
        owner.reject = (error) => {
          if (detach()) {
            resume(Effect.fail(new FileTreeOperationFailure({ error })));
          }
        };
        const previous = pending.operation;
        previous?.reject(new Error('Operation aborted by new request'));
        pending.operation = owner;
        try {
          if (previous) {
            abortActiveRequestLoads(
              new DOMException('Operation aborted by new request', 'AbortError')
            );
            if (settled || pending.operation !== owner) {
              return;
            }
            transport.postMessage({ type: 'abort' } satisfies MainToWorkerMessage);
          }
          if (!settled && pending.operation === owner) {
            send(owner.operationId);
          }
        } catch (error) {
          // A synchronous reply may already have completed the operation before send throws.
          owner.reject(error);
        }
      });
    }).pipe(Effect.scoped);
    return runAtPromiseBoundary(operation).catch((failure: unknown) => {
      if (failure instanceof FileTreeOperationFailure) {
        throw failure.error;
      }
      throw failure;
    });
  };

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
    if (patch.type === 'expandedPathsDelta') {
      // The complete message's expandedPaths is the canonical operation result; keeping interim
      // expansion deltas in patches would allocate and then discard duplicate state in the UI.
      return;
    }

    const operation = pending.operation;
    if (!operation || operation.operationId !== patch.operationId) {
      // Standalone updateTree patches omit operationId and still notify live listeners.
      // They must not be accumulated into any pending bulk-operation result.
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
        expandedPaths: message.payload.expandedPaths,
        loadedCount: message.payload.loadedCount,
        patches: pending.operation.patches,
      });
    }
  };

  const handleError = (message: Extract<WorkerToMainMessage, { type: 'error' }>): void => {
    errorHandler?.(message.payload.message, message.payload.path);
    const operation = pending.operation;
    if (!operation) {
      return;
    }

    // Id-less worker errors are global failures; reject the active operation so it cannot hang.
    if (message.operationId === undefined || operation.operationId === message.operationId) {
      operation.reject(new Error(message.payload.message));
    }
  };

  const handleLog = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ): void => {
    logHandler?.(level, message, data);
  };

  const handleFlattenedRows = (payload: {
    nodes: FlattenedNode[];
    count: number;
    durationMs: number;
  }): void => {
    flattenedRowsHandler?.(payload.nodes, payload.count, payload.durationMs);
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
        await handleRequestLoadMessage(msg, worker, requestLoadHandler, activeRequestLoads);
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
        handleFlattenedRows(msg.payload);
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
    abort() {
      const controllers = [...activeRequestLoads.values()];
      activeRequestLoads.clear();
      rejectPendingOperation(new Error('Operation aborted'));
      try {
        runtime.throwIfFailed();
        transport.postMessage({ type: 'abort' } satisfies MainToWorkerMessage);
      } finally {
        for (const controller of controllers) {
          controller.abort(new DOMException('Operation aborted', 'AbortError'));
        }
      }
    },

    collapseAll() {
      runtime.throwIfFailed();
      transport.postMessage({
        type: 'collapseAll',
      } satisfies MainToWorkerMessage);
    },

    expandAll(folderId) {
      runtime.throwIfFailed();
      return runOperation((operationId) => {
        transport.postMessage({
          operationId,
          payload: { folderId },
          type: 'expandAll',
        } satisfies MainToWorkerMessage);
      });
    },

    flattenTree(expandedPaths) {
      runtime.throwIfFailed();
      transport.postMessage({
        payload: { expandedPaths },
        type: 'flattenTree',
      } satisfies MainToWorkerMessage);
    },
    init(rootNodes, folderId) {
      runtime.throwIfFailed();
      transport.postMessage({
        payload: { folderId, rootNodes },
        type: 'init',
      } satisfies MainToWorkerMessage);
    },

    isReady() {
      return runtime.isReady();
    },

    loadPaths(paths) {
      runtime.throwIfFailed();
      return runOperation((operationId) => {
        transport.postMessage({
          operationId,
          payload: { paths },
          type: 'loadPaths',
        } satisfies MainToWorkerMessage);
      });
    },

    loadSubtree(startPath) {
      runtime.throwIfFailed();
      return runOperation((operationId) => {
        transport.postMessage({
          operationId,
          payload: { startPath },
          type: 'loadSubtree',
        } satisfies MainToWorkerMessage);
      });
    },

    onChildrenLoaded(handler) {
      childrenLoadedHandler = handler;
      return () => {
        childrenLoadedHandler = null;
      };
    },

    onError(handler) {
      errorHandler = handler;
      return () => {
        errorHandler = null;
      };
    },

    onExpandedPathsDelta(handler) {
      expandedPathsDeltaHandler = handler;
      return () => {
        expandedPathsDeltaHandler = null;
      };
    },

    onFlattenedRows(handler) {
      flattenedRowsHandler = handler;
      return () => {
        flattenedRowsHandler = null;
      };
    },

    onLog(handler) {
      logHandler = handler;
      return () => {
        logHandler = null;
      };
    },

    onNodeLoadStateChanged(handler) {
      nodeLoadStateChangedHandler = handler;
      return () => {
        nodeLoadStateChangedHandler = null;
      };
    },

    onProgress(handler) {
      progressHandler = handler;
      return () => {
        progressHandler = null;
      };
    },

    onRequestLoad(handler) {
      requestLoadHandler = handler;
      return () => {
        requestLoadHandler = null;
      };
    },

    onTreeSnapshot(handler) {
      treeSnapshotHandler = handler;
      return () => {
        treeSnapshotHandler = null;
      };
    },

    sendLoadError(path, error) {
      runtime.throwIfFailed();
      transport.postMessage({
        payload: { error, path },
        type: 'loadError',
      } satisfies MainToWorkerMessage);
    },

    sendLoadResult(path, children) {
      runtime.throwIfFailed();
      transport.postMessage({
        payload: { children, path },
        type: 'loadResult',
      } satisfies MainToWorkerMessage);
    },

    terminate() {
      terminated = true;
      rejectPendingOperation(new Error('File tree worker port terminated'));
      abortActiveRequestLoads(new DOMException('File tree worker port terminated', 'AbortError'));
      removeMessageListener();
      runtime.dispose();
      runtime.resetReady();
      worker.terminate();
    },

    updateTree(path, children) {
      runtime.throwIfFailed();
      transport.postMessage({
        payload: { children, loadState: 'loaded', path },
        type: 'updateTree',
      } satisfies MainToWorkerMessage);
    },
  };
}
