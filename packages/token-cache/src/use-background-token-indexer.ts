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

import { createLogger, generateUUID } from '@brainstrike/utils';
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
const TERMINAL_WORKER_ERROR_KEY = '__worker__';
const TERMINAL_TOKENIZER_ERROR_PATTERNS: RegExp[] = [
  /^accurate token counting unavailable:/i,
  /^accurate token counting failed:/i,
  /tiktoken encoder failed to initialize/i,
];

function normalizeTerminalErrorMessage(errorMessage: string): string {
  return errorMessage.trim().replace(/^error:\s*/i, '');
}

function isTerminalTokenizerError(errorMessage: string): boolean {
  const normalized = normalizeTerminalErrorMessage(errorMessage);
  return TERMINAL_TOKENIZER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractTerminalTokenizerErrorFromWorkerLog(logMessage: WorkerLog): string | null {
  if (logMessage.level !== 'error') {
    return null;
  }

  const data = logMessage.data;
  const candidateMessages: string[] = [];
  if (typeof data?.['error'] === 'string') {
    candidateMessages.push(data['error']);
  }
  if (typeof data?.['message'] === 'string') {
    candidateMessages.push(data['message']);
  }
  if (typeof data?.['cause'] === 'string') {
    candidateMessages.push(data['cause']);
  }

  for (const candidate of candidateMessages) {
    if (isTerminalTokenizerError(candidate)) {
      return candidate;
    }
  }

  return null;
}

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
  kind: 'file';
  name: string;
  path: string;
  platform: 'electron';
}

/**
 * File ready for indexing - supports both Web FileSystemFileHandle and Electron with pre-loaded content
 */
export interface FileToIndex {
  compositeKey: string;
  /** Pre-loaded file content (required for Electron) */
  content?: string;
  /** Web FileSystemFileHandle for File System Access API */
  fileHandle?: FileSystemFileHandle;
  filePath: string;
  /** Pre-loaded file size in bytes */
  fileSize?: number;
  folderId: string;
}

export interface IndexingProgress {
  completed: number;
  currentFile?: string;
  total: number;
}

export interface UseBackgroundTokenIndexerOptions {
  /** Token counting mode */
  mode: TokenCountingMode;
  /** Callback when a file fails to index */
  onFileError?: (compositeKey: string, error: string) => void;
  /** Callback when a file's token count is resolved (includes file size for cache updates) */
  onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void;
  /** Callback for progress updates */
  onProgress?: (progress: IndexingProgress) => void;
  /** Token cache store for persistence (null to disable indexing) */
  store: TokenCacheStoreLike | null;
}

export interface UseBackgroundTokenIndexerReturn {
  /** Cancel all pending indexing */
  cancelIndexing: () => void;
  /** Queue files for background indexing */
  indexFiles: (files: FileToIndex[]) => Promise<void>;
  /** Whether indexing is in progress */
  isIndexing: boolean;
  /** Whether the worker is ready */
  isReady: boolean;
  /** Current progress */
  progress: IndexingProgress | null;
}

/**
 * Create a unique ID for each indexing request
 */
function createRequestId(): string {
  return generateUUID();
}

