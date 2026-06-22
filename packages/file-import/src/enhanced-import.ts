import type {
  ChunkingStrategy,
  FileChunk,
  FileImportResult,
  IDatabase,
  ImportProgress,
} from '@brainstrike/db';
import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/db';
import { resolveHostedProviderApiKey } from '@brainstrike/embeddings';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import {
  canonicalizeEmbeddingProviderModelKey as canonicalizeProviderModelKey,
  type EmbeddingModelDefinition,
  type EmbeddingProviderType,
  getEmbeddingProviderDefinition as getProviderDefinition,
  type IndexingEmbeddingJobQueuePort,
  isLocalProviderType,
  type EmbeddingModelConfig as ModelConfig,
  type ProviderDimensionParameter,
  parseEmbeddingProviderModelKey as parseProviderModelKey,
} from '@brainstrike/indexing-contract';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import {
  createBulkOperationContext,
  createLogger,
  generateUUID,
  LogLevel,
} from '@brainstrike/utils';
import { processChunking } from './chunking';
import { processEmbeddings } from './embedding';
import type { FileImportChunkRepository, FileImportFileRecordRepository } from './repository-ports';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';

const logger = createLogger('FileImport:Enhanced');
// Cache for embedding set lookups to avoid repeated database queries
const EMBEDDING_SET_CACHE_LIMIT = 200;
const embeddingSetCache = new Map<string, { modelKey: string }>();
const MODEL_CONFIG_CACHE_LIMIT = 200;
const modelConfigCache = new Map<
  string,
  { dimensions: number; providerId: EmbeddingProviderType }
>();

interface DbModelRow {
  capabilities: string | object;
  id: string;
  providerId: string;
}

interface ModelCapabilities {
  defaultDimension?: number;
  type?: string;
}

function isEmbeddingModelDefinition(model: unknown): model is EmbeddingModelDefinition {
  return Boolean(model) && (model as EmbeddingModelDefinition).type === 'embedding';
}

function pickHostedTargetDimension(model: EmbeddingModelDefinition): number {
  if (model.supportsStandardDimension) {
    return DEFAULT_EMBEDDING_DIMENSION;
  }

  const available = model.availableDimensions ?? [];
  if (available.includes(DEFAULT_EMBEDDING_DIMENSION)) {
    return DEFAULT_EMBEDDING_DIMENSION;
  }

  if (available.length > 0) {
    const [first] = available;
    if (typeof first === 'number') {
      return first;
    }
  }

  return model.defaultDimension ?? DEFAULT_EMBEDDING_DIMENSION;
}

function getSupportedHostedProvider(
  provider: EmbeddingProviderType
): 'openai' | 'google' | 'cohere' | 'voyage' | undefined {
  if (
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'cohere' ||
    provider === 'voyage'
  ) {
    return provider;
  }
  return;
}

function canonicalizeModelKey(
  modelKey: string,
  providerHint: EmbeddingProviderType | undefined
): { provider: EmbeddingProviderType; modelId: string; composite: string } {
  const canonical = canonicalizeProviderModelKey(modelKey, providerHint);
  if (!canonical) {
    throw new Error(`Invalid model key "${modelKey}"`);
  }
  return canonical;
}

function getModelKeyVariants(
  canonical: string,
  provider: EmbeddingProviderType,
  modelId: string
): string[] {
  const variants = new Set<string>([canonical]);
  variants.add(modelId);
  variants.add(`${provider}:${modelId}`);
  variants.add(`${provider}${canonical.includes('::') ? '' : '::'}${modelId}`);
  return Array.from(variants).filter((value) => value.trim().length > 0);
}

function cacheEmbeddingSet(targetSetId: string, modelKey: string): void {
  embeddingSetCache.set(targetSetId, { modelKey });
  if (embeddingSetCache.size > EMBEDDING_SET_CACHE_LIMIT) {
    const oldestKey = embeddingSetCache.keys().next().value;
    if (oldestKey) {
      embeddingSetCache.delete(oldestKey);
    }
  }
}

