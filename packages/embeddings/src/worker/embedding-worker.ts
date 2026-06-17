import type { IDatabase, Job } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import { parsePositiveIntegerConfig } from '@brainstrike/platform-utils';
import { createLogger, generateUUID } from '@brainstrike/utils';
import { SimpleEmbeddingService } from '../bge-m3-service';
import type {
  EmbeddingProviderError,
  EmbeddingProviderType,
  LocalProviderType,
} from '../provider-types';
import { isLocalProviderType } from '../provider-types';
import type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStreamBatch,
  EmbeddingWorkerRuntimeMetadata,
  ModelConfig,
} from '../types';
import { EmbeddingCacheMaintenanceController } from './embedding-cache-maintenance';
import type { EmbeddingCacheInterface } from './embedding-cache-types';
import { getModelConfigFromDb } from './embedding-model-config';
import {
  buildHostedProviderConfig,
  createHostedProviderInstance,
  ensureLocalRuntime,
  ensureModelDimension,
  formatHostedEmbedError,
  initializeEmbeddingService,
  isElectronMainProcess,
  readBooleanEnv,
  resolveWorkerModel,
  type SupportedHostedProvider,
  shouldStartWorker,
  toSupportedHostedProvider,
  validateHostedEmbeddingDimensions,
  WorkerRateLimitError,
} from './embedding-provider-runtime';
import { createEmbeddingStatsRefreshController } from './embedding-stats-refresh-controller';
import {
  filterCacheMisses,
  lookupCacheHits,
  reconstructResults,
  storeToCacheAsync,
} from './embedding-worker-cache-io';
import { type LoadedChunkItem, loadAndFilterChunks } from './embedding-worker-chunk-filter';
import {
  assertVectorEmbeddingColumn,
  resolveEmbeddingSetDimension,
  resolveIdType,
  updateChunkEmbeddingBatch,
} from './embedding-worker-db-io';
import { classifyFailure, JobProcessingError } from './embedding-worker-failures';
import {
  assertEmbedChunkJob,
  type EmbedChunkPayload,
  type EmbeddingJobModel,
  resolveJobModel,
  resolveTargetSetId,
} from './embedding-worker-job-payload';
import {
  CLAIM_SIZE_RESOLVER_RETRY_BACKOFF_MS,
  DEFAULT_CLAIM_BATCH_SIZE,
  resolveIdlePollBackoffOptions,
  resolvePositiveIntegerOption,
  shouldLogIdleBackoff,
} from './embedding-worker-scheduler';

export type { CachedEmbedding, EmbeddingCacheInterface } from './embedding-cache-types';
export { clearModelConfigCache, invalidateModelConfigCache } from './embedding-model-config';
export type {
  EmbeddingStatsRefreshController,
  EmbeddingStatsRefreshControllerOptions,
  StatsRefreshReason,
} from './embedding-stats-refresh-controller';
export { createEmbeddingStatsRefreshController } from './embedding-stats-refresh-controller';

const workerLogger = createLogger('EmbeddingWorker');

type Distance = 'cosine' | 'l2' | 'ip';

export interface EmbeddingWorkerOptions {
  cacheDir?: string;
  claimBatchSize?: number;
  concurrency?: number;
  db: IDatabase;
  device?: 'webgpu' | 'wasm';
  distance?: Distance;
  embeddingCache?: EmbeddingCacheInterface;
  enable?: boolean;
  heartbeatIntervalMs?: number;
  idlePollInitialMs?: number;
  idlePollMaxMs?: number;
  initializeLocalModelOnStart?: boolean;
  interBatchDelayMs?: number;
  leaseMs?: number;
  log?: (msg: string, meta?: unknown) => void;
  metricsIntervalMs?: number;
  modelKey?: string | undefined;
  now?: () => number;
  onDownloadProgress?: (modelId: string, progress: number) => void;
  onFatalError?: (error: Error) => void;
  onRuntimeMetadataChange?: (metadata: EmbeddingWorkerRuntimeMetadata) => void;
  onWorkerActivityChange?: (active: boolean) => void;
  queue?: string;
  reinitEveryN?: number;
  resolveClaimBatchSize?: () => number | null | Promise<number | null>;
  service?: EmbeddingService;
  statsRefreshCompletedChunkThreshold?: number;
  statsRefreshMinIntervalMs?: number;
  /**
   * When true, a fatal local-model initialization/execution error stops the
   * worker loop immediately instead of continuing to claim and fail later jobs.
   * This is intended for desktop hidden-host mode to avoid renderer churn.
   */
  stopOnFatalLocalError?: boolean;
  streamingWorkerUrl?: string;
  waitForBackgroundPermit?: (options: { readonly label: string }) => Promise<void>;
  workerId?: string;
}

export interface EmbeddingWorkerController {
  stop: () => Promise<void>;
}

const DEFAULT_STATS_REFRESH_MIN_INTERVAL_MS = 5000;
const DEFAULT_STATS_REFRESH_COMPLETED_CHUNK_THRESHOLD = 512;
const EMBED_REINIT_EVERY_ENV = 'EMBED_REINIT_EVERY';
const WORKER_METRICS_INTERVAL_MS_ENV = 'WORKER_METRICS_INTERVAL_MS';

type StreamingEmbeddingService = EmbeddingService & {
  generateEmbeddingsStream: (
    texts: string[],
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void
  ) => Promise<unknown>;
};

class LocalEmbeddingStreamCallbackError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(message);
    this.name = 'LocalEmbeddingStreamCallbackError';
    this.originalError = error;
  }
}

function readProcessEnvValue(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

function resolveOptionalPositiveIntegerRuntimeConfig(
  name: string,
  rawValue: number | string | null | undefined
): number {
  if (rawValue === undefined || rawValue === null) {
    return 0;
  }
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    return 0;
  }
  if (rawValue === 0 || (typeof rawValue === 'string' && rawValue.trim() === '0')) {
    return 0;
  }
  return parsePositiveIntegerConfig({ name, rawValue });
}

