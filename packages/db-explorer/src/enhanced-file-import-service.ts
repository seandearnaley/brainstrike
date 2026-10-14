import { useVectorPreferencesStore } from '@brainstrike/app-state/stores/vector-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type {
  ChunkingStrategy,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import {
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db/react';
import type {
  BaseImportRunner,
  EmbeddingJobQueuePort,
  EnhancedImportProgress,
  EnhancedImportResult,
  SqlExecutorPort,
} from '@brainstrike/file-import';
import { backfillEmbeddingSetAssignments } from '@brainstrike/file-import';
import { createBrowserEmbeddingQueuePort } from '@brainstrike/file-import/browser-queue-port';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { runEnhancedImport } from '@brainstrike/file-import/enhanced-import';
import { createLogger } from '@brainstrike/logging';
import { createEmbeddingJobQueuePort } from '@brainstrike/pipeline';
import type { QueueAdapter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION, type IFileNode } from '@brainstrike/types';
import { onQueueProgress, type QueueProgressEventDetail } from '@brainstrike/utils/browser-events';
import { getActiveEmbeddingSetId, setActiveEmbeddingSetId } from '@brainstrike/vector-management';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFileImportService } from './base-file-import-service';
import { getSourceFilesCapability } from './file-import/native-source-import';

const logger = createLogger('AppShell:EnhancedFileImport');
const QUEUE_PROGRESS_THROTTLE_MS = 100;

/**
 * `isEmbeddingQueueActive` is app-wide state on the shared vector-status store,
 * but more than one import surface can subscribe to queue progress at a time
 * (the Database panel and the explorer's selection bar). Refcount the
 * subscribers so the LAST one to unmount clears the flag — otherwise whichever
 * surface unmounts first reports "idle" on behalf of the one still running.
 */
let queueProgressSubscriberCount = 0;

/** Test-only reset helper for the module-scoped queue-progress subscriber count. */
export function __resetQueueProgressSubscriberCountForTests(): void {
  queueProgressSubscriberCount = 0;
}

// Extended progress interface for chunking and embedding
interface EnhancedFileImportOptions {
  chunkingStrategy?: ChunkingStrategy;
  chunkingStrategyExplicit?: boolean;
  chunkOverlap?: number;
  chunkSize?: number;
  chunkTokenLimit?: number;
  embeddingQueue?: QueueAdapter | null;
  enableChunking?: boolean;
  onComplete?: (results: EnhancedImportResult[]) => Promise<void> | void;
  onError?: (error: Error) => void;
  onProgress?: (progress: EnhancedImportProgress) => void;
  resolveTargetEmbeddingSetId?: () => string | null;
  tokenTrueSizing?: boolean;
}

interface EnhancedFileImportServiceReturn {
  cancelImport: () => void;
  chunkRepository: ReturnType<typeof useFileChunkRepository>;
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>,
    abortSignal?: AbortSignal
  ) => Promise<void>;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
}

type EnhancedImportParams = Parameters<typeof runEnhancedImport<IFileNode>>[0];
type EmbeddingConfig = NonNullable<EnhancedImportParams['embedding']>;
type ChunkingWorkerPort = import('@brainstrike/file-import').ChunkingWorkerPort;

function createEmbeddingConfig(
  chunkRepository: ReturnType<typeof useFileChunkRepository>,
  resolveTargetEmbeddingSetId: () => string | null
): EmbeddingConfig {
  return {
    chunkRepository,
    enabled: false,
    onResolvedTargetSetId: (id: string) => {
      setActiveEmbeddingSetId(id);
    },
    resolveTargetEmbeddingSetId,
    service: null,
  };
}

function createPorts(
  queuePort: EmbeddingJobQueuePort | null,
  sqlPort: SqlExecutorPort | null
): EnhancedImportParams['ports'] {
  const ports: EnhancedImportParams['ports'] = {};
  if (queuePort) {
    ports.embeddingQueue = queuePort;
  }
  if (sqlPort) {
    ports.sql = sqlPort;
  }
  return Object.keys(ports).length > 0 ? ports : undefined;
}

