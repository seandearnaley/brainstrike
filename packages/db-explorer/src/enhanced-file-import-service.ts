import type {
  ChunkingStrategy,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import {
  JobQueue,
  useBrainstrikeDbClient,
  useFileChunkRepository,
  useFileRecordRepository,
} from '@brainstrike/db';
import type {
  BaseImportRunner,
  EmbeddingJobQueuePort,
  EnhancedImportProgress,
  EnhancedImportResult,
  SqlExecutorPort,
} from '@brainstrike/file-import';
import { backfillEmbeddingSetAssignments } from '@brainstrike/file-import';
import {
  createBrowserEmbeddingQueuePort,
  type QueueProgressEventDetail,
} from '@brainstrike/file-import/browser-queue-port';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { runEnhancedImport } from '@brainstrike/file-import/enhanced-import';
import { createEmbeddingJobQueuePort } from '@brainstrike/pipeline';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION, type IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
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
import { getActiveEmbeddingSetId, setActiveEmbeddingSetId } from './vector-preferences';

const logger = createLogger('AppShell:EnhancedFileImport');
const QUEUE_PROGRESS_THROTTLE_MS = 100;

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
type BrainstrikeDbClient = ReturnType<typeof useBrainstrikeDbClient>;
type FileRecordRepository = ReturnType<typeof useFileRecordRepository>;
type FileChunkRepository = ReturnType<typeof useFileChunkRepository>;

function getManualImportCapabilityError({
  db,
  repository,
  chunkRepository,
}: {
  chunkRepository: FileChunkRepository;
  db: BrainstrikeDbClient;
  repository: FileRecordRepository;
}): Error | null {
  if (!db) {
    return new Error('Manual imports require an initialized database.');
  }
  if (!repository) {
    return new Error('Manual imports require file record storage.');
  }
  if (!chunkRepository) {
    return new Error('Manual imports require chunk storage.');
  }
  return null;
}

function createEmbeddingConfig(
  chunkRepository: ReturnType<typeof useFileChunkRepository>,
  resolveTargetEmbeddingSetId: () => string | null
): EmbeddingConfig {
  return {
    enabled: false,
    service: null,
    chunkRepository,
    resolveTargetEmbeddingSetId,
    onResolvedTargetSetId: (id: string) => {
      setActiveEmbeddingSetId(id);
    },
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
    enabled: Boolean(options.enableChunking),
    deps: { repository, chunkRepository },
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
      request: { selectedFilePaths, fileTree, fileContents },
      baseImportRunner,
      chunking: createChunkingConfig(options, repository, chunkRepository, chunkingWorkerPort),
      embedding: embeddingConfig,
      progressHandlers,
      ...(ports ? { ports } : {}),
    };

    const results = await runEnhancedImport<IFileNode>(params);
    logger.info('Enhanced import flow produced results', {
      activeSetId: activeSetIdRef.current,
      files: results.length,
      chunksCreated: results.reduce((sum, result) => sum + (result.chunksCreated || 0), 0),
      chunksWithEmbeddings: results.reduce(
        (sum, result) => sum + (result.chunksWithEmbeddings || 0),
        0
      ),
      errors: results.filter((result) => Boolean(result.error)).length,
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
      selectedFiles: selectedFilePaths.size,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    options.onError?.(error instanceof Error ? error : new Error('Import failed'));
  }
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

  const repository = useFileRecordRepository();
  const chunkRepository = useFileChunkRepository();
  const db = useBrainstrikeDbClient();
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
    onProgress: (progress) => {
      baseCallbacksRef.current?.onProgress?.(progress);
    },
    onComplete: (results) => {
      baseCallbacksRef.current?.onComplete?.(results);
    },
    onError: (error) => {
      baseCallbacksRef.current?.onError?.(error);
    },
  });

  const browserQueuePort = useMemo<EmbeddingJobQueuePort | null>(() => {
    if (!(options.embeddingQueue && chunkRepository)) {
      return null;
    }

    return createBrowserEmbeddingQueuePort({
      queue: options.embeddingQueue,
      chunkRepository,
      deviceHint: devicePref,
    });
  }, [chunkRepository, devicePref, options.embeddingQueue]);

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
            pending: detail.pending,
            processed: detail.processed,
            failed: detail.failed,
            totalQueued: detail.totalQueued,
            lastError: detail.lastError,
            lastEvent: {
              chunkId: detail.chunkId,
              status: detail.status,
              model: detail.model,
              ...(detail.elapsedMs === undefined ? {} : { elapsedMs: detail.elapsedMs }),
              ...(detail.errorMessage ? { errorMessage: detail.errorMessage } : {}),
            },
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
    if (typeof window === 'undefined' || !browserQueuePort) {
      return;
    }

    const handler = (event: Event) => {
      const custom = event as CustomEvent<QueueProgressEventDetail | undefined>;
      const detail = custom.detail;
      if (!detail) {
        return;
      }

      scheduleQueueProgressUpdate(detail);
    };

    window.addEventListener('brainstrike:queue-progress', handler as EventListener);
    return () => {
      window.removeEventListener('brainstrike:queue-progress', handler as EventListener);
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
      setIsEmbeddingQueueActive(false);
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
      db,
      createQueue: (executor) => new JobQueue(executor),
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
          onProgress,
          onComplete: (results) => {
            baseCallbacksRef.current = null;
            resolve(results);
          },
          onError: (error) => {
            baseCallbacksRef.current = null;
            reject(error);
          },
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
      const capabilityError = getManualImportCapabilityError({ db, repository, chunkRepository });
      if (capabilityError) {
        logger.error('Manual import blocked because required storage is unavailable', {
          error: capabilityError.message,
        });
        options.onError?.(capabilityError);
        return;
      }

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
        total: selectedFilePaths.size,
        completed: 0,
        errors: [],
        phase: 'importing',
      };

      setProgress(initialProgress);
      // Ensure UI can react immediately (e.g., show progress panel)
      options.onProgress?.(initialProgress);

      try {
        const resolvedChunkingWorkerPort =
          options.enableChunking && chunkingWorkerPort === null
            ? await ensureChunkingWorkerStarted()
            : chunkingWorkerPort;

        await runImportFlow({
          controller,
          selectedFilePaths,
          fileTree,
          fileContents,
          options,
          baseImportRunner,
          repository,
          chunkRepository,
          chunkingWorkerPort: resolvedChunkingWorkerPort ?? null,
          queuePort,
          sqlPort: sqlPort ?? null,
          setProgress,
          activeSetIdRef,
        });
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
      db,
      ensureChunkingWorkerStarted,
      options,
      queuePort,
      repository,
      setGlobalIsImporting,
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
      importFiles,
      isImporting,
      progress,
      chunkRepository,
      cancelImport,
    }),
    [importFiles, isImporting, progress, chunkRepository, cancelImport]
  );
}
