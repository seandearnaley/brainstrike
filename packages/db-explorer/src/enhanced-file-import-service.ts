import type {
  ChunkingStrategy,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import {
  JobQueue,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import type { EmbeddingProviderType } from '@brainstrike/embeddings';
import {
  isHostedProvider,
  parseProviderModelKey,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import type {
  BaseImportRunner,
  EmbeddingJobQueuePort,
  EnhancedImportProgress,
  EnhancedImportResult,
  SqlExecutorPort,
} from '@brainstrike/file-import';
import {
  createBrowserEmbeddingQueuePort,
  type QueueProgressEventDetail,
  runEnhancedImport,
} from '@brainstrike/file-import';
import type { QueueAdapter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION, type IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
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

// Extended progress interface for chunking and embedding
interface EnhancedFileImportOptions {
  onProgress?: (progress: EnhancedImportProgress) => void;
  onComplete?: (results: EnhancedImportResult[]) => void;
  onError?: (error: Error) => void;
  enableChunking?: boolean;
  chunkingStrategy?: ChunkingStrategy;
  chunkingStrategyExplicit?: boolean;
  enableEmbedding?: boolean;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  tokenTrueSizing?: boolean;
  chunkTokenLimit?: number;
  embeddingQueue?: QueueAdapter | null;
}

interface EnhancedFileImportServiceReturn {
  importFiles: (
    selectedFilePaths: Set<string>,
    fileTree: IFileNode[],
    fileContents: Record<string, string>
  ) => Promise<void>;
  isImporting: boolean;
  progress: EnhancedImportProgress | null;
  chunkRepository: ReturnType<typeof useFileChunkRepository>;
}

type EnhancedImportParams = Parameters<typeof runEnhancedImport<IFileNode>>[0];

function createEmbeddingConfig(
  enableEmbedding: boolean | undefined,
  embeddingModel: string | undefined,
  embeddingService: SimpleEmbeddingService | null,
  chunkRepository: ReturnType<typeof useFileChunkRepository>,
  resolveTargetEmbeddingSetId: () => string | null
): EnhancedImportParams['embedding'] {
  if (enableEmbedding === undefined) {
    return undefined;
  }

  const parsed = parseProviderModelKey(embeddingModel);
  const provider: EmbeddingProviderType | undefined = parsed?.provider;

  return {
    enabled: Boolean(enableEmbedding),
    service: embeddingService,
    chunkRepository,
    resolveTargetEmbeddingSetId,
    onResolvedTargetSetId: (id: string) => {
      setActiveEmbeddingSetId(id);
    },
    ...(embeddingModel ? { model: embeddingModel } : {}),
    ...(provider ? { provider } : {}),
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
  chunkRepository: ReturnType<typeof useFileChunkRepository>
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

export function useEnhancedFileImportService(
  options: EnhancedFileImportOptions = {}
): EnhancedFileImportServiceReturn {
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<EnhancedImportProgress | null>(null);
  const [embeddingService, setEmbeddingService] = useState<SimpleEmbeddingService | null>(null);
  const baseCallbacksRef = useRef<{
    onProgress?: (progress: ImportProgress) => void;
    onComplete?: (results: FileImportResult[]) => void;
    onError?: (error: Error) => void;
  } | null>(null);

  const repository = useFileRecordRepository();
  const chunkRepository = useFileChunkRepository();
  const db = usePGliteDatabase();

  // Feature flag to control embedding queue producer (Phase 3)
  const embedQueueEnabled = (() => {
    try {
      // Prefer explicit env; default disabled
      // Use proper type guard for Node.js environment
      if (process?.env?.['EMBED_QUEUE_ENABLED']) {
        return String(process.env['EMBED_QUEUE_ENABLED']).toLowerCase() === 'true';
      }
    } catch (_e) {
      // Silently fail in browser environments
    }
    return false;
  })();

  // Initialize embedding service if enabled
  useEffect(() => {
    if (!options.enableEmbedding || !options.embeddingModel) {
      setEmbeddingService(null);
      return;
    }

    const parsed = parseProviderModelKey(options.embeddingModel);
    if (parsed && isHostedProvider(parsed.provider)) {
      setEmbeddingService(null);
      return;
    }

    const service = new SimpleEmbeddingService();
    setEmbeddingService(service);
  }, [options.enableEmbedding, options.embeddingModel]);

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
    if (!options.embeddingQueue || !chunkRepository) {
      return null;
    }

    return createBrowserEmbeddingQueuePort({
      queue: options.embeddingQueue,
      chunkRepository,
    });
  }, [chunkRepository, options.embeddingQueue]);

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
              ...(detail.elapsedMs !== undefined ? { elapsedMs: detail.elapsedMs } : {}),
              ...(detail.errorMessage ? { errorMessage: detail.errorMessage } : {}),
            },
          },
        };

        return next;
      });
    };

    window.addEventListener('brainstrike:queue-progress', handler as EventListener);
    return () => {
      window.removeEventListener('brainstrike:queue-progress', handler as EventListener);
    };
  }, [browserQueuePort]);

  const jobQueuePort = useMemo<EmbeddingJobQueuePort | null>(() => {
    if (browserQueuePort) {
      return null;
    }
    if (!embedQueueEnabled || !db) {
      return null;
    }

    return {
      async enqueueBatch(chunks, fileRecordId, options) {
        const executor = (options?.transaction ?? db) as IDatabase;
        const queue = new JobQueue(executor);
        const expectedDimension = options?.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
        const provider = options?.provider ?? null;
        const modelKey = options?.model ?? null;
        const dimensionParameter = options?.dimensionParameter ?? null;

        for (const chunk of chunks) {
          if (!chunk.id || !chunk.contentHash) {
            logger.error('Invalid chunk data: missing required fields', {
              chunkId: chunk.id,
              hasContentHash: !!chunk.contentHash,
              fileRecordId,
            });
            continue;
          }

          const resolvedEmbeddingSetId =
            options?.targetEmbeddingSetId ?? chunk.embeddingSetId ?? null;
          const dedupeKey = `${chunk.id}:${resolvedEmbeddingSetId ?? 'none'}:${chunk.contentHash}`;
          await queue.enqueue({
            queue: 'embeddings',
            jobType: 'embed_chunk',
            payload: {
              chunkId: chunk.id,
              fileRecordId,
              embeddingSetId: resolvedEmbeddingSetId,
              expectedDimension,
              modelKey,
              provider,
              dimensionParameter,
            },
            dedupeKey,
          });
        }
      },
    } satisfies EmbeddingJobQueuePort;
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

        baseImportService.importFiles(selectedFilePaths, fileTree, fileContents).catch((error) => {
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
      fileContents: Record<string, string>
    ) => {
      setIsImporting(true);

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
        const embeddingConfig = createEmbeddingConfig(
          options.enableEmbedding,
          options.embeddingModel,
          embeddingService,
          chunkRepository,
          getActiveEmbeddingSetId
        );
        const ports = createPorts(queuePort, sqlPort);
        const progressHandlers = createProgressHandlers(setProgress, options.onProgress);

        const params: EnhancedImportParams = {
          request: { selectedFilePaths, fileTree, fileContents },
          baseImportRunner,
          chunking: createChunkingConfig(options, repository, chunkRepository),
          progressHandlers,
        };
        if (embeddingConfig) {
          params.embedding = embeddingConfig;
        }
        if (ports) {
          params.ports = ports;
        }

        const results = await runEnhancedImport<IFileNode>(params);

        options.onComplete?.(results);

        // Dispatch event to notify UI components (e.g., SearchCollectionSelector) to refresh
        // This ensures document counts and other collection-related UI updates immediately
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('brainstrike:files-imported', {
              detail: {
                results,
                activeCollectionId: getActiveEmbeddingSetId(),
                fileCount: results.length,
                chunkCount: results.reduce((sum, r) => sum + (r.chunksCreated ?? 0), 0),
              },
            })
          );
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error('Import failed'));
      } finally {
        setIsImporting(false);
      }
    },
    [baseImportRunner, chunkRepository, embeddingService, options, queuePort, repository, sqlPort]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (embeddingService) {
        embeddingService.dispose();
      }
    };
  }, [embeddingService]);

  return useMemo(
    () => ({
      importFiles,
      isImporting,
      progress,
      chunkRepository,
    }),
    [importFiles, isImporting, progress, chunkRepository]
  );
}
