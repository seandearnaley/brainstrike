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

import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import { createWorkerRuntimeClient, type WorkerRuntimeClient } from '@brainstrike/worker-runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IndexerBatchRequest,
  IndexerError,
  IndexerErrorReason,
  IndexerProgress,
  IndexerResult,
  WorkerLog,
  WorkerResponse,
} from './background-indexer.worker';
import { resolveBackgroundIndexerWorkerUrl } from './resolve-worker-url';
import { emitIndexedFile, emitIndexingBacklog, emitIndexingError } from './telemetry';
import type { TokenCacheStore } from './token-cache-store';
import type { TokenCacheEntry, TokenCountingMode } from './types';
import {
  attachTerminalWorkerErrorDetails,
  clearTimerRef,
  createTerminalWorkerErrorDetails,
  extractTerminalTokenizerErrorFromWorkerLog,
  formatErrorMessage,
  getTerminalWorkerErrorDetails,
  isRecoverableWorkerFailure,
  isTerminalTokenizerError,
  MAX_RECOVERABLE_WORKER_RESTARTS,
  pruneRestartHistory,
  RECOVERABLE_WORKER_RESTART_BACKOFF_MS,
  RECOVERABLE_WORKER_RESTART_WINDOW_MS,
  TERMINAL_WORKER_ERROR_KEY,
} from './worker-error-recovery';

const logger = createLogger('BackgroundTokenIndexer');

type TokenCacheStoreLike = Pick<TokenCacheStore, 'get' | 'getBatch' | 'set'>;

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
    contentHash: result.contentHash,
    countingMode: result.mode,
    filePath: result.filePath,
    fileSize: result.fileSize,
    folderId: result.folderId,
    modelEncoding: result.mode === 'accurate' ? 'o200k_base' : null,
    mtimeMs: null,
    tokenCount: result.tokenCount,
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
  /** Start the worker immediately on mount instead of on first indexing request */
  autoStart?: boolean;
  /** Token counting mode */
  mode: TokenCountingMode;
  /**
   * Callback when a file yields no token count. `reason` distinguishes an
   * EXPECTED exclusion (`'binary'`) from a genuine failure (undefined), so the
   * caller can pick severity and decide whether a retry could ever help.
   */
  onFileError?: (compositeKey: string, error: string, reason?: IndexerErrorReason) => void;
  /** Callback when a file's token count is resolved (includes file size for cache updates) */
  onFileIndexed?: (compositeKey: string, tokenCount: number, fileSize: number) => void;
  /** Callback for progress updates */
  onProgress?: (progress: IndexingProgress) => void;
  /** Token cache store for persistence (null to disable indexing) */
  store: TokenCacheStoreLike | null;
  /** Worker URL override for app-owned worker graphs */
  workerUrl?: string;
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
  return `req_${generateUUID()}`;
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
function createWorkerInstance(workerUrl?: string): Worker {
  const url = workerUrl ?? resolveBackgroundIndexerWorkerUrl().href;
  return new Worker(url, { type: 'module' });
}