function cacheModelConfig(
  modelId: string,
  entry: { dimensions: number; providerId: EmbeddingProviderType }
): void {
  modelConfigCache.set(modelId, entry);
  if (modelConfigCache.size > MODEL_CONFIG_CACHE_LIMIT) {
    const oldestKey = modelConfigCache.keys().next().value;
    if (oldestKey) {
      modelConfigCache.delete(oldestKey);
    }
  }
}

function dispatchEmbeddingSetUpdateEvent(id: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(new CustomEvent('brainstrike:embedding-set-updated', { detail: { id } }));
  } catch {
    // ignore dispatch failures
  }
}

export type EmbeddingJobQueuePort = IndexingEmbeddingJobQueuePort<IDatabase>;

export interface AtomicChunkJobEnqueueOptions {
  readonly dimensionParameter?: ProviderDimensionParameter | null;
  readonly model?: string | null;
  readonly provider?: EmbeddingProviderType | null;
  readonly signal?: AbortSignal | null;
  readonly targetDimension?: number | null;
  readonly targetEmbeddingSetId?: string | null;
}

export interface SqlExecutorPort {
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: AtomicChunkJobEnqueueOptions
  ) => Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  runInTransaction?<T>(fn: (tx: IDatabase) => Promise<T>): Promise<T>;
}

export interface BaseImportRunnerRequest<TFileNode = unknown> {
  fileContents: Record<string, string>;
  fileTree: TFileNode[];
  onProgress: (progress: ImportProgress) => void;
  selectedFilePaths: Set<string>;
}

export type BaseImportRunner<TFileNode = unknown> = (
  request: BaseImportRunnerRequest<TFileNode>
) => Promise<FileImportResult[]>;

interface ChunkingDependencies {
  chunkRepository: FileImportChunkRepository | null;
  repository: FileImportFileRecordRepository | null;
}

interface ChunkingConfiguration {
  // Worker port for off-main-thread chunking
  chunkingWorkerPort?: import('./chunking-worker-port').ChunkingWorkerPort;
  chunkOverlap?: number;
  chunkSize?: number;
  deps: ChunkingDependencies;
  enabled: boolean;
  strategy?: ChunkingStrategy;
  strategyExplicit?: boolean;
  streamBatchSize?: number;
  tokenLimit?: number;
  tokenTrueSizing?: boolean;
  useStreamingForLargeFiles?: boolean;
}

interface EmbeddingConfiguration {
  chunkRepository: FileImportChunkRepository | null;
  enabled: boolean;
  model?: string;
  onResolvedTargetSetId?: (id: string) => void;
  provider?: EmbeddingProviderType;
  resolveTargetEmbeddingSetId?: () => string | null | undefined;
  service: SimpleEmbeddingService | null;
  targetDimension?: number;
}

type EmbeddingDistance = 'cosine' | 'l2' | 'ip';

interface ProgressHandlers {
  emit?: (progress: EnhancedImportProgress) => void;
  update: (updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null) => void;
}

interface RunEnhancedImportPorts {
  embeddingQueue?: EmbeddingJobQueuePort | null;
  sql?: SqlExecutorPort | null;
}

interface RunEnhancedImportParams<TFileNode = unknown> {
  abortSignal?: AbortSignal;
  baseImportRunner: BaseImportRunner<TFileNode>;
  chunking: ChunkingConfiguration;
  embedding?: EmbeddingConfiguration;
  ports?: RunEnhancedImportPorts;
  processChunkingImpl?: typeof processChunking;
  processEmbeddingsImpl?: typeof processEmbeddings;
  progressHandlers: ProgressHandlers;
  request: {
    selectedFilePaths: Set<string>;
    fileTree: TFileNode[];
    fileContents: Record<string, string>;
  };
}

