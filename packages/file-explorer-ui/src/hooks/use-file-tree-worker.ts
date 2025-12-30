/**
 * File Tree Worker Hook
 *
 * Manages Web Worker lifecycle for file tree operations.
 * Handles worker creation, message handler registration, and cleanup.
 *
 * @module use-file-tree-worker
 */

import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import {
  type BatchLoadResult,
  createFileTreeWorkerPort,
  type FileTreeWorkerPort,
  resolveFileTreeWorkerUrl,
} from '@brainstrike/file-tree-worker';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import { createLogger, isAbortError } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';

import { runWithConcurrency } from '../utils/concurrency';
import { loadDirectoryChildren } from '../utils/lazy-tree-loader';
import {
  addHandlesToMap,
  type FileSystemHandle,
  toWorkerFileNodes,
} from '../utils/worker-node-conversion';

const logger = createLogger('FileTreeWorker');

/** Maximum concurrent directory loads to prevent overwhelming the browser */
const MAX_CONCURRENT_LOADS = 5;

/**
 * Sort nodes: directories first, then alphabetically.
 */
function sortFileNodes(nodes: IFileNode[]): IFileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/**
 * Build minimal node info from a path and root info.
 */
function buildNodeFromPath(
  path: string,
  rootPath: string,
  rootName: string,
  handle: FileSystemHandle
): IFileNode {
  const pathSegments = path.replace(rootPath, '').split('/').filter(Boolean);
  const name = pathSegments.at(-1) ?? '';
  const depth = pathSegments.length - 1;

  return {
    name,
    path,
    type: 'directory',
    depth,
    rootFolderId: rootName,
    handle: handle as FileSystemDirectoryHandle,
    selectionState: 'unchecked',
  };
}

/**
 * Load a single directory for worker request.
 */