function createChunkingConfig(
  options: EnhancedFileImportOptions,
  repository: ReturnType<typeof useFileRecordRepository>,
  chunkRepository: ReturnType<typeof useFileChunkRepository>,
  chunkingWorkerPort: import('@brainstrike/file-import').ChunkingWorkerPort | null
): EnhancedImportParams['chunking'] {
  const config: EnhancedImportParams['chunking'] = {
    deps: { chunkRepository, repository },
    enabled: Boolean(options.enableChunking),
  };
  if (options.chunkingStrategy !== undefined) {
    config.strategy = options.chunkingStrategy;
  }
  if (options.chunkingStrategyExplicit !== undefined) {
    config.strategyExplicit = options.chunkingStrategyExplicit;
  }
  if (options.chunkSize !== undefined) {
    config.chunkSize = options.chunkSize;
  }
  if (options.chunkOverlap !== undefined) {
    config.chunkOverlap = options.chunkOverlap;
  }
  config.tokenTrueSizing = options.tokenTrueSizing ?? true;
  if (options.chunkTokenLimit !== undefined) {
    config.tokenLimit = options.chunkTokenLimit;
  }
  // Use worker for off-main-thread chunking (if available)
  if (chunkingWorkerPort) {
    config.chunkingWorkerPort = chunkingWorkerPort;
  }
  return config;
}

function createProgressHandlers(
  update: Dispatch<SetStateAction<EnhancedImportProgress | null>>,
  emit: EnhancedFileImportOptions['onProgress']
): EnhancedImportParams['progressHandlers'] {
  const handlers: EnhancedImportParams['progressHandlers'] = {
    update,
  };
  if (emit) {
    handlers.emit = emit;
  }
  return handlers;
}

interface ImportFlowDeps {
  activeSetIdRef: { current: string | null };
  baseImportRunner: BaseImportRunner<IFileNode>;
  chunkingWorkerPort: ChunkingWorkerPort | null;
  chunkRepository: ReturnType<typeof useFileChunkRepository>;
  controller: AbortController;
  fileContents: Record<string, string>;
  fileTree: IFileNode[];
  options: EnhancedFileImportOptions;
  queuePort: EmbeddingJobQueuePort | null;
  repository: ReturnType<typeof useFileRecordRepository>;
  selectedFilePaths: Set<string>;
  setProgress: Dispatch<SetStateAction<EnhancedImportProgress | null>>;
  sqlPort: SqlExecutorPort | null;
}

async function runImportFlow({
  controller,
  selectedFilePaths,
  fileTree,
  fileContents,
  options,
  baseImportRunner,
  repository,
  chunkRepository,
  chunkingWorkerPort,
  queuePort,
  sqlPort,
  setProgress,
  activeSetIdRef,
}: ImportFlowDeps): Promise<void> {
  try {
    // Check if already aborted
    if (controller.signal.aborted) {
      logger.info('Import aborted before starting');
      return;
    }

    logger.info('Preparing embedding config for enhanced import', {
      activeSetId: activeSetIdRef.current,
    });
    const embeddingConfig = createEmbeddingConfig(
      chunkRepository,
      () => activeSetIdRef.current ?? null
    );
    logger.debug('Embedding config created', { embeddingConfig });
    const ports = createPorts(queuePort, sqlPort);
    // Direct setProgress - worker is in context so re-renders don't affect it
    const progressHandlers = createProgressHandlers(setProgress, options.onProgress);

    const params: EnhancedImportParams = {
      baseImportRunner,
      chunking: createChunkingConfig(options, repository, chunkRepository, chunkingWorkerPort),
      embedding: embeddingConfig,
      progressHandlers,
      request: { fileContents, fileTree, selectedFilePaths },
      ...(ports ? { ports } : {}),
    };

    const results = await runEnhancedImport<IFileNode>(params);
    logger.info('Enhanced import flow produced results', {
      activeSetId: activeSetIdRef.current,
      chunksCreated: results.reduce((sum, result) => sum + (result.chunksCreated || 0), 0),
      chunksWithEmbeddings: results.reduce(
        (sum, result) => sum + (result.chunksWithEmbeddings || 0),
        0
      ),
      errors: results.filter((result) => Boolean(result.error)).length,
      files: results.length,
    });

    // Check if aborted after import
    if (controller.signal.aborted) {
      logger.info('Import completed but was cancelled - keeping imported files/chunks');
      return;
    }

    await backfillEmbeddingSetAssignments(
      sqlPort ?? null,
      activeSetIdRef.current ?? null,
      results.map((result) => result.id)
    );

    await options.onComplete?.(results);
  } catch (error) {
    if (controller.signal.aborted) {
      logger.info('Import aborted', { error });
      return;
    }
    logger.error('Enhanced import flow failed', {
      activeSetId: activeSetIdRef.current,
      error: error instanceof Error ? error.message : String(error),
      selectedFiles: selectedFilePaths.size,
      stack: error instanceof Error ? error.stack : undefined,
    });
    options.onError?.(error instanceof Error ? error : new Error('Import failed'));
  }
}

