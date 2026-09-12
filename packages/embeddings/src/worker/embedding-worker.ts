import type { ClaimedJob, IDatabase, Job } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { parsePositiveIntegerConfig } from '@brainstrike/platform-utils';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { generateUUID } from '@brainstrike/utils';
import { SimpleEmbeddingService, type SimpleEmbeddingServiceOptions } from '../bge-m3-service.js';
import type {
  EmbeddingProviderError,
  EmbeddingProviderType,
  LocalProviderType,
} from '../provider-types.js';
import { isLocalProviderType } from '../provider-types.js';
import type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingService,
  EmbeddingStreamBatch,
  EmbeddingStreamOptions,
  EmbeddingWorkerRuntimeMetadata,
  ModelConfig,
} from '../types.js';
import { EmbeddingCacheMaintenanceController } from './embedding-cache-maintenance.js';
import type { EmbeddingCacheInterface } from './embedding-cache-types.js';
import { getModelConfigFromDb } from './embedding-model-config.js';
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
} from './embedding-provider-runtime.js';
import { createEmbeddingStatsRefreshController } from './embedding-stats-refresh-controller.js';
import {
  filterCacheMisses,
  lookupCacheHits,
  reconstructResults,
  storeToCacheAsync,
} from './embedding-worker-cache-io.js';
import { type LoadedChunkItem, loadAndFilterChunks } from './embedding-worker-chunk-filter.js';
import {
  assertVectorEmbeddingColumn,
  resolveEmbeddingSetDimension,
  resolveIdType,
} from './embedding-worker-db-io.js';
import { classifyFailure, JobProcessingError } from './embedding-worker-failures.js';
import {
  assertEmbedChunkJob,
  type EmbedChunkPayload,
  type EmbeddingJobModel,
  resolveJobModel,
  resolveTargetSetId,
} from './embedding-worker-job-payload.js';
import {
  CLAIM_SIZE_RESOLVER_RETRY_BACKOFF_MS,
  DEFAULT_CLAIM_BATCH_SIZE,
  resolveIdlePollBackoffOptions,
  resolvePositiveIntegerOption,
  shouldLogIdleBackoff,
} from './embedding-worker-scheduler.js';

export type { CachedEmbedding, EmbeddingCacheInterface } from './embedding-cache-types.js';
export { clearModelConfigCache, invalidateModelConfigCache } from './embedding-model-config.js';
export type {
  EmbeddingStatsRefreshController,
  EmbeddingStatsRefreshControllerOptions,
  StatsRefreshReason,
} from './embedding-stats-refresh-controller.js';
export { createEmbeddingStatsRefreshController } from './embedding-stats-refresh-controller.js';

const workerLogger = createLogger('EmbeddingWorker');

type Distance = 'cosine' | 'l2' | 'ip';

export interface EmbeddingWorkerPipelineCapacity {
  maxPendingCompletionBatches: number;
  maxPendingCompletionBytes: number;
  maxPendingCompletionChunks: number;
  streamBatchSize: number;
}

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
  /**
   * Runtime-wide ceiling for claimed jobs awaiting a completion or failure write.
   * Raise this with `concurrency` when additional loops should increase in-flight work.
   */
  maxInFlightJobs?: number;
  maxPendingCompletionBatches?: number;
  maxPendingCompletionBytes?: number;
  maxPendingCompletionChunks?: number;
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
  resolvePipelineCapacity?: () =>
    | EmbeddingWorkerPipelineCapacity
    | null
    | Promise<EmbeddingWorkerPipelineCapacity | null>;
  service?: EmbeddingService;
  statsRefreshCompletedChunkThreshold?: number;
  statsRefreshMinIntervalMs?: number;
  /**
   * When true, a fatal local-model initialization/execution error stops the
   * worker loop immediately instead of continuing to claim and fail later jobs.
   * This is intended for desktop hidden-host mode to avoid renderer churn.
   */
  stopOnFatalLocalError?: boolean;
  streamBatchSize?: number;
  streamingWorkerUrl?: string;
  waitForBackgroundPermit?: (options: { readonly label: string }) => Promise<void>;
  workerId?: string;
}

