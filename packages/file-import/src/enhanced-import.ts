import type {
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { ProviderDimensionParameter } from '@brainstrike/queue';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { processChunking } from './chunking';
import { processEmbeddings } from './embedding';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Enhanced');
const STANDARD_EMBEDDING_DIMENSION = 768;

// Cache for embedding set lookups to avoid repeated database queries
const EMBEDDING_SET_CACHE_LIMIT = 200;
const embeddingSetCache = new Map<string, { modelKey: string }>();

function cacheEmbeddingSet(targetSetId: string, modelKey: string): void {
  embeddingSetCache.set(targetSetId, { modelKey });
  if (embeddingSetCache.size > EMBEDDING_SET_CACHE_LIMIT) {
    const oldestKey = embeddingSetCache.keys().next().value;
    if (oldestKey) {
      embeddingSetCache.delete(oldestKey);
    }
  }
}

function dispatchEmbeddingSetUpdateEvent(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('brainstrike:embedding-set-updated', { detail: { id } }));
  } catch {
    // ignore dispatch failures
  }
}

export interface EmbeddingJobQueuePort {
  enqueueBatch(
    chunks: FileChunk[],
    fileRecordId: string,
    options?: {
      transaction?: IDatabase | null;
      model?: string | null;
      targetEmbeddingSetId?: string | null;
      provider?: string | null;
      targetDimension?: number | null;
      dimensionParameter?: ProviderDimensionParameter | null;
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
  onResolvedTargetSetId?: (id: string) => void;
}

type EmbeddingDistance = 'cosine' | 'l2' | 'ip';

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

    cacheEmbeddingSet(targetSetId, fetchedModelKey);
    return fetchedModelKey;
  } catch {
    return undefined;
  }
}

interface EnsureEmbeddingSetParams {
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: EmbeddingDistance;
  preferredId?: string | undefined;
}

async function ensureEmbeddingSet(
  sql: SqlExecutorPort | null | undefined,
  params: EnsureEmbeddingSetParams
): Promise<string | undefined> {
  if (!sql) {
    return params.preferredId;
  }

  const { modelKey, modelId, dimensions, distance, preferredId } = params;
  assertValidDimensions(dimensions);

  const preferred = await resolvePreferredSet(sql, preferredId, dimensions, distance, modelKey);
  if (preferred) {
    return preferred;
  }

  const existing = await findMatchingSet(sql, modelKey, dimensions, distance);
  if (existing) {
    return existing;
  }

  return insertEmbeddingSet(sql, { modelKey, modelId, dimensions, distance });
}

function assertValidDimensions(dimensions: number): void {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimension ${dimensions} when ensuring embedding set.`);
  }
}

async function resolvePreferredSet(
  sql: SqlExecutorPort,
  preferredId: string | undefined,
  dimensions: number,
  distance: EmbeddingDistance,
  modelKey: string
): Promise<string | undefined> {
  if (!preferredId) {
    return undefined;
  }

  try {
    const result = await sql.query<{
      id: string;
      dimensions?: number | string;
      distance?: string;
    }>('SELECT id, dimensions, distance FROM embedding_sets WHERE id = $1 LIMIT 1', [preferredId]);
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    const rowDimensions = Number(row.dimensions ?? 0);
    const rowDistance = (row.distance ?? distance) as EmbeddingDistance;
    if (
      Number.isFinite(rowDimensions) &&
      rowDimensions === dimensions &&
      rowDistance === distance
    ) {
      return String(row.id);
    }

    logger.warn('Embedding set preference mismatch; creating new set for model', {
      preferredId,
      modelKey,
      rowDimensions,
      expectedDimensions: dimensions,
      rowDistance,
      expectedDistance: distance,
    });
  } catch (error) {
    logger.warn('Failed to look up preferred embedding set; creating new set', {
      preferredId,
      modelKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

async function findMatchingSet(
  sql: SqlExecutorPort,
  modelKey: string,
  dimensions: number,
  distance: EmbeddingDistance
): Promise<string | undefined> {
  try {
    const composite = await sql.query<{ id: string }>(
      'SELECT id FROM embedding_sets WHERE model_key = $1 AND dimensions = $2 AND distance = $3 LIMIT 1',
      [modelKey, dimensions, distance]
    );
    const existingId = composite.rows[0]?.id;
    return existingId ? String(existingId) : undefined;
  } catch (error) {
    logger.warn('Failed to query embedding_sets for existing entry', {
      modelKey,
      dimensions,
      distance,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function insertEmbeddingSet(
  sql: SqlExecutorPort,
  params: { modelKey: string; modelId: string; dimensions: number; distance: EmbeddingDistance }
): Promise<string> {
  const newId = generateUUID();
  const { modelKey, modelId, dimensions, distance } = params;
  const insert = await sql.query<{ id: string }>(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (model_key, dimensions, distance)
       DO UPDATE SET model_id = EXCLUDED.model_id
       RETURNING id`,
    [newId, modelKey, modelId, dimensions, distance, new Date().toISOString()]
  );
  const insertedId = insert.rows[0]?.id;
  return insertedId ? String(insertedId) : newId;
}

