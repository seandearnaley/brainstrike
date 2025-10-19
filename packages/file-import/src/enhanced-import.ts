import type {
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/utils';
import { processChunking } from './chunking';
import { processEmbeddings } from './embedding';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Enhanced');

// Cache for embedding set lookups to avoid repeated database queries
const EMBEDDING_SET_CACHE_LIMIT = 200;
const embeddingSetCache = new Map<string, { modelKey: string }>();

export interface EmbeddingJobQueuePort {
  enqueueBatch(
    chunks: FileChunk[],
    fileRecordId: string,
    options?: {
      transaction?: IDatabase | null;
      model?: string | null;
      targetEmbeddingSetId?: string | null;
    }
  ): Promise<void>;
}

export interface SqlExecutorPort {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runInTransaction?<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T>;
}

export interface BaseImportRunnerRequest<TFileNode = unknown> {
  selectedFilePaths: Set<string>;
  fileTree: TFileNode[];
  fileContents: Record<string, string>;
  onProgress: (progress: ImportProgress) => void;
}

export type BaseImportRunner<TFileNode = unknown> = (
  request: BaseImportRunnerRequest<TFileNode>
) => Promise<FileImportResult[]>;

interface ChunkingDependencies {
  repository: ReturnType<typeof import('@brainstrike/db').useFileRecordRepository> | null;
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null;
}

interface ChunkingConfiguration {
  enabled: boolean;
  deps: ChunkingDependencies;
  strategy?: ChunkingStrategy;
  strategyExplicit?: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
  useStreamingForLargeFiles?: boolean;
  streamBatchSize?: number;
  tokenTrueSizing?: boolean;
  tokenLimit?: number;
}

interface EmbeddingConfiguration {
  enabled: boolean;
  model?: string;
  service: SimpleEmbeddingService | null;
  chunkRepository: ReturnType<typeof import('@brainstrike/db').useFileChunkRepository> | null;
  resolveTargetEmbeddingSetId?: () => string | null | undefined;
}

interface ProgressHandlers {
  update: (updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null) => void;
  emit?: (progress: EnhancedImportProgress) => void;
}

interface RunEnhancedImportPorts {
  embeddingQueue?: EmbeddingJobQueuePort | null;
  sql?: SqlExecutorPort | null;
}

interface RunEnhancedImportParams<TFileNode = unknown> {
  request: {
    selectedFilePaths: Set<string>;
    fileTree: TFileNode[];
    fileContents: Record<string, string>;
  };
  baseImportRunner: BaseImportRunner<TFileNode>;
  chunking: ChunkingConfiguration;
  embedding?: EmbeddingConfiguration;
  ports?: RunEnhancedImportPorts;
  progressHandlers: ProgressHandlers;
  processChunkingImpl?: typeof processChunking;
  processEmbeddingsImpl?: typeof processEmbeddings;
}

function toEnhancedImportProgress(progress: ImportProgress): EnhancedImportProgress {
  return {
    phase: 'importing',
    total: progress.total,
    completed: progress.completed,
    current: progress.current ?? '',
    errors: progress.errors,
  };
}

async function resolveModelKeyFromTargetSet(
  targetSetId: string,
  sql: SqlExecutorPort | null | undefined
): Promise<string | undefined> {
  if (!sql) {
    return undefined;
  }

  const cachedEntry = embeddingSetCache.get(targetSetId);
  if (cachedEntry) {
    return cachedEntry.modelKey;
  }

  try {
    const result = await sql.query<{ modelKey: string }>(
      'SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1 LIMIT 1',
      [targetSetId]
    );
    const fetchedModelKey = result.rows[0]?.modelKey;
    if (!fetchedModelKey) {
      return undefined;
    }

    embeddingSetCache.set(targetSetId, { modelKey: fetchedModelKey });
    if (embeddingSetCache.size > EMBEDDING_SET_CACHE_LIMIT) {
      const [oldestKey] = embeddingSetCache.keys();
      if (oldestKey) {
        embeddingSetCache.delete(oldestKey);
      }
    }
    return fetchedModelKey;
  } catch {
    return undefined;
  }
}

async function resolveEmbeddingModel(
  config: EmbeddingConfiguration | undefined,
  ports: RunEnhancedImportPorts | undefined
): Promise<{ model?: string; targetSetId?: string }> {
  if (!config?.enabled) {
    return config?.model ? { model: config.model } : {};
  }

  const resolved: { model?: string; targetSetId?: string } = {};
  const targetSetId = config.resolveTargetEmbeddingSetId?.();
  if (targetSetId) {
    resolved.targetSetId = targetSetId;
  }

  let modelKey = config.model;

  if (!modelKey && targetSetId) {
    modelKey = await resolveModelKeyFromTargetSet(targetSetId, ports?.sql ?? null);
  }

  if (modelKey) {
    resolved.model = modelKey;
  }

  return resolved;
}

interface ChunkingOptionsConfig {
  chunking: ChunkingConfiguration;
  queuePort: EmbeddingJobQueuePort | null;
  runInTransaction: SqlExecutorPort['runInTransaction'] | undefined;
  embedding: EmbeddingConfiguration | undefined;
  embeddingModel: string | undefined;
  targetSetId: string | undefined;
  update: ProgressHandlers['update'];
  processEmbeddingsImpl: typeof processEmbeddings;
}

function buildChunkingOptions(
  config: ChunkingOptionsConfig
): Parameters<typeof processChunking>[2] {
  const {
    chunking,
    queuePort,
    runInTransaction,
    embedding,
    embeddingModel,
    targetSetId,
    update,
    processEmbeddingsImpl,
  } = config;
  const options: Parameters<typeof processChunking>[2] = {
    updateProgress: update,
    embedQueueEnabled: false,
    // Enable streaming by default for better memory management with large files
    useStreamingForLargeFiles: chunking.useStreamingForLargeFiles ?? true,
    streamBatchSize: chunking.streamBatchSize ?? 250,
  };

  const queueActive = Boolean(queuePort && embedding?.enabled && embeddingModel);
  if (queueActive) {
    options.embedQueueEnabled = true;
  }

  applyChunkingConfiguration(options, chunking);
  attachQueueOptions(options, {
    queueActive,
    queuePort,
    runInTransaction,
    embedding,
    embeddingModel,
    targetSetId,
  });
  if (embedding?.enabled !== undefined) {
    options.enableEmbedding = embedding.enabled;
  }
  if (embedding?.enabled && embedding.service) {
    options.processEmbeddings = async (chunks, result) => {
      await processEmbeddingsImpl(
        chunks,
        result,
        embedding.chunkRepository,
        embedding.service,
        embeddingModel,
        update,
        targetSetId
      );
    };
  }

  return options;
}

type QueueOptionParams = {
  readonly queueActive: boolean;
  readonly queuePort: EmbeddingJobQueuePort | null;
  readonly runInTransaction: SqlExecutorPort['runInTransaction'] | undefined;
  readonly embedding: EmbeddingConfiguration | undefined;
  readonly embeddingModel: string | undefined;
  readonly targetSetId: string | undefined;
};

function attachQueueOptions(
  options: Parameters<typeof processChunking>[2],
  params: QueueOptionParams
): void {
  const { queueActive, queuePort, runInTransaction, embedding, embeddingModel, targetSetId } =
    params;
  if (!queueActive || queuePort === null) {
    if (embedding?.enabled && !embeddingModel) {
      logger.warn('Embedding queue requested without a resolved model, skipping enqueue phase');
    }
    if (runInTransaction) {
      options.runInTransaction = runInTransaction;
    }
    return;
  }

  options.enqueueJobsForChunks = (chunks, fileRecordId) =>
    queuePort.enqueueBatch(chunks, fileRecordId, {
      model: embeddingModel ?? null,
      targetEmbeddingSetId: targetSetId ?? null,
    });

  if (runInTransaction) {
    options.runInTransaction = runInTransaction;
    options.enqueueJobsForChunksTx = (tx, chunks, fileRecordId) =>
      queuePort.enqueueBatch(chunks, fileRecordId, {
        transaction: tx,
        model: embeddingModel ?? null,
        targetEmbeddingSetId: targetSetId ?? null,
      });
  }
}

function applyChunkingConfiguration(
  options: Parameters<typeof processChunking>[2],
  chunking: ChunkingConfiguration
): void {
  if (chunking.strategy !== undefined) {
    options.chunkingStrategy = chunking.strategy;
  }
  if (chunking.strategyExplicit !== undefined) {
    options.forceStrategy = chunking.strategyExplicit;
  }
  if (chunking.chunkSize !== undefined) {
    options.chunkSize = chunking.chunkSize;
  }
  if (chunking.chunkOverlap !== undefined) {
    options.chunkOverlap = chunking.chunkOverlap;
  }
  if (chunking.streamBatchSize !== undefined) {
    options.streamBatchSize = chunking.streamBatchSize;
  }
  options.tokenTrueSizing = chunking.tokenTrueSizing ?? true;
  if (chunking.tokenLimit !== undefined) {
    options.tokenLimit = chunking.tokenLimit;
  }
}

function createCompleteProgress(
  source: EnhancedImportProgress | null,
  total: number
): EnhancedImportProgress {
  if (source) {
    const completed: EnhancedImportProgress = {
      total: source.total,
      completed: source.completed,
      errors: source.errors,
      phase: 'complete',
    };
    if (source.current !== undefined) {
      completed.current = source.current;
    }
    if (source.chunkingProgress) {
      completed.chunkingProgress = source.chunkingProgress;
    }
    if (source.embeddingProgress) {
      completed.embeddingProgress = source.embeddingProgress;
    }
    if (source.queueProgress) {
      completed.queueProgress = source.queueProgress;
    }
    return completed;
  }

  return {
    phase: 'complete',
    total,
    completed: total,
    current: '',
    errors: [],
  };
}

export async function runEnhancedImport<TFileNode = unknown>({
  request,
  baseImportRunner,
  chunking,
  embedding,
  ports,
  progressHandlers,
  processChunkingImpl = processChunking,
  processEmbeddingsImpl = processEmbeddings,
}: RunEnhancedImportParams<TFileNode>): Promise<EnhancedImportResult[]> {
  const { selectedFilePaths, fileTree, fileContents } = request;
  const emit = progressHandlers.emit;
  const update = progressHandlers.update;
  let latestProgress: EnhancedImportProgress | null = null;

  logger.info('Starting enhanced file import', {
    filesCount: selectedFilePaths.size,
    chunkingEnabled: chunking.enabled,
    embeddingEnabled: embedding?.enabled ?? false,
    embeddingModel: embedding?.model,
  });

  try {
    const baseResults = await baseImportRunner({
      selectedFilePaths,
      fileTree,
      fileContents,
      onProgress(progress) {
        const enhanced = toEnhancedImportProgress(progress);
        update((prev) => {
          const nextProgress: EnhancedImportProgress = {
            ...enhanced,
            ...(prev?.queueProgress ? { queueProgress: prev.queueProgress } : {}),
          };
          latestProgress = nextProgress;
          return nextProgress;
        });
        emit?.(enhanced);
      },
    });

    logger.info('Base import complete', {
      totalFiles: baseResults.length,
      successfulImports: baseResults.filter((r) => r.imported || r.existed).length,
      errors: baseResults.filter((r) => r.error).length,
    });

    if (!chunking.enabled) {
      logger.info('Chunking disabled, skipping chunking phase');
      const finalProgress = createCompleteProgress(latestProgress, baseResults.length);
      update((prev) => {
        const nextProgress: EnhancedImportProgress = {
          ...finalProgress,
          ...(prev?.queueProgress ? { queueProgress: prev.queueProgress } : {}),
        };
        latestProgress = nextProgress;
        return nextProgress;
      });
      emit?.(finalProgress);
      const mapped = baseResults.map<EnhancedImportResult>((result) => ({
        ...result,
        chunksCreated: 0,
      }));
      return mapped;
    }

    logger.info('Starting chunking phase', {
      chunkingStrategy: chunking.strategy,
      chunkSize: chunking.chunkSize,
      chunkOverlap: chunking.chunkOverlap,
    });

    const { model: embeddingModel, targetSetId } = await resolveEmbeddingModel(embedding, ports);
    const queuePort = ports?.embeddingQueue ?? null;
    const runInTransaction = ports?.sql?.runInTransaction;

    const chunkingOptions = buildChunkingOptions({
      chunking,
      queuePort,
      runInTransaction,
      embedding,
      embeddingModel,
      targetSetId,
      update,
      processEmbeddingsImpl,
    });

    const enhancedResults = await processChunkingImpl(baseResults, chunking.deps, chunkingOptions);

    logger.info('Enhanced import complete', {
      totalFiles: enhancedResults.length,
      totalChunks: enhancedResults.reduce((sum, r) => sum + (r.chunksCreated || 0), 0),
      filesWithErrors: enhancedResults.filter((r) => r.error).length,
    });

    return enhancedResults;
  } catch (error) {
    logger.error('Enhanced import failed catastrophically:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      filesCount: selectedFilePaths.size,
    });
    throw error;
  }
}