function resolveReinitEveryN(configuredValue: number | undefined): number {
  if (configuredValue === 0) {
    return 0;
  }
  if (configuredValue !== undefined) {
    return parsePositiveIntegerConfig({
      name: 'reinitEveryN',
      rawValue: configuredValue,
    });
  }
  return resolveOptionalPositiveIntegerRuntimeConfig(
    EMBED_REINIT_EVERY_ENV,
    readProcessEnvValue(EMBED_REINIT_EVERY_ENV)
  );
}

function resolveMetricsIntervalMs(configuredValue: number | undefined): number {
  if (configuredValue !== undefined) {
    return parsePositiveIntegerConfig({
      name: 'metricsIntervalMs',
      rawValue: configuredValue,
    });
  }
  return parsePositiveIntegerConfig({
    defaultValue: 30_000,
    name: WORKER_METRICS_INTERVAL_MS_ENV,
    rawValue: readProcessEnvValue(WORKER_METRICS_INTERVAL_MS_ENV),
  });
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in the renderer embedding worker.');
  }

  try {
    const data = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (error) {
    throw new Error(
      `Web Crypto SHA-256 failed in the renderer embedding worker: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  workerLogger.info('startEmbeddingWorker: START', {
    hasDb: !!options.db,
    modelKey: options.modelKey,
    claimBatchSize: options.claimBatchSize,
    concurrency: options.concurrency,
    device: options.device,
    interBatchDelayMs: options.interBatchDelayMs,
  });

  const log =
    options.log ||
    ((message: string, meta?: unknown) => {
      workerLogger.debug(message, meta);
    });
  let activeBatchCount = 0;
  let lastReportedActive = false;

  const reportWorkerActivity = (active: boolean) => {
    if (lastReportedActive === active) {
      return;
    }
    lastReportedActive = active;
    options.onWorkerActivityChange?.(active);
  };

  const beginActiveBatch = () => {
    activeBatchCount += 1;
    reportWorkerActivity(activeBatchCount > 0);
  };

  const endActiveBatch = () => {
    activeBatchCount = Math.max(0, activeBatchCount - 1);
    reportWorkerActivity(activeBatchCount > 0);
  };

  // Check if worker is disabled BEFORE resolving model to avoid errors in tests
  if (!shouldStartWorker(options, log)) {
    workerLogger.info('startEmbeddingWorker: worker disabled, returning early');
    return { stop: async () => {} };
  }

  const queueName = options.queue ?? 'embeddings';
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
  const concurrency = resolvePositiveIntegerOption(options.concurrency, 1, 'concurrency');
  const interBatchDelayMs = resolvePositiveIntegerOption(
    options.interBatchDelayMs,
    50,
    'interBatchDelayMs'
  );
  const idlePollBackoff = resolveIdlePollBackoffOptions(options);
  const claimBatchSize = resolvePositiveIntegerOption(
    options.claimBatchSize,
    DEFAULT_CLAIM_BATCH_SIZE,
    'claimBatchSize'
  );
  const statsRefreshMinIntervalMs = resolvePositiveIntegerOption(
    options.statsRefreshMinIntervalMs,
    DEFAULT_STATS_REFRESH_MIN_INTERVAL_MS,
    'statsRefreshMinIntervalMs'
  );
  const statsRefreshCompletedChunkThreshold = resolvePositiveIntegerOption(
    options.statsRefreshCompletedChunkThreshold,
    DEFAULT_STATS_REFRESH_COMPLETED_CHUNK_THRESHOLD,
    'statsRefreshCompletedChunkThreshold'
  );
  const reinitEveryN = resolveReinitEveryN(options.reinitEveryN);
  const metricsInterval = resolveMetricsIntervalMs(options.metricsIntervalMs);
  const now = options.now ?? Date.now;
  const statsRefreshController = createEmbeddingStatsRefreshController({
    completedChunkThreshold: statsRefreshCompletedChunkThreshold,
    db: options.db,
    log,
    minIntervalMs: statsRefreshMinIntervalMs,
    now,
  });
  const modelResolution = resolveWorkerModel(options.modelKey);
  ensureLocalRuntime(modelResolution);
  const initializeLocalModelOnStart = options.initializeLocalModelOnStart ?? true;
  let activeModelId = modelResolution.modelId;
  let activeCompositeKey = modelResolution.compositeKey;
  let lastClaimBatchSize = claimBatchSize;
  let lastClaimBatchSizeError: string | null = null;
  const workerId = options.workerId ?? `embed-worker-${generateUUID().slice(0, 8)}`;
  let service: EmbeddingService;
  let modelConfig: ModelConfig | null = null;
  let localServiceInitialized = false;
  let localModelExecutionFailure: {
    compositeKey: string;
    message: string;
    modelId: string;
  } | null = null;
  let fatalWorkerError: Error | null = null;
  let localModelInitializationFailure: {
    compositeKey: string;
    message: string;
    modelId: string;
  } | null = null;

  if (isLocalProviderType(modelResolution.provider) && !initializeLocalModelOnStart) {
    service =
      options.service ??
      new SimpleEmbeddingService(
        options.streamingWorkerUrl
          ? {
              streamingWorkerUrl: options.streamingWorkerUrl,
            }
          : undefined
      );
    localServiceInitialized = service.getStatus() === 'ready';
    workerLogger.info('Deferring local embedding model initialization until first claimed job', {
      modelKey: activeCompositeKey,
      serviceReady: localServiceInitialized,
    });
  } else {
    const initializedService = await initializeEmbeddingService(options, activeCompositeKey, {
      initializeLocalService: true,
    });
    service = initializedService.service;
    modelConfig = initializedService.modelConfig;
    if (isLocalProviderType(modelResolution.provider)) {
      localServiceInitialized = service.getStatus() === 'ready';
    }
    ensureModelDimension(initializedService.modelConfig, activeCompositeKey, log);
  }

  // Determine ID column type for file_chunks to support both UUID (Prod) and TEXT (Test/Electron) schemas
  const fileChunkIdType = await resolveIdType(options.db, 'file_chunks');

  // REMOVED: Worker no longer auto-creates embedding sets on startup
  // Collections should ONLY be created by the user via the Create Collection dialog
  // The worker will use embeddingSetId from job payloads (see resolveTargetSetId function)

  const jq = new JobQueue(options.db);
  let running = true;

  async function waitForBackgroundPermit(label: string): Promise<void> {
    await options.waitForBackgroundPermit?.({ label });
  }

  async function resolveEffectiveClaimBatchSize(): Promise<number | null> {
    if (!options.resolveClaimBatchSize) {
      lastClaimBatchSize = claimBatchSize;
      lastClaimBatchSizeError = null;
      return claimBatchSize;
    }
    try {
      const resolved = await options.resolveClaimBatchSize();
      if (resolved === null) {
        lastClaimBatchSize = 0;
        lastClaimBatchSizeError = null;
        return null;
      }
      const requestedClaimBatchSize = resolvePositiveIntegerOption(
        resolved,
        claimBatchSize,
        'resolveClaimBatchSize'
      );
      const effectiveClaimBatchSize = Math.min(requestedClaimBatchSize, claimBatchSize);
      lastClaimBatchSize = effectiveClaimBatchSize;
      lastClaimBatchSizeError = null;
      return effectiveClaimBatchSize;
    } catch (error) {
      // Resolver failures skip this claim poll; report the configured ceiling, not a stale value.
      lastClaimBatchSize = claimBatchSize;
      lastClaimBatchSizeError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  await assertVectorEmbeddingColumn(options.db);

  // Lightweight metrics for observability
  const metrics = {
    startedAt: Date.now(),
    jobsProcessed: 0,
    jobsFailed: 0,
    totalDurationMs: 0,
  };

  // Stability controls
  let processedSinceInit = 0;
  let consecutiveFailures = 0;
  let scheduledReinitPending = false;
  let idlePollCount = 0;
  let idleStartedAt: number | null = null;
  let hasLoggedMaxIdleBackoff = false;
  let nextIdlePollDelayMs = idlePollBackoff.initialMs;

  function triggerFatalLocalWorkerError(error: Error): void {
    if (!options.stopOnFatalLocalError || fatalWorkerError) {
      return;
    }
    fatalWorkerError = error;
    running = false;
    reportWorkerActivity(false);
    workerLogger.error('Stopping embedding worker after fatal local model error', {
      error: error.message,
    });
    try {
      options.onFatalError?.(error);
    } catch (callbackError) {
      workerLogger.error('Embedding worker fatal error callback failed', {
        error: callbackError,
      });
    }
  }

  function resetIdleBackoff(): void {
    idlePollCount = 0;
    idleStartedAt = null;
    hasLoggedMaxIdleBackoff = false;
    nextIdlePollDelayMs = idlePollBackoff.initialMs;
  }

  function reportRuntimeMetadata(metadata: EmbeddingWorkerRuntimeMetadata | undefined): void {
    if (!metadata) {
      return;
    }
    try {
      options.onRuntimeMetadataChange?.(metadata);
    } catch (error) {
      workerLogger.warn('Embedding runtime metadata callback failed', { error });
    }
  }

  function parseRuntimeMetadata(value: unknown): EmbeddingWorkerRuntimeMetadata | undefined {
    if (!(value && typeof value === 'object' && !Array.isArray(value))) {
      return;
    }
    const candidate = value as Partial<EmbeddingWorkerRuntimeMetadata>;
    if (
      (candidate.device === 'webgpu' || candidate.device === 'wasm') &&
      typeof candidate.dtype === 'string' &&
      typeof candidate.fallbackApplied === 'boolean'
    ) {
      return {
        device: candidate.device,
        dtype: candidate.dtype,
        fallbackApplied: candidate.fallbackApplied,
      };
    }
    return;
  }

  function assertLocalModelSwitchAllowed(targetModelId: string): void {
    const allowMainRuntime = readBooleanEnv('EMBED_ALLOW_LOCAL_IN_MAIN') === true;
    if (targetModelId === activeModelId || !isElectronMainProcess() || allowMainRuntime) {
      return;
    }

    throw new Error(
      `Cannot switch local embedding models in main process (from ${activeModelId} to ${targetModelId}). ` +
        'Web Workers are not available in Node.js/Electron main process. ' +
        `Either process this job in the renderer, or ensure all jobs use the same local model: ${activeModelId}`
    );
  }

  function logLocalModelInitialization(shouldReinitialize: boolean): void {
    if (shouldReinitialize) {
      workerLogger.warn('Reinitializing embedding service; this blocks the main thread');
      return;
    }
    workerLogger.info('Initializing deferred local embedding model for claimed work');
  }

  async function resolveLocalModelConfig(
    targetModelId: string,
    shouldReinitialize: boolean
  ): Promise<ModelConfig> {
    const cachedConfig =
      modelConfig && !shouldReinitialize && modelConfig.id === targetModelId ? modelConfig : null;
    if (cachedConfig) {
      return cachedConfig;
    }

    const loadedConfig = await getModelConfigFromDb(options.db, targetModelId);
    if (!loadedConfig) {
      throw new Error(
        `Model '${targetModelId}' not found in database. Add it via Settings > Models.`
      );
    }
    return loadedConfig;
  }

  function createLocalServiceConfig(cfg: ModelConfig): Partial<EmbeddingConfig> {
    return {
      modelId: cfg.id,
      ...(options.device ? { device: options.device } : {}),
      ...(cfg.quantized === undefined ? {} : { quantized: cfg.quantized }),
      ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    };
  }

  async function initializeExistingLocalService(cfg: ModelConfig): Promise<void> {
    const simpleService = service as SimpleEmbeddingService;
    if (typeof simpleService.initializeWithModel === 'function') {
      await simpleService.initializeWithModel(cfg, undefined, options.device, options.cacheDir);
      return;
    }

    await service.initialize(createLocalServiceConfig(cfg), undefined);
  }

  async function createReinitializedLocalService(cfg: ModelConfig): Promise<EmbeddingService> {
    try {
      await service.dispose();
    } catch (error) {
      workerLogger.warn('Failed to dispose embedding service during reinitialization', { error });
    }

    const nextService = new SimpleEmbeddingService(
      options.streamingWorkerUrl
        ? {
            streamingWorkerUrl: options.streamingWorkerUrl,
          }
        : undefined
    );
    await nextService.initializeWithModel(cfg, undefined, options.device, options.cacheDir);
    return nextService;
  }

  function finalizeLocalModelState(
    cfg: ModelConfig,
    targetModelId: string,
    targetCompositeKey: string
  ): void {
    modelConfig = cfg;
    localServiceInitialized = true;
    localModelExecutionFailure = null;
    localModelInitializationFailure = null;
    activeModelId = targetModelId;
    activeCompositeKey = targetCompositeKey;
    ensureModelDimension(modelConfig, activeCompositeKey, log);
    processedSinceInit = 0;
    consecutiveFailures = 0;
  }

  function failFastOnLatchedLocalModelInitializationFailure(
    targetModelId: string,
    targetCompositeKey: string,
    forceReinit: boolean
  ): void {
    if (forceReinit || !localModelInitializationFailure) {
      return;
    }
    if (
      localModelInitializationFailure.modelId !== targetModelId ||
      localModelInitializationFailure.compositeKey !== targetCompositeKey
    ) {
      return;
    }

    throw new Error(
      `Local embedding model initialization previously failed for '${targetCompositeKey}': ${localModelInitializationFailure.message}`
    );
  }

  function latchLocalModelInitializationFailure(
    targetModelId: string,
    targetCompositeKey: string,
    error: unknown
  ): Error {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(
      `Local embedding model initialization failed for '${targetCompositeKey}': ${message}`
    );
    localModelInitializationFailure = {
      modelId: targetModelId,
      compositeKey: targetCompositeKey,
      message,
    };
    triggerFatalLocalWorkerError(wrappedError);
    return options.stopOnFatalLocalError
      ? wrappedError
      : error instanceof Error
        ? error
        : new Error(message);
  }

  function failFastOnLatchedLocalModelExecutionFailure(
    targetModelId: string,
    targetCompositeKey: string
  ): void {
    if (!localModelExecutionFailure) {
      return;
    }
    if (
      localModelExecutionFailure.modelId !== targetModelId ||
      localModelExecutionFailure.compositeKey !== targetCompositeKey
    ) {
      return;
    }

    throw new Error(
      `Local embedding execution previously failed for '${targetCompositeKey}': ${localModelExecutionFailure.message}`
    );
  }

  function latchLocalModelExecutionFailure(
    targetModelId: string,
    targetCompositeKey: string,
    error: unknown
  ): Error {
    const message = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(
      `Local embedding execution failed for '${targetCompositeKey}': ${message}`
    );
    localModelExecutionFailure = {
      modelId: targetModelId,
      compositeKey: targetCompositeKey,
      message,
    };
    triggerFatalLocalWorkerError(wrappedError);
    return options.stopOnFatalLocalError
      ? wrappedError
      : error instanceof Error
        ? error
        : new Error(message);
  }

  async function ensureLocalModel(
    targetModelId: string,
    targetCompositeKey: string,
    opts?: { forceReinit?: boolean }
  ): Promise<void> {
    const forceReinit = opts?.forceReinit ?? false;
    const shouldReinitialize = forceReinit || targetModelId !== activeModelId;
    const shouldInitializeCurrentModel = !localServiceInitialized;

    if (!(shouldReinitialize || shouldInitializeCurrentModel)) {
      return;
    }

    workerLogger.debug('ensureLocalModel check', {
      targetModelId,
      activeModelId,
      shouldReinitialize,
      shouldInitializeCurrentModel,
      forceReinit,
    });

    assertLocalModelSwitchAllowed(targetModelId);
    failFastOnLatchedLocalModelInitializationFailure(
      targetModelId,
      targetCompositeKey,
      forceReinit
    );
    logLocalModelInitialization(shouldReinitialize);
    try {
      const cfg = await resolveLocalModelConfig(targetModelId, shouldReinitialize);

      if (shouldReinitialize) {
        service = await createReinitializedLocalService(cfg);
      } else {
        await initializeExistingLocalService(cfg);
      }
      finalizeLocalModelState(cfg, targetModelId, targetCompositeKey);
    } catch (error) {
      throw latchLocalModelInitializationFailure(targetModelId, targetCompositeKey, error);
    }
  }

  async function resetService() {
    localModelExecutionFailure = null;
    localModelInitializationFailure = null;
    await ensureLocalModel(activeModelId, activeCompositeKey, {
      forceReinit: true,
    });
    scheduledReinitPending = false;
  }

  // biome-ignore lint/style/useNamingConvention: DB field name
  type ClaimedJob = Job & { lease_token: string };

  async function generateLocalEmbeddings(
    chunks: LoadedChunkItem['chunk'][],
    expectedDimension: number
  ): Promise<EmbeddingResult[]> {
    if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Invalid expected embedding dimension (${expectedDimension}).`);
    }

    workerLogger.debug('Calling service.generateEmbeddings (may block main thread)', {
      count: chunks.length,
      expectedDimension,
    });

    const texts = chunks.map((c) => c.content);

    // EmbeddingService interface guarantees generateEmbeddings is available
    // No unsafe casting needed - use the typed service directly
    const results = await service.generateEmbeddings(texts);

    workerLogger.debug('service.generateEmbeddings completed');

    for (const result of results) {
      if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimension) {
        throw new Error(
          `Embedding dimension mismatch for model '${activeCompositeKey}': received ${result.embedding.length}, expected ${expectedDimension}. ` +
            'Verify provider configuration (dimension/size parameter) and retry.'
        );
      }
    }
    reportRuntimeMetadata(results.find((result) => result.runtime)?.runtime);

    return results;
  }

  function assertStreamingService(candidate: EmbeddingService): StreamingEmbeddingService {
    const streamingService = candidate as StreamingEmbeddingService;
    if (typeof streamingService.generateEmbeddingsStream !== 'function') {
      throw new Error(
        'Local embedding service must implement generateEmbeddingsStream for background worker processing.'
      );
    }
    return streamingService;
  }

  function handleHostedError(provider: SupportedHostedProvider, error: EmbeddingProviderError) {
    if (error.type === 'rate_limit_exceeded') {
      const retryAfter = error.retryAfter;
      const ms = retryAfter ? retryAfter * 1000 : undefined;
      throw new WorkerRateLimitError(formatHostedEmbedError(provider, error), ms);
    }
    throw new Error(formatHostedEmbedError(provider, error));
  }

  async function generateHostedEmbeddings(
    provider: Exclude<EmbeddingProviderType, LocalProviderType>,
    modelId: string,
    expectedDimension: number,
    texts: string[]
  ): Promise<number[][]> {
    const supportedProvider = toSupportedHostedProvider(provider);
    const config = buildHostedProviderConfig(supportedProvider, modelId, expectedDimension);
    const providerInstance = await createHostedProviderInstance(supportedProvider, config);

    // Casting to allow array input which we added support for
    const embedResult = await providerInstance.embed({
      text: texts,
      modelId,
    });

    if (!embedResult.ok) {
      handleHostedError(supportedProvider, embedResult.error);
      throw new Error('Unreachable'); // handleHostedError always throws
    }

    const embeddings =
      embedResult.value.embeddings ||
      (embedResult.value.embedding ? [embedResult.value.embedding] : []);

    if (embeddings.length !== texts.length) {
      throw new Error(
        `Hosted provider returned ${embeddings.length} embeddings for ${texts.length} inputs.`
      );
    }

    for (const embedding of embeddings) {
      validateHostedEmbeddingDimensions(supportedProvider, modelId, embedding, expectedDimension);
    }

    return embeddings;
  }
  async function determineExpectedDimension(
    targetSetId: string,
    payload: EmbedChunkPayload
  ): Promise<number> {
    const setDimension = await resolveEmbeddingSetDimension(options.db, targetSetId);
    if (payload.expectedDimension !== setDimension) {
      log('worker_expected_dimension_mismatch', {
        chunkId: payload.chunkId,
        payload: payload.expectedDimension,
        embeddingSetId: targetSetId,
        embeddingSetDimension: setDimension,
      });
      throw new Error(
        `Embedding dimension mismatch for set '${targetSetId}': payload=${payload.expectedDimension}, set=${setDimension}.`
      );
    }

    if (!Number.isFinite(setDimension) || setDimension <= 0) {
      throw new Error(`Invalid expected embedding dimension for set '${targetSetId}'.`);
    }

    return setDimension;
  }

  async function handleBatchFailure(jobs: ClaimedJob[], error: unknown) {
    // LOG THE ERROR so we can see what's happening
    workerLogger.error('handleBatchFailure: Job(s) failed', {
      jobCount: jobs.length,
      jobIds: jobs.map((j) => j.id).slice(0, 5), // First 5 job IDs
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const { backoffMs, isTerminal, truncated } = classifyFailure(error);

    // Fail all jobs in one batched call (2-3 queries instead of 2N)
    await jq.failBatch({
      jobs: jobs.map((j) => ({ id: j.id, leaseToken: j.lease_token })),
      error: truncated,
      terminal: isTerminal,
      ...(backoffMs === undefined ? {} : { backoffMs }),
    });

    metrics.jobsFailed += jobs.length;
    consecutiveFailures += 1;

    if (fatalWorkerError) {
      return;
    }

    if (reinitEveryN > 0 && consecutiveFailures >= reinitEveryN) {
      workerLogger.warn(
        `Consecutive failures (${consecutiveFailures}); forcing service reinitialization.`
      );
      await resetService();
      consecutiveFailures = 0;
    }
  }

  const embeddingCacheMaintenance = options.embeddingCache
    ? new EmbeddingCacheMaintenanceController(options.embeddingCache, {
        log,
        warn: (message, meta) => workerLogger.warn(message, meta),
      })
    : null;

  function trackCacheWrite(write: Promise<number>): void {
    embeddingCacheMaintenance?.trackCacheWrite(write);
  }

  async function runEmbeddingCacheMaintenance(reason: 'queue-idle'): Promise<void> {
    await embeddingCacheMaintenance?.run(reason);
  }

  async function flushEmbeddingCacheWrites(): Promise<void> {
    await embeddingCacheMaintenance?.flushPendingWrites();
    await options.embeddingCache?.flushPendingAccessTimeUpdates?.();
  }

  async function generateEmbeddingsForGroup(
    jobModel: EmbeddingJobModel,
    toProcess: LoadedChunkItem[],
    expectedDimension: number
  ): Promise<number[][]> {
    const modelKey = jobModel.compositeKey;

    // BST-170: Check cache for existing embeddings
    const cacheHits = await lookupCacheHits(
      options.embeddingCache,
      toProcess,
      modelKey,
      workerLogger
    );
    const cacheMisses = filterCacheMisses(toProcess, cacheHits, modelKey);

    // All items were cache hits
    if (cacheMisses.length === 0) {
      return reconstructResults(toProcess, cacheHits, [], modelKey);
    }

    // Generate embeddings for cache misses only
    let generatedEmbeddings: number[][];
    const texts = cacheMisses.map((item) => item.chunk.content);

    if (isLocalProviderType(jobModel.provider)) {
      await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
      failFastOnLatchedLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey);
      let results: EmbeddingResult[];
      try {
        results = await generateLocalEmbeddings(
          cacheMisses.map((item) => item.chunk),
          expectedDimension
        );
      } catch (error) {
        throw latchLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey, error);
      }
      localModelExecutionFailure = null;
      generatedEmbeddings = results.map((r) => r.embedding);
    } else {
      generatedEmbeddings = await generateHostedEmbeddings(
        jobModel.provider,
        jobModel.modelId,
        expectedDimension,
        texts
      );
    }

    // BST-170: Store generated embeddings in cache (fire-and-forget)
    storeToCacheAsync(
      options.embeddingCache,
      cacheMisses,
      generatedEmbeddings,
      modelKey,
      expectedDimension,
      trackCacheWrite
    );

    return reconstructResults(toProcess, cacheHits, generatedEmbeddings, modelKey);
  }

  async function validateBatchDimensions(toProcess: LoadedChunkItem[]) {
    const dimensions = await Promise.all(
      toProcess.map((item) =>
        determineExpectedDimension(resolveTargetSetId(item.payload), item.payload)
      )
    );

    const expectedDimension = dimensions[0];
    if (!expectedDimension) {
      throw new Error('Could not determine expected dimension for batch.');
    }

    if (dimensions.some((d) => d !== expectedDimension)) {
      throw new Error('Batch contains jobs with conflicting expected dimensions.');
    }
    return expectedDimension;
  }

  async function completeBatch(
    toProcess: LoadedChunkItem[],
    embeddings: number[][],
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<Set<string>> {
    // Validate batch size consistency before processing
    if (toProcess.length !== embeddings.length) {
      throw new Error(
        `Batch size mismatch: ${toProcess.length} items vs ${embeddings.length} embeddings.`
      );
    }

    const completedJobIds = new Set<string>();
    const updates: Array<{
      id: string;
      embedding: number[];
      embeddingSetId: string;
      embeddingHash: string;
    }> = [];
    const jobCompletions: Array<{ id: string; leaseToken: string }> = [];

    for (let index = 0; index < toProcess.length; index++) {
      const item = toProcess[index];
      const embedding = embeddings[index];
      if (!(item && embedding)) {
        throw new Error(`Missing item or embedding at index ${index} in batch.`);
      }
      const targetSetId = resolveTargetSetId(item.payload);
      updates.push({
        id: item.chunk.id,
        embedding,
        embeddingSetId: targetSetId,
        embeddingHash: item.expectedHash,
      });
      jobCompletions.push({ id: item.job.id, leaseToken: item.job.lease_token });
    }

    if (updates.length > 0) {
      await waitForBackgroundPermit('embedding completion');
      await updateChunkEmbeddingBatch(options.db, updates, fileChunkIdType);
    }

    const completedJobs = await jq.completeBatch(jobCompletions);

    for (const job of completedJobs) {
      completedJobIds.add(job.id);
    }
    onJobsCompleted?.(completedJobIds);
    const completedEmbeddingSetIds = updates.map((update) => update.embeddingSetId);
    const completedEmbeddingSetCount = new Set(completedEmbeddingSetIds).size;
    log('embedding_completion_batch', {
      completedJobCount: completedJobIds.size,
      embeddingSetCount: completedEmbeddingSetCount,
      updateCount: updates.length,
    });
    try {
      await statsRefreshController.recordCompletions(completedEmbeddingSetIds, updates.length);
      await statsRefreshController.flushIfDue();
    } catch (error) {
      workerLogger.warn('Failed to update embedding completion stats', {
        completedChunkCount: updates.length,
        embeddingSetCount: completedEmbeddingSetCount,
        error,
      });
    }

    return completedJobIds;
  }

  async function completeBatchAndTrack(
    toProcess: LoadedChunkItem[],
    embeddings: number[][],
    completedJobIds: Set<string>,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    const newlyCompleted = await completeBatch(toProcess, embeddings, onJobsCompleted);
    for (const id of newlyCompleted) {
      completedJobIds.add(id);
    }
    metrics.jobsProcessed += toProcess.length;
    processedSinceInit += toProcess.length;
    consecutiveFailures = 0;
  }

  async function processLocalGroupIncrementally(
    jobModel: EmbeddingJobModel,
    toProcess: LoadedChunkItem[],
    expectedDimension: number,
    completedJobIds: Set<string>,
    checkLease: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    const modelKey = jobModel.compositeKey;
    const cacheHits = await lookupCacheHits(
      options.embeddingCache,
      toProcess,
      modelKey,
      workerLogger
    );
    const cacheMisses = filterCacheMisses(toProcess, cacheHits, modelKey);
    const cacheHitItems = toProcess.filter((item) =>
      cacheHits.has(`${item.chunk.contentHash}:${modelKey}`)
    );

    if (cacheHitItems.length > 0) {
      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }
      const cachedEmbeddings = reconstructResults(cacheHitItems, cacheHits, [], modelKey);
      await completeBatchAndTrack(
        cacheHitItems,
        cachedEmbeddings,
        completedJobIds,
        onJobsCompleted
      );
    }

    if (cacheMisses.length === 0) {
      await maybeReinitialize();
      return;
    }

    await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
    failFastOnLatchedLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey);
    const streamingService = assertStreamingService(service);

    try {
      const runtimeMetadata = await streamingService.generateEmbeddingsStream(
        cacheMisses.map((item) => item.chunk.content),
        async (batch) => {
          if (checkLease()) {
            throw new LocalEmbeddingStreamCallbackError(new Error('Lease lost during processing'));
          }

          const batchItems = cacheMisses.slice(batch.startIndex, batch.endIndex);
          if (batchItems.length !== batch.results.length) {
            throw new Error(
              `Local embedding stream batch mismatch: ${batchItems.length} items for ${batch.results.length} results.`
            );
          }

          const embeddings = batch.results.map((result, index) => {
            if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimension) {
              throw new Error(
                `Embedding dimension mismatch for model '${jobModel.compositeKey}' batch item ${batch.startIndex + index}: received ${result.embedding.length}, expected ${expectedDimension}.`
              );
            }
            return result.embedding;
          });

          try {
            await completeBatchAndTrack(batchItems, embeddings, completedJobIds, onJobsCompleted);
            storeToCacheAsync(
              options.embeddingCache,
              batchItems,
              embeddings,
              modelKey,
              expectedDimension,
              trackCacheWrite
            );
          } catch (error) {
            throw new LocalEmbeddingStreamCallbackError(error);
          }
        }
      );
      reportRuntimeMetadata(parseRuntimeMetadata(runtimeMetadata));
    } catch (error) {
      if (error instanceof LocalEmbeddingStreamCallbackError) {
        throw error.originalError instanceof Error ? error.originalError : error;
      }
      throw latchLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey, error);
    }

    localModelExecutionFailure = null;

    await maybeReinitialize();
  }

  function startHeartbeat(jobs: ClaimedJob[], onLeaseLost: (job: ClaimedJob) => void) {
    const completedJobs = new Set<string>();
    const lostJobs = new Set<string>();
    let isHeartbeating = false;

    const timer = setInterval(() => {
      // Prevent overlapping heartbeats (race condition protection)
      if (isHeartbeating) {
        return;
      }
      isHeartbeating = true;

      (async () => {
        try {
          const activeJobs = jobs.filter(
            (job) => !(completedJobs.has(job.id) || lostJobs.has(job.id))
          );
          if (activeJobs.length === 0) {
            return;
          }

          const heartbeatInput = activeJobs.map((job) => ({
            id: job.id,
            leaseToken: job.lease_token,
          }));

          const heartbeatedJobs = await jq.heartbeatBatch(heartbeatInput, leaseMs);
          const succeededIds = new Set(heartbeatedJobs.map((j) => j.id));

          for (const job of activeJobs) {
            // Streaming completions can land while heartbeatBatch awaits the DB host.
            if (completedJobs.has(job.id)) {
              continue;
            }
            if (!succeededIds.has(job.id)) {
              workerLogger.error('Heartbeat failed: lease lost', { jobId: job.id });
              lostJobs.add(job.id);
              onLeaseLost(job);
            }
          }
        } finally {
          isHeartbeating = false;
        }
      })().catch((err) => {
        log('worker_heartbeat_error', { count: jobs.length, error: String(err) });
      });
    }, heartbeatMs);

    return {
      markCompleted(jobIds: Iterable<string>): void {
        for (const jobId of jobIds) {
          completedJobs.add(jobId);
        }
      },
      stop(): void {
        clearInterval(timer);
      },
    };
  }

  async function processJobGroup(
    jobs: ClaimedJob[],
    jobModel: EmbeddingJobModel,
    checkLease: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ) {
    const { toProcess, completed, orphanCount } = await loadAndFilterChunks(jobs, jobModel, {
      db: options.db,
      failOrphanJobs: async (orphanJobs, error) => {
        await jq.failBatch({ jobs: orphanJobs, error, terminal: true });
      },
      fileChunkIdType,
      hashExpectedEmbedding: sha256Hex,
      logWarn: (message, meta) => workerLogger.warn(message, meta),
    });
    metrics.jobsFailed += orphanCount;
    const completedJobIds = new Set<string>(completed.map((item) => item.job.id));

    try {
      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }

      await markAlreadyCompleted(completed, completedJobIds, onJobsCompleted);

      if (toProcess.length === 0) {
        return;
      }

      const expectedDimension = await validateBatchDimensions(toProcess);

      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }

      if (isLocalProviderType(jobModel.provider)) {
        await processLocalGroupIncrementally(
          jobModel,
          toProcess,
          expectedDimension,
          completedJobIds,
          checkLease,
          onJobsCompleted
        );
      } else {
        const embeddings = await generateEmbeddingsForGroup(jobModel, toProcess, expectedDimension);

        if (checkLease()) {
          throw new Error('Lease lost during processing');
        }

        await completeBatchAndTrack(toProcess, embeddings, completedJobIds, onJobsCompleted);
        await maybeReinitialize();
      }
    } catch (err) {
      const remainingJobs = jobs.filter((job) => !completedJobIds.has(job.id));
      throw new JobProcessingError('Failed processing job group', remainingJobs, err);
    }
  }

  /**
   * Mark already-completed jobs (chunks with matching embedding_hash) as succeeded.
   * Uses batch completion to avoid N+1 database queries.
   *
   * @param completed - Jobs that were filtered out because their chunks are already embedded
   * @param completedJobIds - Set to track which job IDs have been completed
   */
  async function markAlreadyCompleted(
    completed: Array<{ job: ClaimedJob }>,
    completedJobIds: Set<string>,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ) {
    if (completed.length === 0) {
      return;
    }
    await jq.completeBatch(
      completed.map((item) => ({ id: item.job.id, leaseToken: item.job.lease_token }))
    );
    const newlyCompleted = new Set<string>();
    for (const item of completed) {
      completedJobIds.add(item.job.id);
      newlyCompleted.add(item.job.id);
    }
    onJobsCompleted?.(newlyCompleted);
    metrics.jobsProcessed += completed.length;
    processedSinceInit += completed.length;
  }

  async function maybeReinitialize() {
    if (reinitEveryN <= 0 || processedSinceInit < reinitEveryN || scheduledReinitPending) {
      return;
    }
    // Reinitialize inline instead of deferring to idle. During large backfills
    // the queue is never idle, so the deferred reinit never runs. This causes
    // the ONNX WASM heap to grow unboundedly (WASM memory can only grow, not
    // shrink). Inline reinit caps memory by creating a fresh WASM instance.
    workerLogger.info(
      `Processed ${processedSinceInit} jobs; reinitializing embedding service to reclaim WASM memory.`
    );
    try {
      await resetService();
    } catch (error) {
      workerLogger.error('Inline embedding service reinitialization failed', { error });
    }
  }

  async function resolveGroupJobModelOrFail(jobs: ClaimedJob[]): Promise<EmbeddingJobModel | null> {
    const firstJob = jobs[0];
    if (!firstJob) {
      return null;
    }
    try {
      const payload = assertEmbedChunkJob(firstJob);
      return resolveJobModel(payload);
    } catch (err) {
      await handleBatchFailure(jobs, err);
      return null;
    }
  }

  function createLeaseTracker(
    jobs: ClaimedJob[],
    checkLeaseOverride?: () => boolean
  ): {
    checkLease: () => boolean;
    dispose: () => void;
    markCompleted: (jobIds: Iterable<string>) => void;
  } {
    let leaseLost = false;
    const checkLease = checkLeaseOverride ?? (() => leaseLost);
    const hb =
      checkLeaseOverride === undefined
        ? startHeartbeat(jobs, () => {
            leaseLost = true;
          })
        : undefined;
    return {
      checkLease,
      dispose: () => {
        if (hb) {
          hb.stop();
        }
      },
      markCompleted: (jobIds: Iterable<string>) => {
        hb?.markCompleted(jobIds);
      },
    };
  }

  async function handleGroupError(
    error: unknown,
    jobs: ClaimedJob[],
    checkLease: () => boolean
  ): Promise<void> {
    if (checkLease()) {
      workerLogger.warn('Aborting batch processing due to lost lease');
      return;
    }
    if (error instanceof JobProcessingError) {
      await handleBatchFailure(error.remainingJobs, error.originalError ?? error);
      return;
    }
    await handleBatchFailure(jobs, error);
  }

  async function processGroup(
    jobs: ClaimedJob[],
    checkLeaseOverride?: () => boolean,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): Promise<void> {
    if (jobs.length === 0) {
      return;
    }

    const jobModel = await resolveGroupJobModelOrFail(jobs);
    if (!jobModel) {
      return;
    }

    const lease = createLeaseTracker(jobs, checkLeaseOverride);
    const markJobsCompleted = (jobIds: Set<string>) => {
      lease.markCompleted(jobIds);
      onJobsCompleted?.(jobIds);
    };

    try {
      await processJobGroup(jobs, jobModel, lease.checkLease, markJobsCompleted);
    } catch (error) {
      await handleGroupError(error, jobs, lease.checkLease);
    } finally {
      lease.dispose();
    }
  }

  function groupJobs(jobs: ClaimedJob[]): Map<string, ClaimedJob[]> {
    const groups = new Map<string, ClaimedJob[]>();
    for (const job of jobs) {
      try {
        const payload = assertEmbedChunkJob(job);
        const model = resolveJobModel(payload);
        const key = `${model.provider}:${model.compositeKey}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)?.push(job);
      } catch (err) {
        // If we can't parse job/model, fail it immediately
        jq.fail({
          id: job.id,
          leaseToken: job.lease_token,
          error: err instanceof Error ? err.message : String(err),
        }).catch((e: unknown) => workerLogger.error('Failed to fail job', { error: e }));
        metrics.jobsFailed += 1;
      }
    }
    return groups;
  }

  async function processClaimedJobs(jobs: ClaimedJob[]) {
    const leaseLost = new Set<string>();
    const batchHeartbeat = startHeartbeat(jobs, (job) => {
      leaseLost.add(job.id);
    });

    try {
      const groups = groupJobs(jobs);
      for (const group of groups.values()) {
        const checkLease = () => group.some((job) => leaseLost.has(job.id));
        if (checkLease()) {
          workerLogger.warn('Skipping group due to lost lease before processing', {
            jobIds: group.map((job) => job.id),
          });
          continue;
        }
        await processGroup(group, checkLease, (jobIds) => {
          batchHeartbeat.markCompleted(jobIds);
        });
      }
    } finally {
      batchHeartbeat.stop();
    }
  }

  async function handleIdleBatch(): Promise<void> {
    reportWorkerActivity(false);
    const idleObservedAt = now();
    if (idleStartedAt === null) {
      idleStartedAt = idleObservedAt;
    }
    idlePollCount += 1;
    if (scheduledReinitPending) {
      workerLogger.info('Queue idle; performing scheduled embedding service reinitialization.');
      try {
        await resetService();
      } catch (error) {
        workerLogger.error('Scheduled embedding service reinitialization failed', { error });
      }
    }
    try {
      await statsRefreshController.flush('queue-idle');
    } catch (error) {
      workerLogger.warn('Failed to refresh embedding stats during idle', { error });
    }
    await runEmbeddingCacheMaintenance('queue-idle');
    const currentIdleDelayMs = nextIdlePollDelayMs;
    const hasReachedMaxBackoff = currentIdleDelayMs >= idlePollBackoff.maxMs;
    if (shouldLogIdleBackoff(idlePollCount, hasReachedMaxBackoff, hasLoggedMaxIdleBackoff)) {
      log('embedding_queue_idle_backoff', {
        backoffMs: currentIdleDelayMs,
        idleDurationBeforeBackoffMs: Math.max(0, idleObservedAt - idleStartedAt),
        idlePollCount,
        queue: queueName,
        workerId,
      });
    }
    if (hasReachedMaxBackoff) {
      hasLoggedMaxIdleBackoff = true;
    }
    nextIdlePollDelayMs = Math.min(nextIdlePollDelayMs * 2, idlePollBackoff.maxMs);
    await sleep(currentIdleDelayMs);
  }

  function isClosedDatabaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('PGlite is closed') || message.includes('closed');
  }

  async function processBatch(): Promise<void> {
    const batchStart = performance.now();
    try {
      await waitForBackgroundPermit('embedding claim');
      const effectiveClaimBatchSize = await resolveEffectiveClaimBatchSize();
      if (effectiveClaimBatchSize === null) {
        await sleep(CLAIM_SIZE_RESOLVER_RETRY_BACKOFF_MS);
        return;
      }
      // Claim a batch of jobs
      const jobs = (await jq.claimMany({
        queue: queueName,
        leaseMs,
        workerId,
        limit: effectiveClaimBatchSize,
      })) as ClaimedJob[];

      if (jobs.length === 0) {
        await handleIdleBatch();
        return;
      }

      resetIdleBackoff();
      beginActiveBatch();
      try {
        await processClaimedJobs(jobs);
      } finally {
        endActiveBatch();
      }

      // Yield between batches to let V8/GC and the foreground renderer breathe
      // under sustained background embedding load.
      if (running) {
        await sleep(interBatchDelayMs);
      }
    } catch (err) {
      if (isClosedDatabaseError(err)) {
        running = false; // Stop the worker loop
        return;
      }
      workerLogger.error('Critical worker error in processBatch', { error: err });
      await sleep(1000);
    } finally {
      metrics.totalDurationMs += performance.now() - batchStart;
    }
  }

  const loops: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(
      (async () => {
        while (running) {
          await processBatch();
        }
      })()
    );
  }

  // Periodic metrics logger
  const metricsTimer = setInterval(
    () => {
      if (!running) {
        return;
      }
      const uptimeMs = Date.now() - metrics.startedAt;
      const avgMs = metrics.jobsProcessed > 0 ? metrics.totalDurationMs / metrics.jobsProcessed : 0;
      log('worker_metrics', {
        uptimeMs,
        processed: metrics.jobsProcessed,
        failed: metrics.jobsFailed,
        avgDurationMs: Math.round(avgMs),
        concurrency,
        claimBatchSize,
        effectiveClaimBatchSize: lastClaimBatchSize,
        effectiveClaimBatchSizeError: lastClaimBatchSizeError,
        interBatchDelayMs,
        queue: queueName,
        modelKey: activeCompositeKey,
      });
    },
    Math.max(5000, metricsInterval)
  );

  return {
    stop: async () => {
      running = false;
      reportWorkerActivity(false);
      await Promise.race([Promise.allSettled(loops).then(() => {}), sleep(leaseMs)]);
      try {
        await statsRefreshController.flush('worker-stop');
      } catch (error) {
        workerLogger.warn('Failed to refresh embedding stats during shutdown', { error });
      }
      await flushEmbeddingCacheWrites();
      try {
        await service.dispose();
      } catch (error) {
        workerLogger.warn('Failed to dispose embedding service during shutdown', { error });
      }
      clearInterval(metricsTimer);
    },
  };
}