async function runNativeImportFlow({
  controller,
  baseImportRunner,
  fileContents,
  fileTree,
  selectedFilePaths,
  setProgress,
  options,
}: Pick<
  ImportFlowDeps,
  | 'controller'
  | 'baseImportRunner'
  | 'fileContents'
  | 'fileTree'
  | 'selectedFilePaths'
  | 'setProgress'
  | 'options'
>): Promise<void> {
  if (controller.signal.aborted) {
    return;
  }
  const imported = await baseImportRunner({
    fileContents,
    fileTree,
    onProgress: (update) => {
      const progress = { ...update, phase: 'importing' as const };
      setProgress(progress);
      options.onProgress?.(progress);
    },
    selectedFilePaths,
  });
  if (controller.signal.aborted) {
    return;
  }
  const results = imported.map((item): EnhancedImportResult => {
    if (!('chunksCreated' in item) || typeof item.chunksCreated !== 'number') {
      throw new Error('Native import omitted its canonical chunk count.');
    }
    return { ...item, chunksCreated: item.chunksCreated };
  });
  const complete: EnhancedImportProgress = {
    completed: selectedFilePaths.size,
    errors: results.flatMap((item) => (item.error ? [{ error: item.error, file: item.id }] : [])),
    phase: 'complete',
    total: selectedFilePaths.size,
  };
  setProgress(complete);
  options.onProgress?.(complete);
  await options.onComplete?.(results);
}

function notifyImportFailure(
  error: unknown,
  signal: AbortSignal,
  onError: EnhancedFileImportOptions['onError']
): void {
  if (signal.aborted) {
    return;
  }
  onError?.(error instanceof Error ? error : new Error('Import failed'));
}