interface PendingBatchTracker {
  done: boolean;
  reject: (error: Error) => void;
  remainingCompositeKeys: Set<string>;
  resolve: () => void;
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
  const readyRef = useRef(false);
  const workerFailureRef = useRef<Error | null>(null);
  const pendingBatchTrackersRef = useRef<PendingBatchTracker[]>([]);

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
        ? // Keep both keys for log-schema compatibility while consolidating to one log event.
          { message: error.message, error: error.message, stack: error.stack }
        : { error: String(error) };
    logger.error('Background token indexer entered failed state', {
      context,
      ...normalized,
    });
  }, []);

  const emitTerminalIndexingError = useCallback((errorMessage: string) => {
    const currentOnFileError = onFileErrorRef.current;
    emitIndexingError({
      compositeKey: TERMINAL_WORKER_ERROR_KEY,
      errorMessage,
    });
    currentOnFileError?.(TERMINAL_WORKER_ERROR_KEY, errorMessage);
  }, []);

  const settleBatchTrackersForCompositeKey = useCallback((compositeKey: string) => {
    const trackers = pendingBatchTrackersRef.current;
    if (trackers.length === 0) {
      return;
    }

    const remainingTrackers: PendingBatchTracker[] = [];
    for (const tracker of trackers) {
      if (tracker.done) {
        continue;
      }

      tracker.remainingCompositeKeys.delete(compositeKey);
      if (tracker.remainingCompositeKeys.size === 0) {
        tracker.done = true;
        tracker.resolve();
      } else {
        remainingTrackers.push(tracker);
      }
    }

    pendingBatchTrackersRef.current = remainingTrackers;
  }, []);

  const rejectAllPendingBatchTrackers = useCallback((error: Error) => {
    const trackers = pendingBatchTrackersRef.current;
    pendingBatchTrackersRef.current = [];
    for (const tracker of trackers) {
      if (tracker.done) {
        continue;
      }
      tracker.done = true;
      tracker.reject(error);
    }
  }, []);

  const failWorker = useCallback(
    (error: unknown, context: string) => {
      // CRITICAL: terminal worker failure is latched. Duplicate failure signals
      // can arrive from queued worker events and must not fan out callbacks/logging.
      if (workerFailureRef.current) {
        return;
      }

      const failure =
        error instanceof Error
          ? error
          : new Error(`Background token indexer failure: ${formatErrorMessage(error)}`);
      workerFailureRef.current = failure;
      readyRef.current = false;
      setIsReady(false);
      setIsIndexing(false);
      setProgress(null);

      const pendingCount = pendingFilesRef.current.size;
      const terminalMessage =
        `Background token indexer entered failed state (${context}): ${failure.message}. ` +
        `Pending files dropped: ${pendingCount}.`;

      // Terminal worker failures should emit one summarized error signal.
      // Per-file fan-out can create thousands of duplicate logs for a single root cause.
      emitTerminalIndexingError(terminalMessage);
      pendingFilesRef.current.clear();
      rejectAllPendingBatchTrackers(failure);

      if (readinessTimerRef.current) {
        clearTimeout(readinessTimerRef.current);
        readinessTimerRef.current = null;
      }

      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      logWorkerErrorOnce(failure, context);
    },
    [emitTerminalIndexingError, logWorkerErrorOnce, rejectAllPendingBatchTrackers]
  );

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

        // Ignore trailing messages from a worker that's already in terminal failure.
        // This prevents duplicate terminal emissions if the channel had queued events.
        if (workerFailureRef.current && message.type !== 'ready') {
          return;
        }

        if (message.type === 'ready') {
          readyRef.current = true;
          workerFailureRef.current = null;
          setIsReady(true);
          if (readinessTimerRef.current) {
            clearTimeout(readinessTimerRef.current);
            readinessTimerRef.current = null;
          }
          return;
        }

        if (message.type === 'log') {
          const logMsg = message as WorkerLog;
          const terminalTokenizerLogError = extractTerminalTokenizerErrorFromWorkerLog(logMsg);
          if (terminalTokenizerLogError) {
            failWorker(
              new Error(terminalTokenizerLogError),
              `worker.log.terminal-tokenizer.${logMsg.message}`
            );
            return;
          }

          // Worker already logs to its own console, so we only forward to our
          // structured logger for file/remote logging. No duplicate console output.
          const logPayload = logMsg.data;
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
          const workerError = message as IndexerError;
          // Treat worker/bootstrap/batch failures as terminal for deterministic behavior.
          // Continuing after these errors only creates noisy per-file cascades.
          const isTerminalError =
            workerError.id === '__init__' ||
            workerError.id === '__batch__' ||
            workerError.compositeKey === '__init__' ||
            workerError.compositeKey === '__batch__' ||
            isTerminalTokenizerError(workerError.error);
          if (isTerminalError) {
            const terminalContext = isTerminalTokenizerError(workerError.error)
              ? `worker.message.terminal-tokenizer.${workerError.compositeKey}`
              : `worker.message.${workerError.id || workerError.compositeKey}`;
            failWorker(new Error(workerError.error), terminalContext);
            return;
          }
          handleError(workerError);
        }
      };

      // Browser workers can dispatch both `onerror` and `addEventListener('error')`
      // for the same failure event. We register both for context-rich diagnostics;
      // failWorker is latched so terminal callbacks/telemetry still emit once.
      worker.onerror = (error) => {
        logger.error('Worker error', {
          error: error?.message,
          filename: error?.filename,
          lineno: error?.lineno,
          colno: (error as ErrorEvent | undefined)?.colno,
          type: (error as ErrorEvent | undefined)?.type,
        });
        failWorker(
          new Error(`Worker runtime error: ${error?.message ?? 'unknown worker error'}`),
          'worker.onerror'
        );
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
        failWorker(
          new Error(`Worker error event: ${errEvent.message || 'unknown worker error event'}`),
          'worker.addEventListener(error)'
        );
      });
      worker.onmessageerror = (event) => {
        logger.error('Worker messageerror', { type: event.type, data: event.data });
        failWorker(
          new Error('Worker message channel error (onmessageerror)'),
          'worker.onmessageerror'
        );
      };

      workerRef.current = worker;

      // If the worker never posts "ready", emit a hard error for visibility.
      readinessTimerRef.current = setTimeout(() => {
        if (!readyRef.current) {
          failWorker(new Error('Worker did not signal ready within 5s'), 'ready-timeout');
        }
      }, 5000);

      return () => {
        logger.debug('Terminating worker');
        worker.terminate();
        workerRef.current = null;
        readyRef.current = false;
        workerFailureRef.current = null;
        rejectAllPendingBatchTrackers(
          new Error('Background token indexer worker terminated during cleanup')
        );
        if (readinessTimerRef.current) {
          clearTimeout(readinessTimerRef.current);
          readinessTimerRef.current = null;
        }
      };
    } catch (error) {
      logger.error('Failed to create worker', { error });
      failWorker(error, 'createWorkerInstance');
      return;
    }
  }, [failWorker, rejectAllPendingBatchTrackers]);

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
  const handleResult = useCallback(
    async (result: IndexerResult) => {
      try {
        pendingFilesRef.current.delete(result.compositeKey);
        settleBatchTrackersForCompositeKey(result.compositeKey);

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
    },
    [settleBatchTrackersForCompositeKey]
  );

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
  const handleError = useCallback(
    (error: IndexerError) => {
      pendingFilesRef.current.delete(error.compositeKey);
      settleBatchTrackersForCompositeKey(error.compositeKey);

      // Emit telemetry for indexing error (BST-154)
      emitIndexingError({
        compositeKey: error.compositeKey,
        errorMessage: error.error,
      });

      const currentOnFileError = onFileErrorRef.current;
      if (currentOnFileError) {
        currentOnFileError(error.compositeKey, error.error);
      }

      logger.warn('Background token indexer file error', {
        compositeKey: error.compositeKey,
        error: error.error,
      });

      // Check if all done
      if (pendingFilesRef.current.size === 0) {
        setIsIndexing(false);
        setProgress(null);
      }
    },
    [settleBatchTrackersForCompositeKey]
  );

  /**
   * Queue files for background indexing.
   * Uses refs to get the latest store/mode/callbacks at call time.
   */
  const indexFiles = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch request building requires multiple conditionals for caching and handle types
    async (files: FileToIndex[]) => {
      if (files.length === 0) {
        return;
      }

      // CRITICAL: No skip/degraded fallback path. Worker unavailability is a hard failure.
      if (workerFailureRef.current) {
        const message =
          `Background token indexer unavailable: ${workerFailureRef.current.message}. ` +
          `Requested files dropped: ${files.length}.`;
        logger.error('indexFiles rejected - worker previously failed', {
          fileCount: files.length,
          error: workerFailureRef.current.message,
        });
        emitTerminalIndexingError(message);
        pendingFilesRef.current.clear();
        setIsIndexing(false);
        setProgress(null);
        throw new Error(message);
      }

      if (!(workerRef.current && isReady)) {
        const message = `Background token indexer worker is not ready. Requested files dropped: ${files.length}.`;
        logger.error('indexFiles rejected - worker not ready', {
          hasWorker: !!workerRef.current,
          isReady,
          fileCount: files.length,
        });
        emitTerminalIndexingError(message);
        pendingFilesRef.current.clear();
        setIsIndexing(false);
        setProgress(null);
        throw new Error(message);
      }

      // Get latest values from refs
      const currentStore = storeRef.current;
      const currentMode = modeRef.current;

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
              throw new Error(
                `Cache lookup failed for ${file.compositeKey}: ${formatErrorMessage(error)}`
              );
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

        const trackedCompositeKeys = requests.map((request) => request.compositeKey);
        let resolveBatch!: () => void;
        let rejectBatch!: (error: Error) => void;
        const completionPromise = new Promise<void>((resolve, reject) => {
          resolveBatch = resolve;
          rejectBatch = reject;
        });
        const tracker: PendingBatchTracker = {
          remainingCompositeKeys: new Set(trackedCompositeKeys),
          resolve: resolveBatch,
          reject: rejectBatch,
          done: false,
        };

        pendingBatchTrackersRef.current.push(tracker);
        workerRef.current.postMessage(batchMessage);
        await completionPromise;
      } catch (error) {
        const normalizedError =
          error instanceof Error ? error : new Error(formatErrorMessage(error));
        logger.error('indexFiles failed before dispatch', { error: normalizedError.message });
        const requestedFiles = files.length;
        const pendingBeforeClear = pendingFilesRef.current.size;
        pendingFilesRef.current.clear();
        rejectAllPendingBatchTrackers(normalizedError);
        const droppedCount = Math.max(requestedFiles, pendingBeforeClear);
        if (!workerFailureRef.current) {
          emitTerminalIndexingError(
            `Background token indexer failed before dispatch: ${normalizedError.message}. ` +
              `Requested files dropped: ${droppedCount}.`
          );
        }
        setIsIndexing(false);
        setProgress(null);
        throw normalizedError;
      }
    },
    [emitTerminalIndexingError, isReady, rejectAllPendingBatchTrackers]
  );

  /**
   * Cancel all pending indexing.
   * Clears pending files but keeps worker alive for reuse.
   * Any in-flight results will be ignored since they're not in pendingFilesRef.
   */
  const cancelIndexing = useCallback(() => {
    pendingFilesRef.current.clear();
    rejectAllPendingBatchTrackers(new Error('Background token indexer indexing canceled'));
    setIsIndexing(false);
    setProgress(null);
    // Worker stays alive - no need to terminate and recreate
  }, [rejectAllPendingBatchTrackers]);

  return {
    indexFiles,
    cancelIndexing,
    isIndexing,
    progress,
    isReady,
  };
}
