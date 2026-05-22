/**
 * File Tree Worker
 *
 * A dedicated Web Worker that handles all file tree operations off the main thread:
 * 1. Receives tree initialization and load results via postMessage
 * 2. Performs BFS traversal for expand-all operations
 * 3. Manages tree state (sorting, updating, traversal)
 * 4. Requests directory loads from main thread (which has FileSystemHandles)
 * 5. Posts tree snapshots back to main thread for React state updates
 *
 * This keeps ALL CPU-bound tree operations off the main thread, ensuring smooth UI.
 */

/// <reference lib="webworker" />

import { BFSEngine } from './bfs-engine';
import { collectExpandedPaths, updateNodeChildren } from './tree-operations';
import type { MainToWorkerMessage, WorkerToMainMessage } from './types';

// ============================================================================
// Logging
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log level priority (higher = more severe)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default to 'info' to suppress debug logs - set WORKER_LOG_LEVEL=debug for verbose output
const WORKER_LOG_LEVEL: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[WORKER_LOG_LEVEL];
}

function postLog(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  try {
    const payload: WorkerToMainMessage = data
      ? { type: 'log', level, message, data }
      : { type: 'log', level, message };
    self.postMessage(payload);
  } catch {
    // Ignore structured-clone errors
  }
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }
  postLog(level, message, data);
}

// ============================================================================
// Global Error Handlers
// ============================================================================

function handleGlobalError(event: ErrorEvent): void {
  log('error', 'global error event', {
    type: event.type,
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
  self.postMessage({
    type: 'error',
    payload: { message: `global error: ${event.message ?? 'unknown'}` },
  } satisfies WorkerToMainMessage);
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  log('error', 'unhandledrejection', { reason: message });
  self.postMessage({
    type: 'error',
    payload: { message: `unhandledrejection: ${message}` },
  } satisfies WorkerToMainMessage);
}

self.addEventListener('error', handleGlobalError);
self.addEventListener('unhandledrejection', handleUnhandledRejection);

// ============================================================================
// BFS Engine Instance
// ============================================================================

const engine = new BFSEngine((msg) => self.postMessage(msg));

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = async (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  const messageType = message?.type;

  try {
    // Only log non-routine messages to reduce console spam during expand-all
    if (messageType !== 'loadResult' && messageType !== 'loadError') {
      log('debug', 'onmessage received', { type: messageType });
    }

    switch (messageType) {
      case 'init': {
        const { rootNodes, folderId } = message.payload;
        engine.setTree(rootNodes, folderId);
        log('info', 'tree initialized', { nodeCount: rootNodes.length, folderId });

        // Send initial snapshot
        self.postMessage({
          type: 'treeSnapshot',
          payload: {
            tree: engine.getTree(),
            expandedPaths: collectExpandedPaths(engine.getTree()),
          },
        } satisfies WorkerToMainMessage);
        break;
      }

      case 'loadResult': {
        const { path, children } = message.payload;
        engine.handleLoadResult(path, children);
        // Removed per-result debug log to reduce console spam during expand-all
        break;
      }

      case 'loadError': {
        const { path, error } = message.payload;
        engine.handleLoadError(path, error);
        log('warn', 'load error processed', { path, error });
        break;
      }

      case 'expandAll': {
        log('info', 'starting expand-all', { folderId: message.payload.folderId });
        await engine.expandAll();
        break;
      }

      case 'loadPaths': {
        const { paths } = message.payload;
        log('info', 'starting loadPaths', { pathCount: paths.length });
        await engine.loadPaths(paths);
        break;
      }

      case 'loadSubtree': {
        const { startPath } = message.payload;
        log('info', 'starting loadSubtree', { startPath });
        await engine.loadSubtree(startPath);
        break;
      }

      case 'collapseAll': {
        log('info', 'collapsing all');
        engine.collapseAll();
        break;
      }

      case 'abort': {
        log('info', 'aborting current operation');
        engine.abort();
        break;
      }

      case 'updateTree': {
        const { path, children, loadState } = message.payload;
        const currentTree = engine.getTree();
        const newTree = updateNodeChildren(currentTree, path, children, loadState);
        engine.setTree(newTree, ''); // folderId preserved from init

        // Send a routine patch. Full snapshots are reserved for initialization/recovery.
        if (loadState === 'loaded') {
          self.postMessage({
            type: 'childrenLoaded',
            payload: { path, children, loadState },
          } satisfies WorkerToMainMessage);
        }
        self.postMessage({
          type: 'nodeLoadStateChanged',
          payload: { path, loadState },
        } satisfies WorkerToMainMessage);
        break;
      }

      case 'toggleExpand': {
        // Single directory toggle is still handled by main thread for now
        // This message type is for future use
        log('debug', 'toggleExpand not implemented in worker', { path: message.payload.path });
        break;
      }

      case 'flattenTree': {
        const { expandedPaths } = message.payload;
        engine.flattenTree(expandedPaths);
        break;
      }

      default: {
        log('warn', 'unknown message type', { type: messageType });
        self.postMessage({
          type: 'error',
          payload: { message: `Unknown message type: ${String(messageType)}` },
        } satisfies WorkerToMainMessage);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'onmessage handler failed', { type: messageType, error: errorMessage });
    self.postMessage({
      type: 'error',
      payload: { message: errorMessage },
    } satisfies WorkerToMainMessage);
  }
};

// ============================================================================
// Bootstrap
// ============================================================================

self.postMessage({ type: 'ready' } satisfies WorkerToMainMessage);
