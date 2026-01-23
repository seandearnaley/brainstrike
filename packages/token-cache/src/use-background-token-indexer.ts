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
import { emitIndexedFile, emitIndexingBacklog, emitIndexingError } from './telemetry';
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
  onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void
): Promise<void> {
  if (result.skipped) {
    const cached = await store.get(result.folderId, result.filePath);
    if (cached) {
      onFileIndexed?.(result.compositeKey, cached.tokenCount, cached.fileSize);
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
  onFileIndexed?.(result.compositeKey, result.tokenCount, entry.fileSize);
}

/**
 * Electron-style handle with path property
 */
export interface ElectronFileHandle {
  path: string;
  name: string;
  kind: 'file';
  platform: 'electron';
}

/**
 * File ready for indexing - supports both Web FileSystemFileHandle and Electron with pre-loaded content
 */
export interface FileToIndex {
  compositeKey: string;
  folderId: string;
  filePath: string;
  /** Pre-loaded file content (required for Electron) */
  content?: string;
  /** Pre-loaded file size in bytes */
  fileSize?: number;
  /** Web FileSystemFileHandle for File System Access API */
  fileHandle?: FileSystemFileHandle;
}

export interface IndexingProgress {
  completed: number;
  total: number;
  currentFile?: string;
}

export interface UseBackgroundTokenIndexerOptions {
  /** Token cache store for persistence (null to disable indexing) */
  store: TokenCacheStoreLike | null;
  /** Token counting mode */
  mode: TokenCountingMode;
  /** Callback when a file's token count is resolved (includes file size for cache updates) */
  onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void;
  /** Callback for progress updates */
  onProgress?: (progress: IndexingProgress) => void;
  /** Callback when a file fails to index */
  onFileError?: (compositeKey: string, error: string) => void;
}

export interface UseBackgroundTokenIndexerReturn {
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
}

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

    try {
      const worker = createWorkerInstance();

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker message handler requires multiple conditional branches for different message types
      worker.onmessage = (event: MessageEvent<WorkerResponse | { type: 'ready' }>) => {
        if (!isMountedRef.current) {
          return;
        }

        const message = event.data;
        // Only log non-'log' message types to avoid duplicate noise
        // Worker 'log' messages are already logged by the worker itself
        if (message.type !== 'log') {
          logger.debug('Background token indexer worker message', { type: message.type });
        }

        if (message.type === 'ready') {
          setIsReady(true);
          if (readinessTimerRef.current) {
            clearTimeout(readinessTimerRef.current);
            readinessTimerRef.current = null;
          }
          return;
        }

        if (message.type === 'log') {
          // Worker already logs to its own console, so we only forward to our
          // structured logger for file/remote logging. No duplicate console output.
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

      // Emit telemetry for successful indexing (BST-154)
      emitIndexedFile({
        compositeKey: result.compositeKey,
        folderId: result.folderId,
        filePath: result.filePath,
        tokenCount: result.tokenCount,
        mode: result.mode,
        fileSize: result.fileSize,
        elapsedMs: result.elapsedMs,
        skipped: result.skipped,
      });

      // Get latest callback and store from refs
      const currentOnFileIndexed = onFileIndexedRef.current;
      const currentStore = storeRef.current;

      // If store is null, just notify without caching
      if (!currentStore) {
        currentOnFileIndexed?.(result.compositeKey, result.tokenCount, result.fileSize);
        return;
      }

      await persistResultToStore(result, currentStore, currentOnFileIndexed);
    } catch (error) {
      logger.error('handleResult failed', {
        compositeKey: result.compositeKey,
        error: formatErrorMessage(error),
      });
      // Emit telemetry for persistence error (BST-154)
      emitIndexingError({
        compositeKey: result.compositeKey,
        folderId: result.folderId,
        filePath: result.filePath,
        errorMessage: `Persistence failed: ${formatErrorMessage(error)}`,
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

    // Emit backlog telemetry (BST-154)
    emitIndexingBacklog({
      inFlight: pendingFilesRef.current.size,
      batchTotal: progressMsg.total,
      batchCompleted: progressMsg.completed,
    });
  }, []);

  /**
   * Handle error from worker.
   * Uses ref to always call the LATEST callback.
   */
  const handleError = useCallback((error: IndexerError) => {
    pendingFilesRef.current.delete(error.compositeKey);

    // Emit telemetry for indexing error (BST-154)
    emitIndexingError({
      compositeKey: error.compositeKey,
      errorMessage: error.error,
    });

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
