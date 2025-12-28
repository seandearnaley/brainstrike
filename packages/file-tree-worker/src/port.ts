/**
 * File Tree Worker Port
 *
 * Provides a typed abstraction over the raw Worker postMessage API.
 * Handles message correlation, event registration, and promise-based operations.
 */

import type {
  BatchLoadResult,
  MainToWorkerMessage,
  WorkerFileNode,
  WorkerToMainMessage,
} from './types';

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

  // Handler registrations
  type RequestLoadHandler = (requestId: string, paths: string[]) => Promise<BatchLoadResult[]>;
  type ProgressHandler = (loaded: number, total: number, currentPath: string) => void;
  type TreeSnapshotHandler = (tree: WorkerFileNode[], expandedPaths: string[]) => void;
  type ErrorHandler = (message: string, path?: string) => void;
  type LogHandler = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ) => void;

  let requestLoadHandler: RequestLoadHandler | null = null;
  let progressHandler: ProgressHandler | null = null;
  let treeSnapshotHandler: TreeSnapshotHandler | null = null;
  let errorHandler: ErrorHandler | null = null;
  let logHandler: LogHandler | null = null;

  // Pending expand-all promise
  let pendingExpandAll: {
    resolve: (result: { tree: WorkerFileNode[]; expandedPaths: string[] }) => void;
    reject: (error: Error) => void;
  } | null = null;

  // Message handler
  const handleMessage = async (event: MessageEvent<WorkerToMainMessage>): Promise<void> => {
    const msg = event.data;

    switch (msg.type) {
      case 'ready':
        ready = true;
        break;

      case 'requestLoad':
        if (requestLoadHandler) {
          try {
            const results = await requestLoadHandler(msg.payload.requestId, msg.payload.paths);
            // Send results back to worker
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
          } catch (err) {
            // Send error for all requested paths
            for (const path of msg.payload.paths) {
              worker.postMessage({
                type: 'loadError',
                payload: {
                  path,
                  error: err instanceof Error ? err.message : String(err),
                },
              } satisfies MainToWorkerMessage);
            }
          }
        }
        break;

      case 'progress':
        progressHandler?.(msg.payload.loaded, msg.payload.total, msg.payload.currentPath);
        break;

      case 'treeSnapshot':
        treeSnapshotHandler?.(msg.payload.tree, msg.payload.expandedPaths);
        break;

      case 'complete':
        if (pendingExpandAll) {
          pendingExpandAll.resolve({
            tree: msg.payload.tree,
            expandedPaths: msg.payload.expandedPaths,
          });
          pendingExpandAll = null;
        }
        break;

      case 'error':
        errorHandler?.(msg.payload.message, msg.payload.path);
        if (pendingExpandAll) {
          pendingExpandAll.reject(new Error(msg.payload.message));
          pendingExpandAll = null;
        }
        break;

      case 'log':
        logHandler?.(msg.level, msg.message, msg.data);
        break;
    }
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
        // Abort any existing expand-all
        if (pendingExpandAll) {
          pendingExpandAll.reject(new Error('Expand-all aborted by new request'));
        }

        pendingExpandAll = { resolve, reject };

        worker.postMessage({
          type: 'expandAll',
          payload: { folderId },
        } satisfies MainToWorkerMessage);
      });
    },

    collapseAll() {
      worker.postMessage({
        type: 'collapseAll',
      } satisfies MainToWorkerMessage);
    },

    abort() {
      if (pendingExpandAll) {
        pendingExpandAll.reject(new Error('Operation aborted'));
        pendingExpandAll = null;
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

    isReady() {
      return ready;
    },

    terminate() {
      worker.removeEventListener('message', handleMessage);
      worker.terminate();
    },
  };
}
