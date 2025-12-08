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

type TokenCacheStoreLike = Pick<TokenCacheStore, 'get' | 'set'>;

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

async function persistResultToStore(
  result: IndexerResult,
  store: TokenCacheStoreLike,
  onFileIndexed?: (compositeKey: string, tokenCount: number) => void
): Promise<void> {
  if (result.skipped) {
    const cached = await store.get(result.folderId, result.filePath);
    if (cached) {
      onFileIndexed?.(result.compositeKey, cached.tokenCount);
    }
    return;
  }

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
  onFileIndexed?.(result.compositeKey, result.tokenCount);
}

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
 * File ready for indexing - supports both Web FileSystemFileHandle and Electron with pre-loaded content
 */
export type FileToIndex = {
  compositeKey: string;
  folderId: string;
  filePath: string;
  /** Pre-loaded file content (required for Electron) */
  content?: string;
  /** Pre-loaded file size in bytes */
  fileSize?: number;
  /** Web FileSystemFileHandle for File System Access API */
  fileHandle?: FileSystemFileHandle;
};

export type IndexingProgress = {
  completed: number;
  total: number;
  currentFile?: string;
};

export type UseBackgroundTokenIndexerOptions = {
  /** Token cache store for persistence (null to disable indexing) */
  store: TokenCacheStoreLike | null;
  /** Token counting mode */
  mode: TokenCountingMode;
  /** Callback when a file's token count is resolved */
  onFileIndexed?: (compositeKey: string, tokenCount: number) => void;
  /** Callback for progress updates */
  onProgress?: (progress: IndexingProgress) => void;
  /** Callback when a file fails to index */
  onFileError?: (compositeKey: string, error: string) => void;
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
  onFileError,
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

  // Use refs to always call the LATEST callbacks from worker message handler.
  // This prevents stale closure bugs where worker.onmessage captures old callback versions.
  const onFileIndexedRef = useRef(onFileIndexed);
  const onProgressRef = useRef(onProgress);
  const onFileErrorRef = useRef(onFileError);
  const storeRef = useRef(store);
  const modeRef = useRef(mode);

  // Keep refs in sync with latest props
  useEffect(() => {
    onFileIndexedRef.current = onFileIndexed;
  }, [onFileIndexed]);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);
  useEffect(() => {
    onFileErrorRef.current = onFileError;
  }, [onFileError]);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

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
    // Reset mounted flag on each mount (fixes React StrictMode double-mount issue)
    isMountedRef.current = true;

    logger.info('Background token indexer init start', { hasStore: !!store, mode });
    // biome-ignore lint/suspicious/noConsole: startup visibility
    console.log('[BackgroundTokenIndexer] init start', { hasStore: !!store, mode });

    try {
      const worker = createWorkerInstance();
      logger.info('Background token indexer worker created; awaiting ready signal', {
        hasStore: !!store,
        mode,
      });
      // biome-ignore lint/suspicious/noConsole: startup visibility
      console.log('[BackgroundTokenIndexer] Worker created; waiting for ready', {
        hasStore: !!store,
        mode,
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker message handler requires multiple conditional branches for different message types
      worker.onmessage = (event: MessageEvent<WorkerResponse | { type: 'ready' }>) => {
        if (!isMountedRef.current) {
          return;
        }

        const message = event.data;
        logger.debug('Background token indexer worker message', { type: message.type });
        // biome-ignore lint/suspicious/noConsole: message visibility
        console.log('[BackgroundTokenIndexer] Worker message', {
          type: (message as { type: string }).type,
        });

        if (message.type === 'ready') {
          logger.info('Background token indexer worker is ready');
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
          // biome-ignore lint/suspicious/noConsole: worker log visibility
          console.log('[BackgroundTokenIndexer][worker-log]', {
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
      logger.info('Background token indexer worker created successfully');

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
   * Handle result from worker.
   * Uses refs to always call the LATEST callbacks (avoids stale closure bug).
   */
  const handleResult = useCallback(async (result: IndexerResult) => {
    try {
      pendingFilesRef.current.delete(result.compositeKey);

      // Get latest callback and store from refs
      const currentOnFileIndexed = onFileIndexedRef.current;
      const currentStore = storeRef.current;

      // If store is null, just notify without caching
      if (!currentStore) {
        currentOnFileIndexed?.(result.compositeKey, result.tokenCount);
        return;
      }

      await persistResultToStore(result, currentStore, currentOnFileIndexed);
    } catch (error) {
      logger.error('handleResult failed', {
        compositeKey: result.compositeKey,
        error: formatErrorMessage(error),
      });
      const currentOnFileError = onFileErrorRef.current;
      if (currentOnFileError) {
        currentOnFileError(result.compositeKey, formatErrorMessage(error));
      }
    } finally {
      // Check if all done (handles both skipped and counted results)
      if (pendingFilesRef.current.size === 0) {
        setIsIndexing(false);
        setProgress(null);
      }
    }
  }, []);

  /**
   * Handle progress update from worker.
   * Uses ref to always call the LATEST callback.
   */
  const handleProgress = useCallback((progressMsg: IndexerProgress) => {
    const newProgress: IndexingProgress = {
      completed: progressMsg.completed,
      total: progressMsg.total,
      currentFile: progressMsg.currentId,
    };
    setProgress(newProgress);
    onProgressRef.current?.(newProgress);
  }, []);

  /**
   * Handle error from worker.
   * Uses ref to always call the LATEST callback.
   */
  const handleError = useCallback((error: IndexerError) => {
    pendingFilesRef.current.delete(error.compositeKey);

    const currentOnFileError = onFileErrorRef.current;
    if (currentOnFileError) {
      currentOnFileError(error.compositeKey, error.error);
    }

    // biome-ignore lint/suspicious/noConsole: Error logging
    console.warn('[BackgroundTokenIndexer] File error:', error.compositeKey, error.error);

    // Check if all done
    if (pendingFilesRef.current.size === 0) {
      setIsIndexing(false);
      setProgress(null);
    }
  }, []);

  /**
   * Queue files for background indexing.
   * Uses refs to get the latest store/mode/callbacks at call time.
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

      // Get latest values from refs
      const currentStore = storeRef.current;
      const currentMode = modeRef.current;
      const currentOnFileError = onFileErrorRef.current;

      setIsIndexing(true);

      try {
        // Build batch request, checking cache for existing hashes
        const requests: IndexerBatchRequest['requests'] = [];

        for (const file of files) {
          pendingFilesRef.current.add(file.compositeKey);

          // Check for cached hash to enable skip optimization (only if store is available)
          let cachedHash: string | undefined;
          if (currentStore) {
            try {
              const cached = await currentStore.get(file.folderId, file.filePath);
              cachedHash = cached?.countingMode === currentMode ? cached.contentHash : undefined;
            } catch (error) {
              logger.error('indexFiles cache lookup failed', {
                compositeKey: file.compositeKey,
                error: formatErrorMessage(error),
              });
              pendingFilesRef.current.delete(file.compositeKey);
              currentOnFileError?.(file.compositeKey, formatErrorMessage(error));
              continue;
            }
          }

          requests.push({
            id: createRequestId(),
            compositeKey: file.compositeKey,
            folderId: file.folderId,
            filePath: file.filePath,
            cachedHash,
            mode: currentMode,
            // Include pre-loaded content for Electron files
            ...(file.content !== undefined ? { content: file.content } : {}),
            ...(file.fileSize !== undefined ? { fileSize: file.fileSize } : {}),
            // Include file handle for Web files
            ...(file.fileHandle ? { fileHandle: file.fileHandle } : {}),
          });
        }

        if (requests.length === 0) {
          setIsIndexing(false);
          setProgress(null);
          return;
        }

        // Send batch to worker
        const batchMessage: IndexerBatchRequest = {
          type: 'index-batch',
          requests,
        };

        workerRef.current.postMessage(batchMessage);
      } catch (error) {
        logger.error('indexFiles failed before dispatch', { error: formatErrorMessage(error) });
        for (const file of files) {
          pendingFilesRef.current.delete(file.compositeKey);
          currentOnFileError?.(file.compositeKey, formatErrorMessage(error));
        }
        setIsIndexing(false);
        setProgress(null);
      }
    },
    [isReady]
  );

  /**
   * Cancel all pending indexing.
   * Clears pending files but keeps worker alive for reuse.
   * Any in-flight results will be ignored since they're not in pendingFilesRef.
   */
  const cancelIndexing = useCallback(() => {
    pendingFilesRef.current.clear();
    setIsIndexing(false);
    setProgress(null);
    // Worker stays alive - no need to terminate and recreate
  }, []);

  return {
    indexFiles,
    cancelIndexing,
    isIndexing,
    progress,
    isReady,
  };
}