async function loadSingleDirectory(
  path: string,
  rootPath: string,
  rootName: string,
  handleMap: Map<string, FileSystemHandle>,
  fileSystemAdapter: FileSystemAdapter,
  abortSignal: AbortSignal
): Promise<BatchLoadResult> {
  const handle = handleMap.get(path);
  if (!handle) {
    return { path, error: 'Handle not found' };
  }

  const node = buildNodeFromPath(path, rootPath, rootName, handle);

  try {
    const children = await loadDirectoryChildren(fileSystemAdapter, node, {
      abortSignal,
      sortFileNodes,
    });

    addHandlesToMap(children, handleMap);

    return { path, children: toWorkerFileNodes(children) };
  } catch (err) {
    if (isAbortError(err)) {
      // Re-throw abort errors to be handled by caller
      throw err;
    }
    return { path, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WorkerProgressUpdate = {
  loaded: number;
  total: number;
};

export type UseFileTreeWorkerOptions = {
  /** File system adapter for I/O operations */
  fileSystemAdapter: FileSystemAdapter | null;
  /** Callback when progress updates occur */
  onProgress?: (loaded: number, total: number) => void;
  /** Callback when errors occur */
  onError?: (error: Error) => void;
};

export type UseFileTreeWorkerReturn = {
  /** Worker port for sending commands */
  portRef: React.RefObject<FileTreeWorkerPort | null>;
  /** Handle map for file system handles */
  handleMapRef: React.RefObject<Map<string, FileSystemHandle>>;
  /** Current root directory handle ref (for use in handlers) */
  rootHandleRef: React.RefObject<DirectoryHandle | null>;
  /** Update the root handle ref */
  setRootHandle: (handle: DirectoryHandle | null) => void;
};

/**
 * Hook for managing file tree Web Worker lifecycle.
 *
 * Creates and manages a Web Worker for CPU-bound tree operations,
 * while keeping I/O operations on the main thread.
 *
 * @param options - Configuration options
 * @returns Worker port ref and handle map ref
 */
export function useFileTreeWorker(options: UseFileTreeWorkerOptions): UseFileTreeWorkerReturn {
  const { fileSystemAdapter, onProgress, onError } = options;

  // Worker port ref
  const portRef = useRef<FileTreeWorkerPort | null>(null);

  // Handle map for FileSystemHandle references
  const handleMapRef = useRef<Map<string, FileSystemHandle>>(new Map());

  // Root directory handle ref (used in worker handlers)
  const rootHandleRef = useRef<DirectoryHandle | null>(null);

  // Store callbacks in refs so effect doesn't depend on them (avoids worker recreation)
  const onProgressRef = useRef(onProgress);
  const onErrorRef = useRef(onError);
  onProgressRef.current = onProgress;
  onErrorRef.current = onError;

  // Set root handle
  const setRootHandle = (handle: DirectoryHandle | null) => {
    rootHandleRef.current = handle;
  };

  // Initialize worker and set up handlers
  useEffect(() => {
    logger.info('useFileTreeWorker effect running', {
      hasAdapter: !!fileSystemAdapter,
    });

    // Create worker
    let worker: Worker;
    let port: FileTreeWorkerPort;
    try {
      const workerUrl = resolveFileTreeWorkerUrl();
      logger.info('Creating worker', { workerUrl: workerUrl.toString() });
      worker = new Worker(workerUrl, { type: 'module' });

      // Handle async worker errors (load failures, runtime errors)
      worker.onerror = (event) => {
        logger.error('Worker async error', {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        });
        onErrorRef.current?.(new Error(`Worker error: ${event.message}`));
      };

      port = createFileTreeWorkerPort(worker);
      portRef.current = port;
      logger.info('Worker created successfully');
    } catch (err) {
      logger.error('Failed to create worker', { error: String(err) });
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Collect unsubscribe functions for cleanup
    const unsubscribes: (() => void)[] = [];

    // Handle load requests from worker - perform I/O with FileSystemHandles
    unsubscribes.push(
      port.onRequestLoad(async (_requestId, paths) => {
        if (!fileSystemAdapter) {
          logger.warn('onRequestLoad: no file system adapter');
          return paths.map((path) => ({ path, error: 'No file system adapter' }));
        }

        const abortController = new AbortController();

        // Get root info for building nodes
        const rootPath = rootHandleRef.current?.path ?? '';
        const rootName = rootHandleRef.current?.name ?? '';

        // Load directories with concurrency limit to prevent overwhelming the browser
        const results = await runWithConcurrency(
          paths,
          MAX_CONCURRENT_LOADS,
          async (path): Promise<BatchLoadResult> => {
            try {
              return await loadSingleDirectory(
                path,
                rootPath,
                rootName,
                handleMapRef.current,
                fileSystemAdapter,
                abortController.signal
              );
            } catch (err) {
              // Ignore abort errors (operation was cancelled)
              if (isAbortError(err)) {
                return { path, error: 'Operation aborted' };
              }
              return {
                path,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        );

        return results;
      })
    );

    // Handle tree snapshots from worker
    // PERFORMANCE: We intentionally DO NOT update the React tree during expand-all.
    // Each tree update triggers expensive operations (rehydration, flattening, memoization).
    // Instead, we only update the tree at COMPLETION.
    unsubscribes.push(
      port.onTreeSnapshot((_workerTree: WorkerFileNode[], _expandedPaths: string[]) => {
        // Intentionally do nothing - tree and expanded paths are set at completion only
      })
    );

    // Handle progress updates - use ref to get current callback
    unsubscribes.push(
      port.onProgress((loaded, total, _currentPath) => {
        onProgressRef.current?.(loaded, total);
      })
    );

    // Handle errors from worker - use ref to get current callback
    unsubscribes.push(
      port.onError((message, _path) => {
        logger.error('Worker error', { message });
        onErrorRef.current?.(new Error(message));
      })
    );

    // Debug logging from worker
    unsubscribes.push(
      port.onLog((level, message, data) => {
        if (level === 'error') {
          logger.error(message, data ?? undefined);
        } else if (level === 'warn') {
          logger.warn(message, data ?? undefined);
        } else if (level === 'info') {
          logger.info(message, data ?? undefined);
        } else {
          logger.debug(message, data ?? undefined);
        }
      })
    );

    return () => {
      // Clean up all handlers before terminating worker
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      port.terminate();
      portRef.current = null;
    };
  }, [fileSystemAdapter]); // Only recreate worker when adapter changes

  return {
    portRef,
    handleMapRef,
    rootHandleRef,
    setRootHandle,
  };
}
