/**
 * useBackgroundTokenIndexer
 *
 * React hook that manages a background Web Worker for token indexing.
 * Automatically indexes selected files off the main thread and caches results.
 *
 * Key features:
 * - File reading happens in the worker (zero main thread blocking)
 * - Hash-based change detection (only counts changed files)
 * - Integrates with TokenCacheStore for persistence
 * - Progressive updates via callback
 */

import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IndexerBatchRequest,
  IndexerError,
  IndexerProgress,
  IndexerResult,
  WorkerLog,
  WorkerResponse,
} from './background-indexer.worker';
import { resolveBackgroundIndexerWorkerUrl } from './resolve-worker-url';
import type { TokenCacheStore } from './token-cache-store';
import type { TokenCacheEntry, TokenCountingMode } from './types';

const logger = createLogger('BackgroundTokenIndexer');

/**
 * Electron-style handle with path property
 */
export type ElectronFileHandle = {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
};

/**
 * File ready for indexing - supports both Web FileSystemFileHandle and Electron path-based access
 */
export type FileToIndex = {
  compositeKey: string;
  folderId: string;
  filePath: string;
  /** Web FileSystemFileHandle for File System Access API */
  fileHandle?: FileSystemFileHandle;
  /** Electron-style handle with path for direct file access */
  electronHandle?: ElectronFileHandle;
};

export type IndexingProgress = {
  completed: number;
  total: number;
  currentFile?: string;
};

export type UseBackgroundTokenIndexerOptions = {
  /** Token cache store for persistence (null to disable indexing) */
  store: TokenCacheStore | null;
  /** Token counting mode */
  mode: TokenCountingMode;
  /** Callback when a file's token count is resolved */
  onFileIndexed?: (compositeKey: string, tokenCount: number) => void;
  /** Callback for progress updates */
  onProgress?: (progress: IndexingProgress) => void;
};

export type UseBackgroundTokenIndexerReturn = {
  /** Queue files for background indexing */
  indexFiles: (files: FileToIndex[]) => void;
  /** Cancel all pending indexing */
  cancelIndexing: () => void;
  /** Whether indexing is in progress */
  isIndexing: boolean;
  /** Current progress */
  progress: IndexingProgress | null;
  /** Whether the worker is ready */
  isReady: boolean;
};

/**
 * Create a unique ID for each indexing request
 */
function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Factory function to create a new worker instance.
 * Uses the URL resolver pattern which is compatible with both Vite and tsup builds.
 * The worker is pre-built to JavaScript by tsup, and Vite copies it to the output.
 */
function createWorkerInstance(): Worker {
  const url = resolveBackgroundIndexerWorkerUrl();
  logger.info('Creating worker from URL', { url: url.href });
  return new Worker(url, { type: 'module' });
}