function createAbortError(): Error {
  const error = new Error('Enhanced import was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
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
    return;
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
      return;
    }

    const canonical = canonicalizeProviderModelKey(fetchedModelKey);
    if (!canonical) {
      throw new Error(`Embedding set ${targetSetId} has invalid model key "${fetchedModelKey}".`);
    }
    cacheEmbeddingSet(targetSetId, canonical.composite);
    return canonical.composite;
  } catch (error) {
    logger.warn('Failed to resolve embedding set model key', {
      targetSetId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}

interface EnsureEmbeddingSetParams {
  dimensions: number;
  distance: EmbeddingDistance;
  modelId: string;
  modelKey: string;
  preferredId?: string | undefined;
  provider: EmbeddingProviderType;
}

async function ensureEmbeddingSet(
  sql: SqlExecutorPort | null | undefined,
  params: EnsureEmbeddingSetParams
): Promise<string | undefined> {
  if (!sql) {
    return params.preferredId;
  }

  const { modelKey, modelId, dimensions, distance, preferredId, provider } = params;
  assertValidDimensions(dimensions);
  const canonical = canonicalizeModelKey(modelKey, provider);
  const canonicalKey = canonical.composite;
  const canonicalProvider = canonical.provider;
  const canonicalModelId = canonical.modelId || modelId;

  const preferred = await resolvePreferredSet(
    sql,
    preferredId,
    dimensions,
    distance,
    canonicalKey,
    canonicalProvider
  );
  if (preferred) {
    return preferred;
  }

  const existing = await findMatchingSet(
    sql,
    canonicalKey,
    dimensions,
    distance,
    canonicalProvider,
    canonicalModelId
  );
  if (existing) {
    return existing;
  }

  return insertEmbeddingSet(sql, {
    modelKey: canonicalKey,
    modelId: canonicalModelId,
    dimensions,
    distance,
  });
}

function assertValidDimensions(dimensions: number): void {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimension ${dimensions} when ensuring embedding set.`);
  }
  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `Invalid embedding dimension ${dimensions} when ensuring embedding set. Maximum supported is ${MAX_EMBEDDING_DIMENSION}.`
    );
  }
}

async function resolvePreferredSet(
  sql: SqlExecutorPort,
  preferredId: string | undefined,
  dimensions: number,
  distance: EmbeddingDistance,
  modelKey: string,
  provider: EmbeddingProviderType
): Promise<string | undefined> {
  if (!preferredId) {
    return;
  }

  try {
    const result = await sql.query<{
      id: string;
      dimensions?: number | string;
      distance?: string;
      modelKey?: string;
    }>(
      'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1 LIMIT 1',
      [preferredId]
    );
    const row = result.rows[0];
    if (!row) {
      return;
    }

    const rowDimensions = Number(row.dimensions ?? 0);
    const rowDistance = (row.distance ?? distance) as EmbeddingDistance;
    const rowModelKey = String((row as { modelKey?: string }).modelKey ?? '');
    const canonicalRow = canonicalizeModelKey(rowModelKey, provider);
    if (
      Number.isFinite(rowDimensions) &&
      rowDimensions === dimensions &&
      rowDistance === distance &&
      canonicalRow?.composite === modelKey
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
      rowModelKey,
    });
  } catch (error) {
    logger.warn('Failed to look up preferred embedding set; creating new set', {
      preferredId,
      modelKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return;
}

async function findMatchingSet(
  sql: SqlExecutorPort,
  modelKey: string,
  dimensions: number,
  distance: EmbeddingDistance,
  provider: EmbeddingProviderType,
  modelId: string
): Promise<string | undefined> {
  const candidates = getModelKeyVariants(modelKey, provider, modelId);
  const placeholders = candidates.map((_, idx) => `$${idx + 1}`).join(', ');
  const dimensionParam = `$${candidates.length + 1}`;
  const distanceParam = `$${candidates.length + 2}`;
  const query = `
    SELECT s.id,
           s.model_key AS "modelKey",
           s.created_at AS "createdAt",
           COUNT(c.id) AS "chunkCount"
      FROM embedding_sets s
      LEFT JOIN file_chunks c ON c.embedding_set_id = s.id
     WHERE s.model_key IN (${placeholders})
       AND s.dimensions = ${dimensionParam}
       AND s.distance = ${distanceParam}
  GROUP BY s.id, s.model_key, s.created_at
  ORDER BY COUNT(c.id) DESC, s.created_at ASC
     LIMIT 1`;
  try {
    const result = await sql.query<{
      id: string;
      modelKey: string;
    }>(query, [...candidates, dimensions, distance]);
    const row = result.rows[0];
    if (!row) {
      return;
    }
    if (row.modelKey !== modelKey) {
      await sql.query('UPDATE embedding_sets SET model_key = $1 WHERE id = $2', [modelKey, row.id]);
    }
    return String(row.id);
  } catch (error) {
    logger.warn('Failed to query embedding_sets for existing entry', {
      modelKey,
      dimensions,
      distance,
      provider,
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

interface ResolvedEmbeddingModel {
  dimensionParameter?: ProviderDimensionParameter;
  modelId?: string;
  modelKey?: string;
  provider?: EmbeddingProviderType;
  targetDimension?: number;
  targetSetId: string | null;
}

function createResolvedEmbeddingModelState(
  config: EmbeddingConfiguration | undefined
): ResolvedEmbeddingModel {
  return {
    targetSetId: config?.resolveTargetEmbeddingSetId?.() ?? null,
  };
}

async function resolveEnabledEmbeddingModel(
  config: EmbeddingConfiguration,
  ports: RunEnhancedImportPorts | undefined
): Promise<ResolvedEmbeddingModel> {
  const resolved = createResolvedEmbeddingModelState(config);

  const compositeKey = await determineCompositeModelKey(
    config.model,
    config.model ? undefined : (resolved.targetSetId ?? undefined),
    ports?.sql,
    config.provider
  );

  const parsed = parseProviderModelKey(compositeKey);
  const provider: EmbeddingProviderType = parsed?.provider ?? config.provider ?? 'local';
  const modelId = parsed?.modelId ?? compositeKey;

  resolved.modelKey = compositeKey;
  resolved.modelId = modelId;
  resolved.provider = provider;

  if (config.model && resolved.targetSetId && ports?.sql) {
    const preferredRow = await ports.sql.query<{ modelKey?: string }>(
      'SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1 LIMIT 1',
      [resolved.targetSetId]
    );
    const preferredKey = preferredRow.rows[0]?.modelKey;
    if (preferredKey) {
      const canonicalPreferred =
        canonicalizeProviderModelKey(preferredKey, config.provider)?.composite ?? preferredKey;
      if (canonicalPreferred !== compositeKey) {
        resolved.targetSetId = null;
      }
    } else {
      resolved.targetSetId = null;
    }
  }

  if (isLocalProviderType(provider)) {
    await attachLocalModelMetadata(resolved, config, ports);
    return resolved;
  }

  await attachHostedModelMetadata(resolved, provider, modelId, config, ports);
  return resolved;
}

async function attachLocalModelMetadata(
  resolved: ResolvedEmbeddingModel,
  config: EmbeddingConfiguration,
  ports: RunEnhancedImportPorts | undefined
): Promise<void> {
  if (!(resolved.modelId && resolved.modelKey)) {
    return;
  }

  const modelEntry = await resolveLocalModelEntry(resolved.modelId, ports?.sql);
  assertValidDimensions(modelEntry.dimensions);
  resolved.targetDimension = resolveConfiguredTargetDimension(config) ?? modelEntry.dimensions;

  await ensureAndEmitEmbeddingSet({
    sql: ports?.sql,
    resolved,
    modelConfig: undefined,
    config,
  });
}

async function attachHostedModelMetadata(
  resolved: ResolvedEmbeddingModel,
  provider: EmbeddingProviderType,
  modelId: string,
  config: EmbeddingConfiguration,
  ports: RunEnhancedImportPorts | undefined
): Promise<void> {
  const supported = getSupportedHostedProvider(provider);
  if (!supported) {
    return;
  }

  const definition = getProviderDefinition(supported);
  const modelDefinition = definition.models.find(
    (candidate: EmbeddingModelDefinition) => candidate.id === modelId
  );

  if (modelDefinition && isEmbeddingModelDefinition(modelDefinition)) {
    resolved.targetDimension = pickHostedTargetDimension(modelDefinition);
    if (modelDefinition.supportsCustomDimensions && modelDefinition.dimensionParameter) {
      resolved.dimensionParameter = modelDefinition.dimensionParameter;
    }
  } else {
    resolved.targetDimension = DEFAULT_EMBEDDING_DIMENSION;
  }
  resolved.targetDimension = resolveConfiguredTargetDimension(config) ?? resolved.targetDimension;

  await ensureHostedApiKey(supported);
  await ensureAndEmitEmbeddingSet({
    sql: ports?.sql,
    resolved,
    modelConfig: undefined,
    config,
  });
}

function resolveConfiguredTargetDimension(config: EmbeddingConfiguration): number | undefined {
  if (config.targetDimension === undefined) {
    return;
  }
  assertValidDimensions(config.targetDimension);
  return config.targetDimension;
}

async function ensureHostedApiKey(
  provider: 'openai' | 'google' | 'cohere' | 'voyage'
): Promise<void> {
  const apiKey = await resolveHostedProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`Hosted provider "${provider}" requires an API key before running embeddings.`);
  }
}

async function resolveEmbeddingModel(
  config: EmbeddingConfiguration | undefined,
  ports: RunEnhancedImportPorts | undefined
): Promise<ResolvedEmbeddingModel> {
  if (!config) {
    return { targetSetId: null };
  }

  if (!config.enabled) {
    // Even when embeddings are disabled, chunks should be associated with the active collection
    // This allows:
    // 1. Document counts to update correctly in the UI
    // 2. Users to backfill embeddings later via the Backfill button
    // 3. Proper collection management and visibility
    const activeSetId = config.resolveTargetEmbeddingSetId?.() ?? null;
    logger.debug('Embeddings disabled; resolved target embedding set', {
      activeSetId,
    });
    return { targetSetId: activeSetId };
  }

  return resolveEnabledEmbeddingModel(config, ports);
}

async function determineCompositeModelKey(
  explicitModel: string | undefined,
  targetSetId: string | undefined,
  sql: SqlExecutorPort | null | undefined,
  providerHint: EmbeddingProviderType | undefined
): Promise<string> {
  if (explicitModel) {
    const canonical = canonicalizeProviderModelKey(explicitModel, providerHint);
    if (!canonical) {
      throw new Error(`Invalid embedding model key "${explicitModel}".`);
    }
    return canonical.composite;
  }
  if (targetSetId) {
    const key = await resolveModelKeyFromTargetSet(targetSetId, sql ?? null);
    if (!key) {
      throw new Error(`Unable to resolve embedding model for set "${targetSetId}".`);
    }
    return key;
  }
  throw new Error('Embedding is enabled but no model key or target set was provided.');
}

async function ensureAndEmitEmbeddingSet(params: {
  sql: SqlExecutorPort | null | undefined;
  resolved: ResolvedEmbeddingModel;
  modelConfig: ModelConfig | undefined;
  config: EmbeddingConfiguration;
}): Promise<void> {
  const { sql, resolved, modelConfig, config } = params;
  if (!(resolved.modelKey && resolved.targetDimension)) {
    return;
  }

  // Only ensure/create embedding set if we have a model and dimensions (embeddings enabled)
  // Chunks can still be created with embedding_set_id even without this
  if (!resolved.targetSetId) {
    return;
  }

  const ensuredSetId = await ensureEmbeddingSet(sql, {
    modelKey: resolved.modelKey,
    modelId: modelConfig?.id ?? resolved.modelId ?? resolved.modelKey,
    dimensions: resolved.targetDimension,
    distance: 'cosine',
    preferredId: resolved.targetSetId ?? undefined,
    provider: resolved.provider ?? 'local',
  });

  const finalSetId = ensuredSetId ?? resolved.targetSetId ?? null;
  if (!finalSetId) {
    return;
  }

  resolved.targetSetId = finalSetId;
  cacheEmbeddingSet(finalSetId, resolved.modelKey);
  config.onResolvedTargetSetId?.(finalSetId);
  dispatchEmbeddingSetUpdateEvent(finalSetId);
}

async function resolveLocalModelEntry(
  modelId: string,
  sql: SqlExecutorPort | null | undefined
): Promise<{ dimensions: number; providerId: EmbeddingProviderType }> {
  if (!sql) {
    throw new Error('Database access is required to resolve local embedding models.');
  }

  const cached = modelConfigCache.get(modelId);
  if (cached) {
    return cached;
  }

  const result = await sql.query<DbModelRow>(
    'SELECT id, provider_id AS "providerId", capabilities FROM models WHERE id = $1 LIMIT 1',
    [modelId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Embedding model not found in registry: ${modelId}.`);
  }

  const providerId = row.providerId as EmbeddingProviderType;
  if (!isLocalProviderType(providerId)) {
    throw new Error(`Model "${modelId}" is not a local embedding model.`);
  }

  const capabilities = parseModelCapabilities(row.capabilities, modelId);
  if (capabilities.type !== 'embedding') {
    throw new Error(`Model "${modelId}" is not an embedding model.`);
  }

  const dimensions = Number(capabilities.defaultDimension);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Model "${modelId}" has invalid dimensions in registry.`);
  }

  const entry = { dimensions, providerId };
  cacheModelConfig(modelId, entry);
  return entry;
}

function parseModelCapabilities(value: unknown, modelId: string): ModelCapabilities {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(
        `Model "${modelId}" has invalid capabilities JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Model "${modelId}" has invalid capabilities payload.`);
  }

  return parsed as ModelCapabilities;
}

interface ChunkingOptionsConfig {
  chunking: ChunkingConfiguration;
  dimensionParameter?: ProviderDimensionParameter;
  embedding: EmbeddingConfiguration | undefined;
  embeddingModelId?: string;
  embeddingModelKey?: string;
  insertChunksAndEnqueueEmbeddingJobs:
    | SqlExecutorPort['insertChunksAndEnqueueEmbeddingJobs']
    | undefined;
  processEmbeddingsImpl: typeof processEmbeddings;
  provider?: EmbeddingProviderType;
  queuePort: EmbeddingJobQueuePort | null;
  runInTransaction: SqlExecutorPort['runInTransaction'] | undefined;
  targetDimension?: number;
  targetSetId: string | undefined;
  update: ProgressHandlers['update'];
}

function buildChunkingOptions(
  config: ChunkingOptionsConfig
): Parameters<typeof processChunking>[2] {
  const {
    chunking,
    queuePort,
    runInTransaction,
    embedding,
    embeddingModelId,
    embeddingModelKey,
    targetSetId,
    provider,
    targetDimension,
    dimensionParameter,
    insertChunksAndEnqueueEmbeddingJobs,
    update,
    processEmbeddingsImpl,
  } = config;
  const options: Parameters<typeof processChunking>[2] = {
    updateProgress: update,
    embedQueueEnabled: false,
    // Enable streaming by default for better memory management with large files
    useStreamingForLargeFiles: chunking.useStreamingForLargeFiles ?? true,
    streamBatchSize: chunking.streamBatchSize ?? 250,
    ...(targetSetId ? { targetEmbeddingSetId: targetSetId } : {}),
  };

  logger.debug('Chunking options target set resolved', {
    targetEmbeddingSetId: options.targetEmbeddingSetId,
    targetSetId,
  });

  const queueActive = Boolean(queuePort && embedding?.enabled && embeddingModelKey);
  if (queueActive) {
    options.embedQueueEnabled = true;
  }

  applyChunkingConfiguration(options, chunking);
  const queueParams: QueueOptionParams = {
    queueActive,
    queuePort,
    runInTransaction,
    insertChunksAndEnqueueEmbeddingJobs,
    embedding,
    targetSetId,
    ...(embeddingModelId ? { embeddingModelId } : {}),
    ...(embeddingModelKey ? { embeddingModelKey } : {}),
    ...(provider ? { provider } : {}),
    ...(targetDimension === undefined ? {} : { targetDimension }),
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
        embeddingModelId,
        update,
        targetSetId
      );
    };
  }

  return options;
}

interface QueueOptionParams {
  readonly dimensionParameter?: ProviderDimensionParameter;
  readonly embedding: EmbeddingConfiguration | undefined;
  readonly embeddingModelKey?: string;
  readonly insertChunksAndEnqueueEmbeddingJobs:
    | SqlExecutorPort['insertChunksAndEnqueueEmbeddingJobs']
    | undefined;
  readonly provider?: EmbeddingProviderType;
  readonly queueActive: boolean;
  readonly queuePort: EmbeddingJobQueuePort | null;
  readonly runInTransaction: SqlExecutorPort['runInTransaction'] | undefined;
  readonly targetDimension?: number;
  readonly targetSetId: string | undefined;
}

function attachQueueOptions(
  options: Parameters<typeof processChunking>[2],
  params: QueueOptionParams
): void {
  const {
    queueActive,
    queuePort,
    runInTransaction,
    insertChunksAndEnqueueEmbeddingJobs,
    embedding,
    embeddingModelKey,
    targetSetId,
    provider,
    targetDimension,
    dimensionParameter,
  } = params;
  if (!queueActive || queuePort === null) {
    if (embedding?.enabled && !embeddingModelKey) {
      logger.warn('Embedding queue requested without a resolved model, skipping enqueue phase');
    }
    if (runInTransaction) {
      options.runInTransaction = runInTransaction;
    }
    return;
  }

  if (insertChunksAndEnqueueEmbeddingJobs) {
    options.insertChunksAndEnqueueEmbeddingJobs = (chunks, fileRecordId) =>
      insertChunksAndEnqueueEmbeddingJobs(chunks, fileRecordId, {
        signal: options.abortSignal ?? null,
        model: embeddingModelKey ?? null,
        targetEmbeddingSetId: targetSetId ?? null,
        provider: provider ?? null,
        targetDimension: targetDimension ?? null,
        dimensionParameter: dimensionParameter ?? null,
      });
    return;
  }

  options.enqueueJobsForChunks = (chunks, fileRecordId) =>
    queuePort.enqueueBatch(chunks, fileRecordId, {
      signal: options.abortSignal ?? null,
      model: embeddingModelKey ?? null,
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
        signal: options.abortSignal ?? null,
        model: embeddingModelKey ?? null,
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
  // Pass worker port for off-main-thread chunking
  if (chunking.chunkingWorkerPort !== undefined) {
    options.chunkingWorkerPort = chunking.chunkingWorkerPort;
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
  abortSignal,
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
    throwIfAborted(abortSignal);
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
    throwIfAborted(abortSignal);

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

    const { modelId, modelKey, targetSetId, provider, targetDimension, dimensionParameter } =
      await resolveEmbeddingModel(embedding, ports);

    logger.debug('Resolved embedding model for enhanced import', {
      modelId,
      modelKey,
      targetSetId,
      provider,
      targetDimension,
    });

    const queuePort = ports?.embeddingQueue ?? null;
    const runInTransaction = ports?.sql?.runInTransaction;
    const insertChunksAndEnqueueEmbeddingJobs = ports?.sql?.insertChunksAndEnqueueEmbeddingJobs;

    const chunkingConfig: ChunkingOptionsConfig = {
      chunking,
      queuePort,
      insertChunksAndEnqueueEmbeddingJobs,
      runInTransaction,
      embedding,
      targetSetId: targetSetId ?? undefined,
      update,
      processEmbeddingsImpl,
      ...(modelId ? { embeddingModelId: modelId } : {}),
      ...(modelKey ? { embeddingModelKey: modelKey } : {}),
      ...(provider ? { provider } : {}),
      ...(targetDimension === undefined ? {} : { targetDimension }),
      ...(dimensionParameter ? { dimensionParameter } : {}),
    };

    logger.debug('Chunking config target set resolved', {
      targetSetId: chunkingConfig.targetSetId,
    });

    const chunkingOptions = buildChunkingOptions(chunkingConfig);
    if (abortSignal) {
      chunkingOptions.abortSignal = abortSignal;
    }

    logger.debug('Chunking options target embedding set resolved', {
      targetEmbeddingSetId: chunkingOptions.targetEmbeddingSetId,
    });

    // Enter bulk operation mode to reduce logging overhead during file processing
    // This raises log level to WARN and pauses LogBuffer to prevent memory accumulation
    const bulkContext = createBulkOperationContext({ level: LogLevel.WARN });
    bulkContext.enter();

    let enhancedResults: EnhancedImportResult[];
    try {
      throwIfAborted(abortSignal);
      enhancedResults = await processChunkingImpl(baseResults, chunking.deps, chunkingOptions);
    } finally {
      // Always exit bulk mode, even on error
      bulkContext.exit();
    }

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
