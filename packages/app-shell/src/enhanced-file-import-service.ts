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
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type {
  BaseImportRunner,
  EmbeddingJobQueuePort,
  EnhancedImportProgress,
  EnhancedImportResult,
  SqlExecutorPort,
} from '@brainstrike/file-import';
import { runEnhancedImport } from '@brainstrike/file-import';
import type { IFileNode } from '@brainstrike/types';
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
import { getActiveEmbeddingSetId } from './vector-preferences';

const logger = createLogger('AppShell:EnhancedFileImport');

// Extended progress interface for chunking and embedding
interface EnhancedFileImportOptions {
  onProgress?: (progress: EnhancedImportProgress) => void;
  onComplete?: (results: EnhancedImportResult[]) => void;
  onError?: (error: Error) => void;
  enableChunking?: boolean;
  chunkingStrategy?: ChunkingStrategy;
  enableEmbedding?: boolean;
  embeddingModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
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

  return {
    enabled: Boolean(enableEmbedding),
    service: embeddingService,
    chunkRepository,
    resolveTargetEmbeddingSetId,
    ...(embeddingModel ? { model: embeddingModel } : {}),
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
  if (options.chunkSize !== undefined) {
    config.chunkSize = options.chunkSize;
  }
  if (options.chunkOverlap !== undefined) {
    config.chunkOverlap = options.chunkOverlap;
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
    if (options.enableEmbedding && options.embeddingModel) {
      const service = new SimpleEmbeddingService();
      setEmbeddingService(service);
    }
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

  const queuePort = useMemo<EmbeddingJobQueuePort | null>(() => {
    if (!embedQueueEnabled || !db) {
      return null;
    }

    return {
      async enqueueBatch(chunks, fileRecordId, options) {
        const executor = (options?.transaction ?? db) as IDatabase;
        const queue = new JobQueue(executor);

        // Validate chunks before enqueueing
        for (const chunk of chunks) {
          if (!chunk.id || !chunk.contentHash) {
            logger.error('Invalid chunk data: missing required fields', {
              chunkId: chunk.id,
              hasContentHash: !!chunk.contentHash,
              fileRecordId,
            });
            continue; // Skip invalid chunks
          }

          const dedupeKey = `${chunk.id}:${chunk.embeddingSetId ?? 'none'}:${chunk.contentHash}`;
          await queue.enqueue({
            queue: 'embeddings',
            jobType: 'embed_chunk',
            payload: {
              chunkId: chunk.id,
              fileRecordId,
              embeddingSetId: chunk.embeddingSetId ?? null,
            },
            dedupeKey,
          });
        }
      },
    } satisfies EmbeddingJobQueuePort;
  }, [db, embedQueueEnabled]);

  const sqlPort = useMemo<SqlExecutorPort | null>(() => {
    if (!db) {
      return null;
    }

    // Check if database supports transactions (PGlite does, Electron IPC wrapper doesn't)
    const supportsTransactions = typeof db.transaction === 'function';

    return {
      query: (sql, params) => db.query(sql, params),
      // Only provide runInTransaction if the database supports it
      ...(supportsTransactions && {
        runInTransaction: (fn) => db.transaction((tx) => fn(tx as IDatabase)),
      }),
    } satisfies SqlExecutorPort;
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