export function useBackgroundTokenIndexer({
  store,
  mode,
  onFileIndexed,
  onProgress,
}: UseBackgroundTokenIndexerOptions): UseBackgroundTokenIndexerReturn {
  const workerRef = useRef<Worker | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [progress, setProgress] = useState<IndexingProgress | null>(null);
  const workerErrorLoggedRef = useRef(false);
  const readinessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track pending files to enable cancellation
  const pendingFilesRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  const logWorkerErrorOnce = useCallback((error: unknown, context: string) => {
    if (workerErrorLoggedRef.current) {
      return;
    }
    workerErrorLoggedRef.current = true;
    const normalized =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { error: String(error) };
    logger.error('Background token indexer failed to initialize', {
      context,
      ...normalized,
    });
    // Double-log to console to avoid missing logger output in prod builds.
    // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
    console.error('[BackgroundTokenIndexer] init failure', { context, ...normalized });
  }, []);

  // Initialize worker
  // biome-ignore lint/correctness/useExhaustiveDependencies: Handlers are stable refs
  useEffect(() => {
    logger.error('Background token indexer init start', { hasStore: !!store, mode });
    // biome-ignore lint/suspicious/noConsole: explicit visibility
    console.error('[BackgroundTokenIndexer] init start', { hasStore: !!store, mode });

    try {
      const worker = createWorkerInstance();
      logger.error('Background token indexer worker created; awaiting ready signal', {
        hasStore: !!store,
        mode,
      });
      // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
      console.error('[BackgroundTokenIndexer] Worker created; waiting for ready', {
        hasStore: !!store,
        mode,
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker message handler requires multiple conditional branches for different message types
      worker.onmessage = (event: MessageEvent<WorkerResponse | { type: 'ready' }>) => {
        if (!isMountedRef.current) {
          return;
        }

        const message = event.data;
        logger.error('Background token indexer worker message', { type: message.type });
        // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
        console.error('[BackgroundTokenIndexer] Worker message', {
          type: (message as { type: string }).type,
        });

        if (message.type === 'ready') {
          logger.error('Background token indexer worker is ready');
          setIsReady(true);
          if (readinessTimerRef.current) {
            clearTimeout(readinessTimerRef.current);
            readinessTimerRef.current = null;
          }
          return;
        }

        if (message.type === 'log') {
          const logMsg = message as WorkerLog;
          const logPayload = { data: logMsg.data };
          if (logMsg.level === 'error') {
            logger.error(`Worker log: ${logMsg.message}`, logPayload);
          } else if (logMsg.level === 'warn') {
            logger.warn(`Worker log: ${logMsg.message}`, logPayload);
          } else if (logMsg.level === 'info') {
            logger.info(`Worker log: ${logMsg.message}`, logPayload);
          } else {
            logger.debug(`Worker log: ${logMsg.message}`, logPayload);
          }
          // biome-ignore lint/suspicious/noConsole: explicit visibility
          console.error('[BackgroundTokenIndexer][worker-log]', {
            level: logMsg.level,
            message: logMsg.message,
            data: logMsg.data,
          });
          return;
        }

        if (message.type === 'result') {
          void handleResult(message as IndexerResult);
        } else if (message.type === 'progress') {
          handleProgress(message as IndexerProgress);
        } else if (message.type === 'error') {
          handleError(message as IndexerError);
        }
      };

      worker.onerror = (error) => {
        logger.error('Worker error', {
          error: error?.message,
          filename: error?.filename,
          lineno: error?.lineno,
          colno: (error as ErrorEvent | undefined)?.colno,
          type: (error as ErrorEvent | undefined)?.type,
        });
        // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
        console.error('[BackgroundTokenIndexer] worker.onerror', {
          message: error?.message,
          filename: error?.filename,
          lineno: error?.lineno,
          colno: (error as ErrorEvent | undefined)?.colno,
          type: (error as ErrorEvent | undefined)?.type,
          errorObj: error,
        });
        logWorkerErrorOnce(error, 'worker.onerror');
      };
      worker.addEventListener('error', (event) => {
        const errEvent = event as ErrorEvent;
        logger.error('Worker error event', {
          type: errEvent.type,
          message: errEvent.message,
          filename: errEvent.filename,
          lineno: errEvent.lineno,
          colno: errEvent.colno,
          error: errEvent.error,
        });
        // biome-ignore lint/suspicious/noConsole: explicit visibility
        console.error('[BackgroundTokenIndexer] worker error event', {
          type: errEvent.type,
          message: errEvent.message,
          filename: errEvent.filename,
          lineno: errEvent.lineno,
          colno: errEvent.colno,
          error: errEvent.error,
        });
      });
      worker.onmessageerror = (event) => {
        logger.error('Worker messageerror', { type: event.type, data: event.data });
        // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
        console.error('[BackgroundTokenIndexer] worker.onmessageerror', {
          type: event.type,
          data: event.data,
        });
      };

      workerRef.current = worker;
      logger.error('Background token indexer worker created successfully');

      // If the worker never posts "ready", emit a hard error for visibility.
      readinessTimerRef.current = setTimeout(() => {
        if (!isReady) {
          logWorkerErrorOnce(new Error('Worker did not signal ready within 5s'), 'ready-timeout');
          // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
          console.error('[BackgroundTokenIndexer] ready-timeout (5s) - no ready message');
        }
      }, 5000);

      return () => {
        logger.debug('Terminating worker');
        worker.terminate();
        workerRef.current = null;
        if (readinessTimerRef.current) {
          clearTimeout(readinessTimerRef.current);
          readinessTimerRef.current = null;
        }
      };
    } catch (error) {
      logger.error('Failed to create worker', { error });
      // biome-ignore lint/suspicious/noConsole: explicit visibility for stuck worker
      console.error('[BackgroundTokenIndexer] createWorkerInstance failed', error);
      logWorkerErrorOnce(error, 'createWorkerInstance');
      return;
    }
  }, []);

  // Cleanup on unmount
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  /**
   * Handle result from worker
   */
  const handleResult = useCallback(
    async (result: IndexerResult) => {
      pendingFilesRef.current.delete(result.compositeKey);

      // If store is null, just notify without caching
      if (!store) {
        onFileIndexed?.(result.compositeKey, result.tokenCount);
        if (pendingFilesRef.current.size === 0) {
          setIsIndexing(false);
          setProgress(null);
        }
        return;
      }

      // If skipped (hash matched), we don't need to update the cache
      if (result.skipped) {
        // Get existing token count from cache
        const cached = await store.get(result.folderId, result.filePath);
        if (cached) {
          onFileIndexed?.(result.compositeKey, cached.tokenCount);
        }
        return;
      }

      // Store in persistent cache
      const entry: TokenCacheEntry = {
        folderId: result.folderId,
        filePath: result.filePath,
        contentHash: result.contentHash,
        fileSize: result.fileSize,
        mtimeMs: null,
        tokenCount: result.tokenCount,
        countingMode: result.mode,
        modelEncoding: result.mode === 'accurate' ? 'o200k_base' : null,
      };

      await store.set(entry);

      // Notify caller
      onFileIndexed?.(result.compositeKey, result.tokenCount);

      // Check if all done
      if (pendingFilesRef.current.size === 0) {
        setIsIndexing(false);
        setProgress(null);
      }
    },
    [store, onFileIndexed]
  );

  /**
   * Handle progress update from worker
   */
  const handleProgress = useCallback(
    (progressMsg: IndexerProgress) => {
      const newProgress: IndexingProgress = {
        completed: progressMsg.completed,
        total: progressMsg.total,
        currentFile: progressMsg.currentId,
      };
      setProgress(newProgress);
      onProgress?.(newProgress);
    },
    [onProgress]
  );

  /**
   * Handle error from worker
   */
  const handleError = useCallback((error: IndexerError) => {
    pendingFilesRef.current.delete(error.compositeKey);

    // biome-ignore lint/suspicious/noConsole: Error logging
    console.warn('[BackgroundTokenIndexer] File error:', error.compositeKey, error.error);

    // Check if all done
    if (pendingFilesRef.current.size === 0) {
      setIsIndexing(false);
      setProgress(null);
    }
  }, []);

  /**
   * Queue files for background indexing
   */
  const indexFiles = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch request building requires multiple conditionals for caching and handle types
    async (files: FileToIndex[]) => {
      if (!(workerRef.current && isReady) || files.length === 0) {
        logger.warn('indexFiles skipped - worker not ready', {
          hasWorker: !!workerRef.current,
          isReady,
          fileCount: files.length,
        });
        return;
      }

      setIsIndexing(true);

      // Build batch request, checking cache for existing hashes
      const requests: IndexerBatchRequest['requests'] = [];

      for (const file of files) {
        pendingFilesRef.current.add(file.compositeKey);

        // Check for cached hash to enable skip optimization (only if store is available)
        let cachedHash: string | undefined;
        if (store) {
          const cached = await store.get(file.folderId, file.filePath);
          cachedHash = cached?.countingMode === mode ? cached.contentHash : undefined;
        }

        requests.push({
          id: createRequestId(),
          compositeKey: file.compositeKey,
          folderId: file.folderId,
          filePath: file.filePath,
          cachedHash,
          mode,
          // Conditionally include handles to satisfy exactOptionalPropertyTypes
          ...(file.fileHandle ? { fileHandle: file.fileHandle } : {}),
          ...(file.electronHandle ? { electronHandle: file.electronHandle } : {}),
        });
      }

      // Send batch to worker
      const batchMessage: IndexerBatchRequest = {
        type: 'index-batch',
        requests,
      };

      workerRef.current.postMessage(batchMessage);
    },
    [isReady, store, mode]
  );

  /**
   * Cancel all pending indexing
   */
  const cancelIndexing = useCallback(() => {
    // Terminate and recreate worker
    if (workerRef.current) {
      const oldOnMessage = workerRef.current.onmessage;
      const oldOnError = workerRef.current.onerror;
      workerRef.current.terminate();
      pendingFilesRef.current.clear();
      setIsIndexing(false);
      setProgress(null);

      // Recreate worker
      const worker = createWorkerInstance();
      worker.onmessage = oldOnMessage;
      worker.onerror = oldOnError;
      workerRef.current = worker;
    }
  }, []);

  return {
    indexFiles,
    cancelIndexing,
    isIndexing,
    progress,
    isReady,
  };
}