export function useEnhancedFileImportService(
  options: EnhancedFileImportOptions = {}
): EnhancedFileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);
  const activeSetIdRef = useRef<string | null>(options.resolveTargetEmbeddingSetId?.() ?? null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const setIsEmbeddingQueueActive = useVectorStatusUIStore((s) => s.setIsEmbeddingQueueActive);
  const setGlobalIsImporting = useVectorStatusUIStore((s) => s.setIsImporting);
  const lastQueueActiveRef = useRef(false);
  const queueActiveClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQueueProgressRef = useRef<QueueProgressEventDetail | null>(null);
  const queueProgressFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseCallbacksRef = useRef<{
    onProgress?: (progress: ImportProgress) => void;
    onComplete?: (results: FileImportResult[]) => void;
    onError?: (error: Error) => void;
  } | null>(null);

  const sourceFiles = getSourceFilesCapability();
  const repository = useFileRecordRepository({ enabled: !sourceFiles });
  const chunkRepository = useFileChunkRepository({ enabled: !sourceFiles });
  const db = usePGliteDatabase({ enabled: !sourceFiles });
  const devicePref = useVectorPreferencesStore((s) => s.devicePref);

  // Get chunking worker from context - initialized at app root, not affected by progress re-renders
  const { port: chunkingWorkerPort, ensureStarted: ensureChunkingWorkerStarted } =
    useChunkingWorkerContext();

  // Feature flag to control embedding queue producer (Phase 3)
  const embedQueueEnabled = (() => {
    try {
      // Prefer explicit env; default disabled
      // Use proper type guard for Node.js environment
      if (process?.env?.['EMBED_QUEUE_ENABLED']) {
        return String(process.env['EMBED_QUEUE_ENABLED']).toLowerCase() === 'true';
      }
    } catch (error) {
      logger.debug('Failed to read EMBED_QUEUE_ENABLED env flag', { error });
    }
    return false;
  })();

  const baseImportService = useFileImportService({
    onComplete: (results) => {
      baseCallbacksRef.current?.onComplete?.(results);
    },
    onError: (error) => {
      baseCallbacksRef.current?.onError?.(error);
    },
    onProgress: (progress) => {
      baseCallbacksRef.current?.onProgress?.(progress);
    },
  });

  const browserQueuePort = useMemo<EmbeddingJobQueuePort | null>(() => {
    if (sourceFiles || !(options.embeddingQueue && chunkRepository)) {
      return null;
    }

    return createBrowserEmbeddingQueuePort({
      chunkRepository,
      deviceHint: devicePref,
      queue: options.embeddingQueue,
    });
  }, [chunkRepository, devicePref, options.embeddingQueue, sourceFiles]);

  const updateQueueProgress = useCallback(
    (detail: QueueProgressEventDetail) => {
      // Direct setProgress is fine now - chunking worker is in context,
      // so re-renders here don't re-invoke the worker
      setProgress((prev) => {
        if (!prev) {
          return prev;
        }

        const next: EnhancedImportProgress = {
          ...prev,
          queueProgress: {
            failed: detail.failed,
            lastError: detail.lastError,
            lastEvent: {
              chunkId: detail.chunkId,
              model: detail.model,
              status: detail.status,
              ...(detail.elapsedMs === undefined ? {} : { elapsedMs: detail.elapsedMs }),
              ...(detail.errorMessage ? { errorMessage: detail.errorMessage } : {}),
            },
            pending: detail.pending,
            processed: detail.processed,
            totalQueued: detail.totalQueued,
          },
        };

        return next;
      });
    },
    [setProgress]
  );

  const updateQueueActive = useCallback(
    (isActive: boolean) => {
      if (isActive) {
        if (queueActiveClearTimeoutRef.current) {
          clearTimeout(queueActiveClearTimeoutRef.current);
          queueActiveClearTimeoutRef.current = null;
        }
        if (!lastQueueActiveRef.current) {
          lastQueueActiveRef.current = true;
          setIsEmbeddingQueueActive(true);
        }
        return;
      }

      if (!lastQueueActiveRef.current) {
        return;
      }

      if (queueActiveClearTimeoutRef.current) {
        clearTimeout(queueActiveClearTimeoutRef.current);
      }

      queueActiveClearTimeoutRef.current = setTimeout(() => {
        lastQueueActiveRef.current = false;
        setIsEmbeddingQueueActive(false);
        queueActiveClearTimeoutRef.current = null;
      }, 1500);
    },
    [setIsEmbeddingQueueActive]
  );

  const flushPendingQueueProgress = useCallback(() => {
    if (queueProgressFlushTimeoutRef.current) {
      clearTimeout(queueProgressFlushTimeoutRef.current);
      queueProgressFlushTimeoutRef.current = null;
    }

    const detail = pendingQueueProgressRef.current;
    if (!detail) {
      return;
    }

    pendingQueueProgressRef.current = null;
    updateQueueProgress(detail);
    updateQueueActive(detail.pending > 0);
  }, [updateQueueActive, updateQueueProgress]);

  const scheduleQueueProgressUpdate = useCallback(
    (detail: QueueProgressEventDetail) => {
      pendingQueueProgressRef.current = detail;

      if (detail.pending === 0 || detail.status === 'error') {
        flushPendingQueueProgress();
        return;
      }

      if (queueProgressFlushTimeoutRef.current) {
        return;
      }

      queueProgressFlushTimeoutRef.current = setTimeout(() => {
        flushPendingQueueProgress();
      }, QUEUE_PROGRESS_THROTTLE_MS);
    },
    [flushPendingQueueProgress]
  );

  useEffect(() => {
    if (!browserQueuePort) {
      return;
    }

    const unsubscribe = onQueueProgress((detail) => {
      if (!detail) {
        return;
      }

      scheduleQueueProgressUpdate(detail);
    });

    queueProgressSubscriberCount += 1;

    return () => {
      unsubscribe();
      if (queueProgressFlushTimeoutRef.current) {
        clearTimeout(queueProgressFlushTimeoutRef.current);
        queueProgressFlushTimeoutRef.current = null;
      }
      pendingQueueProgressRef.current = null;
      if (queueActiveClearTimeoutRef.current) {
        clearTimeout(queueActiveClearTimeoutRef.current);
        queueActiveClearTimeoutRef.current = null;
      }
      lastQueueActiveRef.current = false;
      queueProgressSubscriberCount -= 1;
      if (queueProgressSubscriberCount === 0) {
        setIsEmbeddingQueueActive(false);
      }
    };
  }, [browserQueuePort, scheduleQueueProgressUpdate, setIsEmbeddingQueueActive]);

  const jobQueuePort = useMemo<EmbeddingJobQueuePort | null>(() => {
    if (browserQueuePort) {
      return null;
    }
    if (!(embedQueueEnabled && db)) {
      return null;
    }

    return createEmbeddingJobQueuePort({
      createQueue: (executor) => new JobQueue(executor),
      db,
      defaultExpectedDimension: DEFAULT_EMBEDDING_DIMENSION,
    });
  }, [browserQueuePort, db, embedQueueEnabled]);

  const queuePort = browserQueuePort ?? jobQueuePort;

  const sqlPort = useMemo<SqlExecutorPort | null>(() => {
    if (!db) {
      return null;
    }

    const baseQuery: SqlExecutorPort['query'] = (sql, params) => db.query(sql, params);

    const transactionFn = db.transaction;
    if (typeof transactionFn === 'function') {
      const runInTransaction: SqlExecutorPort['runInTransaction'] = async <T>(
        fn: (tx: IDatabase) => Promise<T>
      ) => transactionFn((tx) => fn(tx as IDatabase));
      return { query: baseQuery, runInTransaction };
    }

    return { query: baseQuery };
  }, [db]);

  const baseImportRunner = useCallback<BaseImportRunner<IFileNode>>(
    ({ selectedFilePaths, fileTree, fileContents, onProgress }) =>
      new Promise<FileImportResult[]>((resolve, reject) => {
        baseCallbacksRef.current = {
          onComplete: (results) => {
            baseCallbacksRef.current = null;
            resolve(results);
          },
          onError: (error) => {
            baseCallbacksRef.current = null;
            reject(error);
          },
          onProgress,
        };

        const activeSetId = activeSetIdRef.current ?? null;
        logger.debug('Passing embeddingSetId to baseImportService', { activeSetId });

        baseImportService
          .importFiles(selectedFilePaths, fileTree, fileContents, activeSetId ?? undefined)
          .catch((error) => {
            baseCallbacksRef.current = null;
            reject(error instanceof Error ? error : new Error('Import failed'));
          });
      }),
    [baseImportService]
  );

  const importFiles = useCallback(
    async (
      selectedFilePaths: Set<string>,
      fileTree: IFileNode[],
      fileContents: Record<string, string>,
      abortSignal?: AbortSignal
    ) => {
      // Create internal abort controller if none provided
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Start each import with fresh queue progress accounting.
      if (queueProgressFlushTimeoutRef.current) {
        clearTimeout(queueProgressFlushTimeoutRef.current);
        queueProgressFlushTimeoutRef.current = null;
      }
      pendingQueueProgressRef.current = null;
      queuePort?.resetProgress?.();

      // Link external signal if provided
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => controller.abort());
      }

      setIsImporting(true);
      setGlobalIsImporting(true); // Pause background token indexer during import

      activeSetIdRef.current = options.resolveTargetEmbeddingSetId?.() ?? getActiveEmbeddingSetId();

      const initialProgress: EnhancedImportProgress = {
        completed: 0,
        errors: [],
        phase: 'importing',
        total: selectedFilePaths.size,
      };

      setProgress(initialProgress);
      // Ensure UI can react immediately (e.g., show progress panel)
      options.onProgress?.(initialProgress);

      try {
        if (sourceFiles) {
          await runNativeImportFlow({
            baseImportRunner,
            controller,
            fileContents,
            fileTree,
            options,
            selectedFilePaths,
            setProgress,
          });
          return;
        }
        const resolvedChunkingWorkerPort =
          options.enableChunking && chunkingWorkerPort === null
            ? await ensureChunkingWorkerStarted()
            : chunkingWorkerPort;

        await runImportFlow({
          activeSetIdRef,
          baseImportRunner,
          chunkingWorkerPort: resolvedChunkingWorkerPort ?? null,
          chunkRepository,
          controller,
          fileContents,
          fileTree,
          options,
          queuePort,
          repository,
          selectedFilePaths,
          setProgress,
          sqlPort: sqlPort ?? null,
        });
      } catch (error) {
        notifyImportFailure(error, controller.signal, options.onError);
      } finally {
        setIsImporting(false);
        setGlobalIsImporting(false); // Resume background token indexer
        abortControllerRef.current = null;
      }
    },
    [
      baseImportRunner,
      chunkRepository,
      chunkingWorkerPort,
      ensureChunkingWorkerStarted,
      options,
      queuePort,
      repository,
      setGlobalIsImporting,
      sourceFiles,
      sqlPort,
    ]
  );

  const cancelImport = useCallback(() => {
    if (abortControllerRef.current) {
      logger.info('Cancelling import');
      abortControllerRef.current.abort();
    }
  }, []);

  return useMemo(
    () => ({
      cancelImport,
      chunkRepository,
      importFiles,
      isImporting,
      progress,
    }),
    [importFiles, isImporting, progress, chunkRepository, cancelImport]
  );
}