export interface EmbeddingWorkerController {
  stop: () => Promise<void>;
}

function createSimpleEmbeddingServiceOptions(
  options: Pick<EmbeddingWorkerOptions, 'streamBatchSize' | 'streamingWorkerUrl'>
): SimpleEmbeddingServiceOptions | undefined {
  if (!(options.streamingWorkerUrl || options.streamBatchSize)) {
    return;
  }
  return {
    ...(options.streamBatchSize ? { streamBatchSize: options.streamBatchSize } : {}),
    ...(options.streamingWorkerUrl ? { streamingWorkerUrl: options.streamingWorkerUrl } : {}),
  };
}

const DEFAULT_STATS_REFRESH_MIN_INTERVAL_MS = 5000;
const DEFAULT_STATS_REFRESH_COMPLETED_CHUNK_THRESHOLD = 512;
const EMBED_REINIT_EVERY_ENV = 'EMBED_REINIT_EVERY';
const WORKER_METRICS_INTERVAL_MS_ENV = 'WORKER_METRICS_INTERVAL_MS';

type StreamingEmbeddingService = EmbeddingService & {
  generateEmbeddingsStream: (
    texts: string[],
    onBatch: (batch: EmbeddingStreamBatch) => Promise<void> | void,
    options?: EmbeddingStreamOptions
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * A loop delay that ends early when the worker is stopped. Every wait inside
 * the claim loop must use this: desktop graceful shutdown gives the embedding
 * host one bounded budget, and a loop parked in a long idle poll would
 * otherwise hold `stop()` until that poll expired.
 */
function sleepUnlessStopped(ms: number, stopSignal: AbortSignal): Promise<void> {
  if (stopSignal.aborted) {
    return Promise.resolve();
  }
  return new Promise((res) => {
    const timer = setTimeout(() => {
      stopSignal.removeEventListener('abort', onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      res();
    };
    stopSignal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  workerLogger.info('startEmbeddingWorker: START', {
    claimBatchSize: options.claimBatchSize,
    concurrency: options.concurrency,
    device: options.device,
    hasDb: !!options.db,
    interBatchDelayMs: options.interBatchDelayMs,
    modelKey: options.modelKey,
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

  const runWithWorkerActivity = async <T>(work: () => Promise<T>): Promise<T> => {
    beginActiveBatch();
    try {
      return await work();
    } finally {
      endActiveBatch();
    }
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
  const maxInFlightJobs = resolvePositiveIntegerOption(
    options.maxInFlightJobs,
    claimBatchSize,
    'maxInFlightJobs'
  );
  const maxPendingCompletionBatches = resolvePositiveIntegerOption(
    options.maxPendingCompletionBatches,
    2,
    'maxPendingCompletionBatches'
  );
  const maxPendingCompletionChunks = resolvePositiveIntegerOption(
    options.maxPendingCompletionChunks,
    claimBatchSize,
    'maxPendingCompletionChunks'
  );
  const maxPendingCompletionBytes = resolvePositiveIntegerOption(
    options.maxPendingCompletionBytes,
    claimBatchSize * DEFAULT_EMBEDDING_DIMENSION * 4,
    'maxPendingCompletionBytes'
  );
  const streamBatchSize = resolvePositiveIntegerOption(
    options.streamBatchSize,
    claimBatchSize,
    'streamBatchSize'
  );
  const staticPipelineCapacity: EmbeddingWorkerPipelineCapacity = {
    maxPendingCompletionBatches,
    maxPendingCompletionBytes,
    maxPendingCompletionChunks,
    streamBatchSize,
  };
  const shouldOverrideStreamBatchSize =
    options.streamBatchSize !== undefined || typeof options.resolvePipelineCapacity === 'function';
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
  let latestRuntimeMetadata: EmbeddingWorkerRuntimeMetadata | null = null;

  if (isLocalProviderType(modelResolution.provider) && !initializeLocalModelOnStart) {
    service =
      options.service ?? new SimpleEmbeddingService(createSimpleEmbeddingServiceOptions(options));
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
  const stopController = new AbortController();
  let inFlightJobs = 0;
  const inFlightBudgetWaiters = new Set<() => void>();

  function notifyInFlightBudgetWaiters(): void {
    for (const resolve of inFlightBudgetWaiters) {
      resolve();
    }
    inFlightBudgetWaiters.clear();
  }

  function reserveInFlightJobs(requested: number): number {
    const available = Math.max(0, maxInFlightJobs - inFlightJobs);
    const reserved = Math.min(requested, available);
    inFlightJobs += reserved;
    return reserved;
  }

  function releaseInFlightJobs(count: number): void {
    if (count === 0) {
      return;
    }
    if (count < 0 || count > inFlightJobs) {
      throw new Error(
        `Invalid embedding in-flight budget release: ${count} with ${inFlightJobs} reserved.`
      );
    }
    inFlightJobs -= count;
    notifyInFlightBudgetWaiters();
  }

  async function waitForInFlightBudget(): Promise<void> {
    if (!running || inFlightJobs < maxInFlightJobs) {
      return;
    }
    await new Promise<void>((resolve) => {
      inFlightBudgetWaiters.add(resolve);
    });
  }

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

  async function resolveEffectivePipelineCapacity(): Promise<EmbeddingWorkerPipelineCapacity> {
    if (!options.resolvePipelineCapacity) {
      return staticPipelineCapacity;
    }
    const resolved = await options.resolvePipelineCapacity();
    if (resolved === null) {
      return staticPipelineCapacity;
    }
    return {
      maxPendingCompletionBatches: resolvePositiveIntegerOption(
        resolved.maxPendingCompletionBatches,
        staticPipelineCapacity.maxPendingCompletionBatches,
        'resolvePipelineCapacity.maxPendingCompletionBatches'
      ),
      maxPendingCompletionBytes: resolvePositiveIntegerOption(
        resolved.maxPendingCompletionBytes,
        staticPipelineCapacity.maxPendingCompletionBytes,
        'resolvePipelineCapacity.maxPendingCompletionBytes'
      ),
      maxPendingCompletionChunks: resolvePositiveIntegerOption(
        resolved.maxPendingCompletionChunks,
        staticPipelineCapacity.maxPendingCompletionChunks,
        'resolvePipelineCapacity.maxPendingCompletionChunks'
      ),
      streamBatchSize: resolvePositiveIntegerOption(
        resolved.streamBatchSize,
        staticPipelineCapacity.streamBatchSize,
        'resolvePipelineCapacity.streamBatchSize'
      ),
    };
  }

  await assertVectorEmbeddingColumn(options.db);

  // Lightweight metrics for observability
  const metrics = {
    jobsFailed: 0,
    jobsProcessed: 0,
    startedAt: Date.now(),
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
    notifyInFlightBudgetWaiters();
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
    latestRuntimeMetadata = metadata;
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

    const nextService = new SimpleEmbeddingService(createSimpleEmbeddingServiceOptions(options));
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
      compositeKey: targetCompositeKey,
      message,
      modelId: targetModelId,
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
      compositeKey: targetCompositeKey,
      message,
      modelId: targetModelId,
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
      activeModelId,
      forceReinit,
      shouldInitializeCurrentModel,
      shouldReinitialize,
      targetModelId,
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
      modelId,
      text: texts,
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
        embeddingSetDimension: setDimension,
        embeddingSetId: targetSetId,
        payload: payload.expectedDimension,
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

  async function handleBatchFailure(
    jobs: ClaimedJob[],
    error: unknown,
    onJobsFailed?: (jobIds: Set<string>) => void
  ) {
    // LOG THE ERROR so we can see what's happening
    workerLogger.error('handleBatchFailure: Job(s) failed', {
      error: error instanceof Error ? error.message : String(error),
      jobCount: jobs.length,
      jobIds: jobs.map((j) => j.id).slice(0, 5), // First 5 job IDs
      stack: error instanceof Error ? error.stack : undefined,
    });

    const { backoffMs, isTerminal, truncated } = classifyFailure(error);

    // Fail all jobs in one batched call (2-3 queries instead of 2N)
    await jq.failBatch({
      error: truncated,
      jobs: jobs.map((j) => ({ id: j.id, leaseToken: j.lease_token })),
      terminal: isTerminal,
      ...(backoffMs === undefined ? {} : { backoffMs }),
    });
    onJobsFailed?.(new Set(jobs.map((job) => job.id)));

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
    const jobCompletions: Array<{
      chunkId: string;
      embedding: number[];
      embeddingHash: string;
      embeddingSetId: string;
      id: string;
      leaseToken: string;
    }> = [];

    for (let index = 0; index < toProcess.length; index++) {
      const item = toProcess[index];
      const embedding = embeddings[index];
      if (!(item && embedding)) {
        throw new Error(`Missing item or embedding at index ${index} in batch.`);
      }
      const targetSetId = resolveTargetSetId(item.payload);
      jobCompletions.push({
        chunkId: item.chunk.id,
        embedding,
        embeddingHash: item.expectedHash,
        embeddingSetId: targetSetId,
        id: item.job.id,
        leaseToken: item.job.lease_token,
      });
    }

    let completedJobs: Job[] = [];
    if (jobCompletions.length > 0) {
      completedJobs = await jq.completeEmbeddingChunkBatch(jobCompletions);
    }

    for (const job of completedJobs) {
      completedJobIds.add(job.id);
    }
    onJobsCompleted?.(completedJobIds);
    const completedEmbeddingSetIds = completedJobs
      .map((job) => job.embedding_set_id)
      .filter((embeddingSetId): embeddingSetId is string => typeof embeddingSetId === 'string');
    const completedEmbeddingSetCount = new Set(completedEmbeddingSetIds).size;
    log('embedding_completion_batch', {
      completedJobCount: completedJobIds.size,
      embeddingSetCount: completedEmbeddingSetCount,
      updateCount: completedJobs.length,
    });
    try {
      await statsRefreshController.recordCompletions(
        completedEmbeddingSetIds,
        completedJobs.length
      );
      await statsRefreshController.flushIfDue();
    } catch (error) {
      workerLogger.warn('Failed to update embedding completion stats', {
        completedChunkCount: completedJobs.length,
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
    metrics.jobsProcessed += newlyCompleted.size;
    processedSinceInit += newlyCompleted.size;
    consecutiveFailures = 0;
  }

  function estimateEmbeddingBytes(embeddings: readonly number[][]): number {
    return embeddings.reduce((total, embedding) => total + embedding.length * 4, 0);
  }

  function createStreamingCompletionWriter(
    capacity: EmbeddingWorkerPipelineCapacity,
    completedJobIds: Set<string>,
    onJobsCompleted?: (jobIds: Set<string>) => void
  ): {
    enqueue: (
      toProcess: LoadedChunkItem[],
      embeddings: number[][],
      options?: {
        afterComplete?: (
          completedItems: LoadedChunkItem[],
          completedEmbeddings: number[][]
        ) => void;
        inferenceMs?: number;
      }
    ) => Promise<void>;
    flush: () => Promise<void>;
  } {
    let pendingBatches = 0;
    let pendingBytes = 0;
    let pendingChunks = 0;
    let completionChain: Promise<void> = Promise.resolve();
    let firstFailure: unknown = null;
    const capacityWaiters = new Set<() => void>();

    const notifyCapacity = () => {
      for (const waiter of capacityWaiters) {
        waiter();
      }
      capacityWaiters.clear();
    };

    const throwIfFailed = () => {
      if (firstFailure) {
        throw firstFailure;
      }
    };

    const splitCompletionBatch = (
      toProcess: LoadedChunkItem[],
      embeddings: number[][]
    ): Array<{ embeddings: number[][]; toProcess: LoadedChunkItem[] }> => {
      const slices: Array<{ embeddings: number[][]; toProcess: LoadedChunkItem[] }> = [];
      let sliceStart = 0;
      let sliceBytes = 0;
      let sliceChunks = 0;

      for (let index = 0; index < embeddings.length; index += 1) {
        const embedding = embeddings[index];
        if (!embedding) {
          throw new Error(`Invalid input: streamed completion batch missing embedding ${index}.`);
        }
        const embeddingBytes = embedding.length * 4;
        if (embeddingBytes > capacity.maxPendingCompletionBytes) {
          throw new Error(
            `Invalid input: streamed completion item has ${embeddingBytes} byte(s), exceeding maxPendingCompletionBytes=${capacity.maxPendingCompletionBytes}.`
          );
        }
        if (
          sliceChunks > 0 &&
          (sliceChunks + 1 > capacity.maxPendingCompletionChunks ||
            sliceBytes + embeddingBytes > capacity.maxPendingCompletionBytes)
        ) {
          slices.push({
            embeddings: embeddings.slice(sliceStart, index),
            toProcess: toProcess.slice(sliceStart, index),
          });
          sliceStart = index;
          sliceBytes = 0;
          sliceChunks = 0;
        }
        sliceBytes += embeddingBytes;
        sliceChunks += 1;
      }

      if (sliceChunks > 0) {
        slices.push({
          embeddings: embeddings.slice(sliceStart),
          toProcess: toProcess.slice(sliceStart),
        });
      }

      return slices;
    };

    const waitForCapacity = async (chunkCount: number, byteCount: number): Promise<void> => {
      if (chunkCount > capacity.maxPendingCompletionChunks) {
        throw new Error(
          `Invalid input: streamed completion batch has ${chunkCount} chunk(s), exceeding maxPendingCompletionChunks=${capacity.maxPendingCompletionChunks}.`
        );
      }
      if (byteCount > capacity.maxPendingCompletionBytes) {
        throw new Error(
          `Invalid input: streamed completion batch has ${byteCount} byte(s), exceeding maxPendingCompletionBytes=${capacity.maxPendingCompletionBytes}.`
        );
      }
      while (
        pendingBatches > 0 &&
        (pendingBatches + 1 > capacity.maxPendingCompletionBatches ||
          pendingChunks + chunkCount > capacity.maxPendingCompletionChunks ||
          pendingBytes + byteCount > capacity.maxPendingCompletionBytes)
      ) {
        throwIfFailed();
        await new Promise<void>((resolve) => {
          capacityWaiters.add(resolve);
        });
      }
      throwIfFailed();
    };

    return {
      async enqueue(toProcess, embeddings, enqueueOptions): Promise<void> {
        const completionSlices = splitCompletionBatch(toProcess, embeddings);
        for (const slice of completionSlices) {
          await enqueueSlice(slice.toProcess, slice.embeddings, enqueueOptions);
        }
      },
      async flush(): Promise<void> {
        await completionChain;
        throwIfFailed();
      },
    };

    async function enqueueSlice(
      toProcess: LoadedChunkItem[],
      embeddings: number[][],
      enqueueOptions:
        | {
            afterComplete?: (
              completedItems: LoadedChunkItem[],
              completedEmbeddings: number[][]
            ) => void;
            inferenceMs?: number;
          }
        | undefined
    ): Promise<void> {
      const chunkCount = toProcess.length;
      const byteCount = estimateEmbeddingBytes(embeddings);
      await waitForCapacity(chunkCount, byteCount);

      const acceptedAt = performance.now();
      pendingBatches += 1;
      pendingChunks += chunkCount;
      pendingBytes += byteCount;

      const run = completionChain.then(async () => {
        const completionStartedAt = performance.now();
        try {
          await completeBatchAndTrack(toProcess, embeddings, completedJobIds, onJobsCompleted);
          enqueueOptions?.afterComplete?.(toProcess, embeddings);
        } catch (error) {
          firstFailure ??= error;
          throw error;
        } finally {
          const completionFinishedAt = performance.now();
          pendingBatches = Math.max(0, pendingBatches - 1);
          pendingChunks = Math.max(0, pendingChunks - chunkCount);
          pendingBytes = Math.max(0, pendingBytes - byteCount);
          log('embedding_pipeline_timing', {
            completeJobsMs: Math.round(completionFinishedAt - completionStartedAt),
            completionWaitMs: Math.round(completionStartedAt - acceptedAt),
            dbWriteMs: Math.round(completionFinishedAt - completionStartedAt),
            device: latestRuntimeMetadata?.device ?? null,
            dtype: latestRuntimeMetadata?.dtype ?? null,
            inferenceMs: Math.round(enqueueOptions?.inferenceMs ?? 0),
            pendingCompletionBatches: pendingBatches,
            pendingCompletionChunks: pendingChunks,
            schedulerWaitMs: 0,
            streamBatchSize: chunkCount,
          });
          notifyCapacity();
        }
      });
      completionChain = run.catch(() => undefined);
      run.catch(() => undefined);
    }
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
    const pipelineCapacity = await resolveEffectivePipelineCapacity();
    const completionWriter = createStreamingCompletionWriter(
      pipelineCapacity,
      completedJobIds,
      onJobsCompleted
    );
    let lastStreamBatchFinishedAt = performance.now();
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
      await completionWriter.enqueue(cacheHitItems, cachedEmbeddings);
    }

    if (cacheMisses.length === 0) {
      await completionWriter.flush();
      await maybeReinitialize();
      return;
    }

    await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
    failFastOnLatchedLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey);
    const streamingService = assertStreamingService(service);

    try {
      const streamStartedAt = performance.now();
      lastStreamBatchFinishedAt = streamStartedAt;
      const runtimeMetadata = await runWithWorkerActivity(async () =>
        streamingService.generateEmbeddingsStream(
          cacheMisses.map((item) => item.chunk.content),
          async (batch) => {
            const batchFinishedAt = performance.now();
            const inferenceMs = batchFinishedAt - lastStreamBatchFinishedAt;
            lastStreamBatchFinishedAt = batchFinishedAt;
            if (checkLease()) {
              throw new LocalEmbeddingStreamCallbackError(
                new Error('Lease lost during processing')
              );
            }

            const batchItems = cacheMisses.slice(batch.startIndex, batch.endIndex);
            if (batchItems.length !== batch.results.length) {
              throw new Error(
                `Local embedding stream batch mismatch: ${batchItems.length} items for ${batch.results.length} results.`
              );
            }
            reportRuntimeMetadata(batch.results.find((result) => result.runtime)?.runtime);

            const embeddings = batch.results.map((result, index) => {
              if (
                !Array.isArray(result.embedding) ||
                result.embedding.length !== expectedDimension
              ) {
                throw new Error(
                  `Embedding dimension mismatch for model '${jobModel.compositeKey}' batch item ${batch.startIndex + index}: received ${result.embedding.length}, expected ${expectedDimension}.`
                );
              }
              return result.embedding;
            });

            try {
              await completionWriter.enqueue(batchItems, embeddings, {
                afterComplete: (completedItems, completedEmbeddings) => {
                  storeToCacheAsync(
                    options.embeddingCache,
                    completedItems,
                    completedEmbeddings,
                    modelKey,
                    expectedDimension,
                    trackCacheWrite
                  );
                },
                inferenceMs,
              });
            } catch (error) {
              throw new LocalEmbeddingStreamCallbackError(error);
            }
          },
          shouldOverrideStreamBatchSize
            ? { streamBatchSize: pipelineCapacity.streamBatchSize }
            : undefined
        )
      );
      reportRuntimeMetadata(parseRuntimeMetadata(runtimeMetadata));
    } catch (error) {
      if (error instanceof LocalEmbeddingStreamCallbackError) {
        throw error.originalError instanceof Error ? error.originalError : error;
      }
      throw latchLocalModelExecutionFailure(jobModel.modelId, jobModel.compositeKey, error);
    }

    await completionWriter.flush();
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
    onJobsSettled?: (jobIds: Set<string>) => void
  ) {
    const { toProcess, completed, orphanCount, staleCount } = await loadAndFilterChunks(jobs, {
      db: options.db,
      failTerminalJobs: async (terminalJobs, error) => {
        await jq.failBatch({ error, jobs: terminalJobs, terminal: true });
        onJobsSettled?.(new Set(terminalJobs.map((job) => job.id)));
      },
      fileChunkIdType,
      logWarn: (message, meta) => workerLogger.warn(message, meta),
    });
    metrics.jobsFailed += orphanCount + staleCount;
    const completedJobIds = new Set<string>(completed.map((item) => item.job.id));

    try {
      if (checkLease()) {
        throw new Error('Lease lost during processing');
      }

      await markAlreadyCompleted(completed, completedJobIds, onJobsSettled);

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
          onJobsSettled
        );
      } else {
        const embeddings = await runWithWorkerActivity(async () =>
          generateEmbeddingsForGroup(jobModel, toProcess, expectedDimension)
        );

        if (checkLease()) {
          throw new Error('Lease lost during processing');
        }

        await completeBatchAndTrack(toProcess, embeddings, completedJobIds, onJobsSettled);
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
    if (latestRuntimeMetadata?.device === 'webgpu') {
      processedSinceInit = 0;
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

  async function resolveGroupJobModelOrFail(
    jobs: ClaimedJob[],
    onJobsSettled?: (jobIds: Set<string>) => void
  ): Promise<EmbeddingJobModel | null> {
    const firstJob = jobs[0];
    if (!firstJob) {
      return null;
    }
    try {
      const payload = assertEmbedChunkJob(firstJob);
      return resolveJobModel(payload);
    } catch (err) {
      await handleBatchFailure(jobs, err, onJobsSettled);
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
    checkLease: () => boolean,
    onJobsSettled?: (jobIds: Set<string>) => void
  ): Promise<void> {
    if (checkLease()) {
      workerLogger.warn('Aborting batch processing due to lost lease');
      return;
    }
    if (error instanceof JobProcessingError) {
      await handleBatchFailure(error.remainingJobs, error.originalError ?? error, onJobsSettled);
      return;
    }
    await handleBatchFailure(jobs, error, onJobsSettled);
  }

  async function processGroup(
    jobs: ClaimedJob[],
    checkLeaseOverride?: () => boolean,
    onJobsSettled?: (jobIds: Set<string>) => void
  ): Promise<void> {
    if (jobs.length === 0) {
      return;
    }

    const jobModel = await resolveGroupJobModelOrFail(jobs, onJobsSettled);
    if (!jobModel) {
      return;
    }

    const lease = createLeaseTracker(jobs, checkLeaseOverride);
    const markJobsCompleted = (jobIds: Set<string>) => {
      lease.markCompleted(jobIds);
      onJobsSettled?.(jobIds);
    };

    try {
      await processJobGroup(jobs, jobModel, lease.checkLease, markJobsCompleted);
    } catch (error) {
      await handleGroupError(error, jobs, lease.checkLease, onJobsSettled);
    } finally {
      lease.dispose();
    }
  }

  function groupJobs(
    jobs: ClaimedJob[],
    onJobsSettled?: (jobIds: Set<string>) => void
  ): {
    failureWrites: Promise<void>[];
    groups: Map<string, ClaimedJob[]>;
  } {
    const groups = new Map<string, ClaimedJob[]>();
    const failureWrites: Promise<void>[] = [];
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
        failureWrites.push(
          jq
            .fail({
              error: err instanceof Error ? err.message : String(err),
              id: job.id,
              leaseToken: job.lease_token,
            })
            .then(() => {
              onJobsSettled?.(new Set([job.id]));
            })
            .catch((error: unknown) => {
              workerLogger.error('Failed to fail job', { error });
            })
        );
        metrics.jobsFailed += 1;
      }
    }
    return { failureWrites, groups };
  }

  async function processClaimedJobs(
    jobs: ClaimedJob[],
    onJobsSettled?: (jobIds: Set<string>) => void
  ) {
    const leaseLost = new Set<string>();
    const batchHeartbeat = startHeartbeat(jobs, (job) => {
      leaseLost.add(job.id);
    });
    const markJobsSettled = (jobIds: Set<string>) => {
      batchHeartbeat.markCompleted(jobIds);
      onJobsSettled?.(jobIds);
    };

    try {
      const { failureWrites, groups } = groupJobs(jobs, markJobsSettled);
      for (const group of groups.values()) {
        const checkLease = () => group.some((job) => leaseLost.has(job.id));
        if (checkLease()) {
          workerLogger.warn('Skipping group due to lost lease before processing', {
            jobIds: group.map((job) => job.id),
          });
          continue;
        }
        await processGroup(group, checkLease, markJobsSettled);
      }
      await Promise.all(failureWrites);
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
    await sleepUnlessStopped(currentIdleDelayMs, stopController.signal);
  }

  function isClosedDatabaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('PGlite is closed') || message.includes('closed');
  }

  async function processBatch(): Promise<void> {
    const batchStart = performance.now();
    let heldInFlightSlots = 0;
    try {
      await waitForInFlightBudget();
      if (!running) {
        return;
      }
      await waitForBackgroundPermit('embedding claim');
      const effectiveClaimBatchSize = await resolveEffectiveClaimBatchSize();
      if (effectiveClaimBatchSize === null) {
        await sleepUnlessStopped(CLAIM_SIZE_RESOLVER_RETRY_BACKOFF_MS, stopController.signal);
        return;
      }
      heldInFlightSlots = reserveInFlightJobs(effectiveClaimBatchSize);
      if (heldInFlightSlots === 0) {
        await waitForInFlightBudget();
        return;
      }
      // Claim a batch of jobs
      const jobs = await jq.claimMany({
        leaseMs,
        limit: heldInFlightSlots,
        queue: queueName,
        workerId,
      });
      if (jobs.length > heldInFlightSlots) {
        throw new Error(
          `Embedding queue claimed ${jobs.length} jobs for ${heldInFlightSlots} reserved in-flight slots.`
        );
      }

      const unusedSlots = heldInFlightSlots - jobs.length;
      releaseInFlightJobs(unusedSlots);
      heldInFlightSlots -= unusedSlots;

      if (jobs.length === 0) {
        await handleIdleBatch();
        return;
      }

      resetIdleBackoff();
      const unsettledJobIds = new Set(jobs.map((job) => job.id));
      await processClaimedJobs(jobs, (jobIds) => {
        let releasedCount = 0;
        for (const jobId of jobIds) {
          if (unsettledJobIds.delete(jobId)) {
            releasedCount += 1;
          }
        }
        releaseInFlightJobs(releasedCount);
        heldInFlightSlots -= releasedCount;
      });

      // Yield between batches to let V8/GC and the foreground renderer breathe
      // under sustained background embedding load.
      if (running) {
        await sleepUnlessStopped(interBatchDelayMs, stopController.signal);
      }
    } catch (err) {
      if (isClosedDatabaseError(err)) {
        running = false; // Stop the worker loop
        return;
      }
      workerLogger.error('Critical worker error in processBatch', { error: err });
      await sleepUnlessStopped(1000, stopController.signal);
    } finally {
      releaseInFlightJobs(heldInFlightSlots);
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
        avgDurationMs: Math.round(avgMs),
        claimBatchSize,
        concurrency,
        effectiveClaimBatchSize: lastClaimBatchSize,
        effectiveClaimBatchSizeError: lastClaimBatchSizeError,
        failed: metrics.jobsFailed,
        inFlightJobs,
        interBatchDelayMs,
        maxInFlightJobs,
        modelKey: activeCompositeKey,
        processed: metrics.jobsProcessed,
        queue: queueName,
        uptimeMs,
      });
    },
    Math.max(5000, metricsInterval)
  );

  return {
    stop: async () => {
      running = false;
      stopController.abort();
      notifyInFlightBudgetWaiters();
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