async function resolveEmbeddingModel(
  config: EmbeddingConfiguration | undefined,
  ports: RunEnhancedImportPorts | undefined
): Promise<{
  model?: string;
  targetSetId?: string;
  provider?: string;
  targetDimension?: number;
  dimensionParameter?: ProviderDimensionParameter;
}> {
  if (!config?.enabled) {
    return config?.model
      ? { model: config.model, targetDimension: STANDARD_EMBEDDING_DIMENSION }
      : {};
  }

  const embeddingConfig = config as EmbeddingConfiguration;

  const resolved: {
    model?: string;
    targetSetId?: string;
    provider?: string;
    targetDimension?: number;
    dimensionParameter?: ProviderDimensionParameter;
  } = {};

  const initialSetId = embeddingConfig.resolveTargetEmbeddingSetId?.();
  if (initialSetId) {
    resolved.targetSetId = initialSetId;
  }

  const modelKey = await determineModelKey(embeddingConfig.model, resolved.targetSetId, ports?.sql);
  if (!modelKey) {
    return resolved;
  }

  resolved.model = modelKey;
  const modelConfig = SimpleEmbeddingService.getModelConfig(modelKey);
  resolved.targetDimension = determineTargetDimension(modelConfig);

  await ensureAndEmitEmbeddingSet({
    sql: ports?.sql,
    resolved,
    modelConfig,
    config: embeddingConfig,
  });

  return resolved;
}

async function determineModelKey(
  explicitModel: string | undefined,
  targetSetId: string | undefined,
  sql: SqlExecutorPort | null | undefined
): Promise<string | undefined> {
  if (explicitModel) {
    return explicitModel;
  }
  if (targetSetId) {
    return resolveModelKeyFromTargetSet(targetSetId, sql ?? null);
  }
  return undefined;
}

function determineTargetDimension(
  modelConfig: ReturnType<typeof SimpleEmbeddingService.getModelConfig> | undefined
): number {
  const dim = modelConfig?.dimensions;
  return Number.isFinite(dim) && dim !== undefined ? Number(dim) : STANDARD_EMBEDDING_DIMENSION;
}

async function ensureAndEmitEmbeddingSet(params: {
  sql: SqlExecutorPort | null | undefined;
  resolved: {
    model?: string;
    targetSetId?: string;
    targetDimension?: number;
  };
  modelConfig: ReturnType<typeof SimpleEmbeddingService.getModelConfig> | undefined;
  config: EmbeddingConfiguration;
}): Promise<void> {
  const { sql, resolved, modelConfig, config } = params;
  if (!resolved.model || !resolved.targetDimension) {
    return;
  }

  const ensuredSetId = await ensureEmbeddingSet(sql, {
    modelKey: resolved.model,
    modelId: modelConfig?.id ?? resolved.model,
    dimensions: resolved.targetDimension,
    distance: 'cosine',
    preferredId: resolved.targetSetId,
  });

  const finalSetId = ensuredSetId ?? resolved.targetSetId;
  if (!finalSetId) {
    return;
  }

  resolved.targetSetId = finalSetId;
  cacheEmbeddingSet(finalSetId, resolved.model);
  config.onResolvedTargetSetId?.(finalSetId);
  dispatchEmbeddingSetUpdateEvent(finalSetId);
}

interface ChunkingOptionsConfig {
  chunking: ChunkingConfiguration;
  queuePort: EmbeddingJobQueuePort | null;
  runInTransaction: SqlExecutorPort['runInTransaction'] | undefined;
  embedding: EmbeddingConfiguration | undefined;
  embeddingModel: string | undefined;
  targetSetId: string | undefined;
  provider?: string;
  targetDimension?: number;
  dimensionParameter?: ProviderDimensionParameter;
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
    provider,
    targetDimension,
    dimensionParameter,
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
  const queueParams: QueueOptionParams = {
    queueActive,
    queuePort,
    runInTransaction,
    embedding,
    embeddingModel,
    targetSetId,
    ...(provider ? { provider } : {}),
    ...(targetDimension !== undefined ? { targetDimension } : {}),
    ...(dimensionParameter ? { dimensionParameter } : {}),
  };
  attachQueueOptions(options, queueParams);
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
  readonly provider?: string;
  readonly targetDimension?: number;
  readonly dimensionParameter?: ProviderDimensionParameter;
};

function attachQueueOptions(
  options: Parameters<typeof processChunking>[2],
  params: QueueOptionParams
): void {
  const {
    queueActive,
    queuePort,
    runInTransaction,
    embedding,
    embeddingModel,
    targetSetId,
    provider,
    targetDimension,
    dimensionParameter,
  } = params;
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
      provider: provider ?? null,
      targetDimension: targetDimension ?? null,
      dimensionParameter: dimensionParameter ?? null,
    });

  if (runInTransaction) {
    options.runInTransaction = runInTransaction;
    options.enqueueJobsForChunksTx = (tx, chunks, fileRecordId) =>
      queuePort.enqueueBatch(chunks, fileRecordId, {
        transaction: tx,
        model: embeddingModel ?? null,
        targetEmbeddingSetId: targetSetId ?? null,
        provider: provider ?? null,
        targetDimension: targetDimension ?? null,
        dimensionParameter: dimensionParameter ?? null,
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

    const {
      model: embeddingModel,
      targetSetId,
      provider,
      targetDimension,
      dimensionParameter,
    } = await resolveEmbeddingModel(embedding, ports);
    const queuePort = ports?.embeddingQueue ?? null;
    const runInTransaction = ports?.sql?.runInTransaction;

    const chunkingConfig: ChunkingOptionsConfig = {
      chunking,
      queuePort,
      runInTransaction,
      embedding,
      embeddingModel,
      targetSetId,
      update,
      processEmbeddingsImpl,
      ...(provider ? { provider } : {}),
      ...(targetDimension !== undefined ? { targetDimension } : {}),
      ...(dimensionParameter ? { dimensionParameter } : {}),
    };
    const chunkingOptions = buildChunkingOptions(chunkingConfig);

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