export function useBackgroundTokenIndexer({
  autoStart = true,
  store,
  mode,
  onFileIndexed,
  onProgress,
  onFileError,
  workerUrl,
}: UseBackgroundTokenIndexerOptions): UseBackgroundTokenIndexerReturn {
  const workerRef = useRef<Worker | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [progress, setProgress] = useState<IndexingProgress | null>(null);
  const workerErrorLoggedRef = useRef(false);
  const workerFailureHandledRef = useRef(false);
  const workerFailureHandledGenerationRef = useRef<number | null>(null);
  const workerGenerationRef = useRef(0);
  const workerInitPromiseRef = useRef<Promise<Worker> | null>(null);
  const ensureWorkerReadyRef = useRef<(() => Promise<Worker>) | null>(null);
  const workerMessageCleanupRef = useRef<(() => void) | null>(null);
  const readinessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workerRuntimeRef = useRef<WorkerRuntimeClient | null>(null);
  const terminalWorkerFailureRef = useRef<Error | null>(null);
  // Sliding window of restart timestamps; replaces a single count + stability
  // timer so flapping workers can't restart indefinitely by spacing failures
  // just past a fixed reset interval.
  const recoverableRestartHistoryRef = useRef<number[]>([]);
  const pendingBatchTrackersRef = useRef<PendingBatchTracker[]>([]);

  // Track pending files to enable cancellation
  const pendingFilesRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  // Use refs to always call the LATEST callbacks from worker message handler.
  // This prevents stale closure bugs where worker.onmessage captures old callback versions.
  const onFileIndexedRef = useRef(onFileIndexed);
  const onProgressRef = useRef(onProgress);
  const onFileErrorRef = useRef(onFileError);
  const handleResultRef = useRef<((result: IndexerResult) => Promise<void>) | null>(null);
  const handleProgressRef = useRef<((progress: IndexerProgress) => void) | null>(null);
  const handleErrorRef = useRef<((error: IndexerError) => void) | null>(null);
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
    const terminalWorkerErrorDetails = getTerminalWorkerErrorDetails(error);
    const normalized =
      error instanceof Error
        ? // Keep both keys for log-schema compatibility while consolidating to one log event.
          { error: error.message, message: error.message, stack: error.stack }
        : { error: String(error) };
    logger.error('Background token indexer entered failed state', {
      context,
      ...terminalWorkerErrorDetails,
      ...normalized,
    });
  }, []);

  const isWorkerFailureHandled = useCallback(
    (workerGeneration: number): boolean =>
      workerFailureHandledRef.current &&
      workerFailureHandledGenerationRef.current === workerGeneration,
    []
  );

  const markWorkerFailureHandled = useCallback((workerGeneration: number): void => {
    workerFailureHandledRef.current = true;
    workerFailureHandledGenerationRef.current = workerGeneration;
  }, []);

  const clearWorkerFailureHandled = useCallback((): void => {
    workerFailureHandledRef.current = false;
    workerFailureHandledGenerationRef.current = null;
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

  const disposeCurrentWorker = useCallback(() => {
    const worker = workerRef.current;
    const runtime = workerRuntimeRef.current;
    workerRef.current = null;
    workerRuntimeRef.current = null;
    workerInitPromiseRef.current = null;
    workerMessageCleanupRef.current?.();
    workerMessageCleanupRef.current = null;
    runtime?.resetReady();
    runtime?.clearFailure();
    runtime?.dispose();
    clearTimerRef(restartTimerRef);
    clearTimerRef(readinessTimerRef);
    if (worker) {
      worker.terminate();
    }
  }, []);

  const failWorker = useCallback(
    (error: unknown, context: string, workerGeneration = workerGenerationRef.current) => {
      // CRITICAL: terminal worker failure is latched. Duplicate failure signals
      // can arrive from queued worker events and must not fan out callbacks/logging.
      if (isWorkerFailureHandled(workerGeneration)) {
        return;
      }
      markWorkerFailureHandled(workerGeneration);

      const runtime = workerRuntimeRef.current;
      const failure = runtime
        ? runtime.markFailed(error)
        : error instanceof Error
          ? error
          : new Error(`Background token indexer failure: ${formatErrorMessage(error)}`);
      terminalWorkerFailureRef.current = failure;
      runtime?.resetReady();
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

      clearTimerRef(restartTimerRef);
      disposeCurrentWorker();

      logWorkerErrorOnce(failure, context);
    },
    [
      disposeCurrentWorker,
      emitTerminalIndexingError,
      isWorkerFailureHandled,
      logWorkerErrorOnce,
      markWorkerFailureHandled,
      rejectAllPendingBatchTrackers,
    ]
  );

  const scheduleRecoverableWorkerRestart = useCallback(
    (error: Error, context: string, workerGeneration = workerGenerationRef.current): boolean => {
      if (isWorkerFailureHandled(workerGeneration)) {
        // A worker may emit the same recoverable failure through multiple event surfaces.
        // Treat the short backoff window as dedupe, not as a new restart decision.
        return true;
      }
      if (!isRecoverableWorkerFailure(error, context)) {
        return false;
      }
      const history = recoverableRestartHistoryRef.current;
      const now = Date.now();
      const inWindow = pruneRestartHistory(history, now);
      if (inWindow >= MAX_RECOVERABLE_WORKER_RESTARTS) {
        return false;
      }

      markWorkerFailureHandled(workerGeneration);
      history.push(now);
      terminalWorkerFailureRef.current = null;

      const pendingCount = pendingFilesRef.current.size;
      pendingFilesRef.current.clear();
      rejectAllPendingBatchTrackers(error);
      setIsReady(false);
      setIsIndexing(false);
      setProgress(null);
      disposeCurrentWorker();

      logger.warn('Background token indexer restarting after recoverable worker failure', {
        attempt: history.length,
        context,
        maxAttempts: MAX_RECOVERABLE_WORKER_RESTARTS,
        windowMs: RECOVERABLE_WORKER_RESTART_WINDOW_MS,
        ...getTerminalWorkerErrorDetails(error),
        error: error.message,
        pendingFilesDropped: pendingCount,
      });

      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (!isMountedRef.current) {
          return;
        }
        clearWorkerFailureHandled();
        const startWorker = ensureWorkerReadyRef.current;
        if (!startWorker) {
          // Effect cleanup raced ahead of the restart timer. Surface a
          // terminal failure rather than leaving the worker in silent limbo
          // — consumers gate on getWorkerFailure(), so they need a signal.
          failWorker(
            new Error('Background token indexer restart skipped: no startup callback available'),
            'restart-timer.no-startup-callback',
            workerGeneration
          );
          return;
        }
        // failWorker already logs at error level on failure inside startWorker;
        // swallow the rejection here to avoid a duplicate warn entry.
        void startWorker().catch(() => {
          // Surfaced through getWorkerFailure() + state.
        });
      }, RECOVERABLE_WORKER_RESTART_BACKOFF_MS);

      return true;
    },
    [
      clearWorkerFailureHandled,
      disposeCurrentWorker,
      failWorker,
      isWorkerFailureHandled,
      markWorkerFailureHandled,
      rejectAllPendingBatchTrackers,
    ]
  );

  const ensureWorkerReady = useCallback(async (): Promise<Worker> => {
    const workerFailure =
      terminalWorkerFailureRef.current ?? workerRuntimeRef.current?.getFailure() ?? null;
    if (workerFailure) {
      throw workerFailure;
    }

    if (workerRuntimeRef.current?.isReady() && workerRef.current) {
      return workerRef.current;
    }

    if (workerInitPromiseRef.current) {
      return workerInitPromiseRef.current;
    }

    const initPromise = (async (): Promise<Worker> => {
      let worker: Worker;
      const workerGeneration = workerGenerationRef.current + 1;
      workerGenerationRef.current = workerGeneration;
      try {
        worker = createWorkerInstance(workerUrl);
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        // Worker constructor failures are treated as deterministic terminal failures.
        // The scheduler check only preserves an already-latched duplicate signal; this
        // context is intentionally absent from the recoverable allowlist.
        if (
          !scheduleRecoverableWorkerRestart(
            normalizedError,
            'createWorkerInstance',
            workerGeneration
          )
        ) {
          failWorker(normalizedError, 'createWorkerInstance', workerGeneration);
        }
        throw normalizedError;
      }
      workerRef.current = worker;
      clearWorkerFailureHandled();
      const runtime = createWorkerRuntimeClient(worker, {
        createErrorFromEvent: (event) =>
          attachTerminalWorkerErrorDetails(
            new Error(`Worker error event: ${event.message || 'unknown worker error event'}`),
            createTerminalWorkerErrorDetails(event)
          ),
        onFailure: (failure) => {
          if (
            !scheduleRecoverableWorkerRestart(
              failure,
              'worker.addEventListener(error)',
              workerGeneration
            )
          ) {
            failWorker(failure, 'worker.addEventListener(error)', workerGeneration);
          }
        },
      });
      workerRuntimeRef.current = runtime;
      const transport = runtime.transport;

      await new Promise<void>((resolve, reject) => {
        const settleReady = (): void => {
          worker.removeEventListener('messageerror', handleMessageChannelError);
          resolve();
        };

        const settleFailure = (error: Error, context: string): void => {
          if (scheduleRecoverableWorkerRestart(error, context, workerGeneration)) {
            reject(error);
            return;
          }
          failWorker(error, context, workerGeneration);
          reject(error);
        };

        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker startup and runtime messages are handled in one exhaustive strict-protocol branch.
        const handleMessage = (event: MessageEvent<WorkerResponse | { type: 'ready' }>) => {
          if (!isMountedRef.current) {
            return;
          }

          const message = event.data;

          if (workerRuntimeRef.current?.isFailed() && message.type !== 'ready') {
            return;
          }

          if (message.type === 'ready') {
            runtime.clearFailure();
            runtime.markReady();
            terminalWorkerFailureRef.current = null;
            // Restart budget is sliding-window: no reset on ready. The window
            // naturally ages out old restarts (see pruneRestartHistory), so a
            // worker that genuinely stabilizes gets a fresh budget after the
            // window elapses; a flapping worker hits the cap and escalates.
            clearWorkerFailureHandled();
            setIsReady(true);
            clearTimerRef(readinessTimerRef);
            settleReady();
            return;
          }

          if (message.type === 'log') {
            const logMsg = message as WorkerLog;
            const terminalTokenizerLogError = extractTerminalTokenizerErrorFromWorkerLog(logMsg);
            if (terminalTokenizerLogError) {
              settleFailure(
                new Error(terminalTokenizerLogError),
                `worker.log.terminal-tokenizer.${logMsg.message}`
              );
              return;
            }

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
            void handleResultRef.current?.(message as IndexerResult);
          } else if (message.type === 'progress') {
            handleProgressRef.current?.(message as IndexerProgress);
          } else if (message.type === 'error') {
            const workerError = message as IndexerError;
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
              settleFailure(new Error(workerError.error), terminalContext);
              return;
            }
            handleErrorRef.current?.(workerError);
          }
        };

        const handleWorkerError = (
          error: ErrorEvent | Event,
          context: 'worker.onerror' | 'worker.onmessageerror'
        ): void => {
          if (context === 'worker.onmessageerror') {
            settleFailure(
              attachTerminalWorkerErrorDetails(
                new Error('Worker message channel error (onmessageerror)'),
                createTerminalWorkerErrorDetails(error)
              ),
              context
            );
            return;
          }

          const errEvent = error as ErrorEvent;
          settleFailure(
            attachTerminalWorkerErrorDetails(
              new Error(`Worker runtime error: ${errEvent?.message ?? 'unknown worker error'}`),
              createTerminalWorkerErrorDetails(error)
            ),
            context
          );
        };

        const handleMessageChannelError = (event: Event) =>
          handleWorkerError(event as MessageEvent, 'worker.onmessageerror');

        workerMessageCleanupRef.current = transport.onMessage((message) => {
          void handleMessage({ data: message } as MessageEvent<WorkerResponse | { type: 'ready' }>);
        });
        worker.onerror = (event) => handleWorkerError(event, 'worker.onerror');
        worker.onmessageerror = (event) => handleWorkerError(event, 'worker.onmessageerror');
        worker.addEventListener('messageerror', handleMessageChannelError);

        readinessTimerRef.current = setTimeout(() => {
          if (!runtime.isReady()) {
            settleFailure(new Error('Worker did not signal ready within 5s'), 'ready-timeout');
          }
        }, 5000);
      });

      return worker;
    })();

    workerInitPromiseRef.current = initPromise;

    try {
      return await initPromise;
    } finally {
      if (workerInitPromiseRef.current === initPromise) {
        workerInitPromiseRef.current = null;
      }
    }
  }, [clearWorkerFailureHandled, failWorker, scheduleRecoverableWorkerRestart, workerUrl]);
  useEffect(() => {
    // Restart timers need the latest startup callback without making the
    // restart scheduler depend directly on ensureWorkerReady.
    ensureWorkerReadyRef.current = ensureWorkerReady;
    return () => {
      if (ensureWorkerReadyRef.current === ensureWorkerReady) {
        ensureWorkerReadyRef.current = null;
      }
    };
  }, [ensureWorkerReady]);

  useEffect(() => {
    isMountedRef.current = true;
    if (autoStart) {
      void ensureWorkerReady().catch(() => {
        // Worker startup failures are surfaced through state and structured logs.
      });
    }

    return () => {
      isMountedRef.current = false;
      logger.debug('Terminating worker');
      clearTimerRef(restartTimerRef);
      clearWorkerFailureHandled();
      workerErrorLoggedRef.current = false;
      terminalWorkerFailureRef.current = null;
      recoverableRestartHistoryRef.current = [];
      rejectAllPendingBatchTrackers(
        new Error('Background token indexer worker terminated during cleanup')
      );
      disposeCurrentWorker();
    };
  }, [
    autoStart,
    clearWorkerFailureHandled,
    disposeCurrentWorker,
    ensureWorkerReady,
    rejectAllPendingBatchTrackers,
  ]);

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
          elapsedMs: result.elapsedMs,
          filePath: result.filePath,
          fileSize: result.fileSize,
          folderId: result.folderId,
          mode: result.mode,
          skipped: result.skipped,
          tokenCount: result.tokenCount,
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
          errorMessage: `Persistence failed: ${formatErrorMessage(error)}`,
          filePath: result.filePath,
          folderId: result.folderId,
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
      currentFile: progressMsg.currentId,
      total: progressMsg.total,
    };
    setProgress(newProgress);
    onProgressRef.current?.(newProgress);

    // Emit backlog telemetry (BST-154)
    emitIndexingBacklog({
      batchCompleted: progressMsg.completed,
      batchTotal: progressMsg.total,
      inFlight: pendingFilesRef.current.size,
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

      const currentOnFileError = onFileErrorRef.current;
      if (currentOnFileError) {
        currentOnFileError(error.compositeKey, error.error, error.reason);
      }

      // An expected exclusion is not a warning. Keeping it at warn meant one
      // indexed tree of binary files cost three flight-recorder records each
      // (worker log, here, and the integration's error), evicting real ones.
      if (error.reason === 'binary') {
        logger.debug('Background token indexer excluded file', {
          compositeKey: error.compositeKey,
          reason: error.reason,
        });
      } else {
        emitIndexingError({
          compositeKey: error.compositeKey,
          errorMessage: error.error,
        });
        logger.warn('Background token indexer file error', {
          compositeKey: error.compositeKey,
          error: error.error,
        });
      }

      // Check if all done
      if (pendingFilesRef.current.size === 0) {
        setIsIndexing(false);
        setProgress(null);
      }
    },
    [settleBatchTrackersForCompositeKey]
  );

  handleResultRef.current = handleResult;
  handleProgressRef.current = handleProgress;
  handleErrorRef.current = handleError;

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

      await ensureWorkerReady();

      // CRITICAL: No skip/degraded fallback path. Worker unavailability is a hard failure.
      const workerFailure =
        terminalWorkerFailureRef.current ?? workerRuntimeRef.current?.getFailure() ?? null;
      if (workerFailure) {
        const message =
          `Background token indexer unavailable: ${workerFailure.message}. ` +
          `Requested files dropped: ${files.length}.`;
        logger.error('indexFiles rejected - worker previously failed', {
          error: workerFailure.message,
          fileCount: files.length,
        });
        emitTerminalIndexingError(message);
        pendingFilesRef.current.clear();
        setIsIndexing(false);
        setProgress(null);
        throw new Error(message);
      }

      if (!(workerRef.current && workerRuntimeRef.current?.isReady())) {
        const message = `Background token indexer worker is not ready. Requested files dropped: ${files.length}.`;
        logger.error('indexFiles rejected - worker not ready', {
          fileCount: files.length,
          hasWorker: !!workerRef.current,
          isReady: workerRuntimeRef.current?.isReady() ?? false,
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
        // Read each folder's cached hashes once before dispatching the worker batch.
        const cachedByFolder = new Map<string, Map<string, TokenCacheEntry>>();
        if (currentStore) {
          const filesByFolder = new Map<string, FileToIndex[]>();
          for (const file of files) {
            const folderFiles = filesByFolder.get(file.folderId) ?? [];
            folderFiles.push(file);
            filesByFolder.set(file.folderId, folderFiles);
          }
          await Promise.all(
            [...filesByFolder].map(async ([folderId, folderFiles]) => {
              try {
                const entries = await currentStore.getBatch(
                  folderId,
                  folderFiles.map((file) => file.filePath)
                );
                cachedByFolder.set(folderId, entries);
              } catch (error) {
                throw new Error(
                  `Cache lookup failed for ${folderFiles.map((file) => file.compositeKey).join(', ')}: ${formatErrorMessage(error)}`
                );
              }
            })
          );
        }
        const requests: IndexerBatchRequest['requests'] = [];
        for (const file of files) {
          pendingFilesRef.current.add(file.compositeKey);
          const cached = cachedByFolder.get(file.folderId)?.get(file.filePath);
          const cachedFileSize = cached?.countingMode === currentMode ? cached.fileSize : undefined;
          const cachedHash = cached?.countingMode === currentMode ? cached.contentHash : undefined;

          requests.push({
            cachedFileSize,
            cachedHash,
            compositeKey: file.compositeKey,
            filePath: file.filePath,
            folderId: file.folderId,
            id: createRequestId(),
            mode: currentMode,
            // Include pre-loaded content for Electron files
            ...(file.content === undefined ? {} : { content: file.content }),
            ...(file.fileSize === undefined ? {} : { fileSize: file.fileSize }),
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
          requests,
          type: 'index-batch',
        };

        const trackedCompositeKeys = requests.map((request) => request.compositeKey);
        let resolveBatch!: () => void;
        let rejectBatch!: (error: Error) => void;
        const completionPromise = new Promise<void>((resolve, reject) => {
          resolveBatch = resolve;
          rejectBatch = reject;
        });
        const tracker: PendingBatchTracker = {
          done: false,
          reject: rejectBatch,
          remainingCompositeKeys: new Set(trackedCompositeKeys),
          resolve: resolveBatch,
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
        if (!(terminalWorkerFailureRef.current || workerRuntimeRef.current?.isFailed())) {
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
    [emitTerminalIndexingError, ensureWorkerReady, rejectAllPendingBatchTrackers]
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
    cancelIndexing,
    indexFiles,
    isIndexing,
    isReady,
    progress,
  };
}
