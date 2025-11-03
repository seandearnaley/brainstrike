import type { IDatabase } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import type { ProviderDimensionParameter } from '@brainstrike/queue';
import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { generateUUID } from '@brainstrike/utils';
import { SimpleEmbeddingService } from '../bge-m3-service';
import { EmbeddingProviderFactory } from '../factory';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderType,
} from '../provider-types';
import { formatProviderModelKey, isHostedProvider, parseProviderModelKey } from '../provider-utils';
import type { EmbeddingResult, EmbeddingService, ModelConfig } from '../types';

type Distance = 'cosine' | 'l2' | 'ip';

type SupportedHostedProvider = Extract<EmbeddingProviderType, 'openai' | 'google'>;
type HostedProviderConfig = Extract<
  EmbeddingProviderConfig,
  { runtime: 'hosted'; provider: SupportedHostedProvider }
>;

export type EmbeddingWorkerOptions = {
  db: IDatabase;
  queue?: string; // default: 'embeddings'
  concurrency?: number; // default: 1..4
  leaseMs?: number; // default: 60000
  heartbeatIntervalMs?: number; // default: 10000
  modelKey?: string | undefined; // default: registry default
  distance?: Distance; // default: 'cosine'
  workerId?: string; // optional
  log?: (msg: string, meta?: unknown) => void;
  service?: EmbeddingService; // optional DI for tests or custom backends
  metricsIntervalMs?: number; // optional metrics log interval; default env or 30000
  enable?: boolean; // explicit runtime toggle; overrides env flag
  device?: 'webgpu' | 'wasm' | 'cpu'; // preferred device for transformers backend
  reinitEveryN?: number; // reinitialize service every N successes (default from env or 200)
  forceCpuAfterFailures?: number; // switch to CPU after consecutive failures (default 3)
};

export type EmbeddingWorkerController = {
  stop: () => Promise<void>;
};

type EmbedChunkPayload = {
  chunkId: string;
  fileRecordId?: string;
  embeddingSetId?: string | null;
  expectedDimension?: number; // Expected embedding dimension; falls back to model metadata when omitted
  modelKey?: string | null;
  provider?: EmbeddingProviderType | null;
  dimensionParameter?: ProviderDimensionParameter | null;
};

async function sha256Hex(input: string): Promise<string> {
  try {
    // Use Web Crypto when available
    if ('crypto' in globalThis && globalThis.crypto?.subtle) {
      const subtle = globalThis.crypto.subtle;
      const data = new TextEncoder().encode(input);
      const digest = await subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // fall through to node path
  }
  // Node crypto path (Node 16+)
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

async function loadChunk(db: IDatabase, id: string) {
  const res = await db.query<{
    id: string;
    content: string;
    contentHash: string;
    embeddingHash?: string | null;
    embeddingSetId?: string | null;
  }>(
    `SELECT id, content, content_hash AS "contentHash", embedding_hash AS "embeddingHash", embedding_set_id AS "embeddingSetId"
     FROM file_chunks WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

async function updateChunkEmbedding(
  db: IDatabase,
  id: string,
  embedding: number[],
  embeddingSetId: string,
  embeddingHash: string,
  vectorEnabled: boolean
) {
  const now = new Date().toISOString();
  const vectorString = `[${embedding.join(',')}]`;
  const sql = vectorEnabled
    ? `UPDATE file_chunks SET
         embedding = $1::vector,
         embedding_set_id = $2,
         embedding_updated_at = $3,
         embedding_hash = $4,
         updated_at = $3
       WHERE id = $5`
    : `UPDATE file_chunks SET
         embedding = $1,
         embedding_set_id = $2,
         embedding_updated_at = $3,
         embedding_hash = $4,
         updated_at = $3
       WHERE id = $5`;
  await db.query(sql, [vectorString, embeddingSetId, now, embeddingHash, id]);
}

const embeddingSetDimensionCache = new Map<string, number>();

async function resolveEmbeddingSetDimension(
  db: IDatabase,
  embeddingSetId: string
): Promise<number> {
  const cached = embeddingSetDimensionCache.get(embeddingSetId);
  if (typeof cached === 'number') {
    return cached;
  }

  const res = await db.query<{ dimensions?: number }>(
    'SELECT dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
    [embeddingSetId]
  );
  const raw = res.rows[0]?.dimensions;
  const dimension = typeof raw === 'number' ? raw : Number(raw ?? 0);
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Embedding set ${embeddingSetId} is missing valid dimension metadata.`);
  }
  embeddingSetDimensionCache.set(embeddingSetId, dimension);
  return dimension;
}

function resolveWorkerModel(fromOptions?: string): {
  provider: EmbeddingProviderType;
  modelId: string;
  compositeKey: string;
} {
  const envValue = (() => {
    try {
      if (process?.env?.['EMBED_MODEL_KEY']) {
        return String(process.env['EMBED_MODEL_KEY']);
      }
      return '';
    } catch {
      return '';
    }
  })();

  const candidate = fromOptions || envValue || SimpleEmbeddingService.getDefaultModelKey();
  const parsed = parseProviderModelKey(candidate);

  if (parsed) {
    return {
      provider: parsed.provider,
      modelId: parsed.modelId,
      compositeKey: candidate,
    };
  }

  return {
    provider: 'local',
    modelId: candidate,
    compositeKey: formatProviderModelKey('local', candidate),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isNodejsMainProcess(): boolean {
  // Check if we're in a Node.js environment (not browser)
  try {
    return (
      typeof process !== 'undefined' &&
      typeof process.versions?.node !== 'undefined' &&
      typeof window === 'undefined'
    );
  } catch {
    return false;
  }
}

function ensureLocalRuntime(modelResolution: { provider: EmbeddingProviderType }): void {
  // CRITICAL FIX: Local transformers models require Web Workers to avoid blocking execution.
  // In Electron main process (Node.js), Web Workers don't exist, causing TransformersBackend
  // to fall back to synchronous execution which blocks the entire app.
  if (modelResolution.provider === 'local' && isNodejsMainProcess()) {
    throw new Error(
      'Cannot use local embedding models in Node.js/Electron main process. ' +
        'TransformersBackend requires Web Workers which are only available in browser contexts. ' +
        'Use a hosted provider (openai, google) or process embeddings in the renderer.'
    );
  }
}

function shouldStartWorker(
  options: EmbeddingWorkerOptions,
  log: (msg: string, meta?: unknown) => void
): boolean {
  // Allow explicit disable via options (for tests)
  if (options.enable === false) {
    log('Embedding worker disabled via options.enable=false');
    return false;
  }

  return true;
}

function toSupportedHostedProvider(
  provider: Exclude<EmbeddingProviderType, 'local'>
): SupportedHostedProvider {
  if (provider === 'openai' || provider === 'google') {
    return provider;
  }
  throw new Error(`Hosted provider "${provider}" is not supported yet.`);
}

function buildHostedProviderConfig(
  provider: SupportedHostedProvider,
  modelId: string,
  expectedDimension: number
): HostedProviderConfig {
  switch (provider) {
    case 'openai':
      return {
        runtime: 'hosted',
        provider: 'openai',
        modelId,
        dimensions: expectedDimension,
      };
    case 'google':
      return {
        runtime: 'hosted',
        provider: 'google',
        modelId,
        outputDimensionality: expectedDimension,
      };
    default:
      throw new Error(`Hosted provider "${provider}" is not supported yet.`);
  }
}

function formatHostedInitializationError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  let reason = 'unavailable';
  if (error.type === 'missing_api_key') {
    reason = 'missing API key';
  } else if (error.type === 'validation_error') {
    reason = error.message;
  }
  return `Failed to initialize provider "${provider}" (${reason}).`;
}

async function createHostedProviderInstance(
  provider: SupportedHostedProvider,
  config: HostedProviderConfig
) {
  const providerResult = await EmbeddingProviderFactory.createProvider(config);
  if (!providerResult.ok) {
    throw new Error(formatHostedInitializationError(provider, providerResult.error));
  }
  return providerResult.value;
}

function formatHostedEmbedError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  switch (error.type) {
    case 'api_error':
      return `Hosted provider "${provider}" API error (${error.statusCode}): ${error.message}`;
    case 'rate_limit_exceeded':
      return `Hosted provider "${provider}" rate limit exceeded.`;
    case 'missing_api_key':
      return `Hosted provider "${provider}" missing API key.`;
    default:
      return `Hosted provider "${provider}" error: ${error.type}.`;
  }
}

function validateHostedEmbeddingDimensions(
  provider: SupportedHostedProvider,
  modelId: string,
  embedding: number[],
  expectedDimension: number
): void {
  if (!Array.isArray(embedding) || embedding.length !== expectedDimension) {
    throw new Error(
      `Embedding dimension mismatch for hosted provider '${provider}' model '${modelId}': received ${embedding.length}, expected ${expectedDimension}.`
    );
  }
}

async function initializeEmbeddingService(
  options: EmbeddingWorkerOptions,
  modelKey: string
): Promise<{ service: EmbeddingService; modelConfig: ModelConfig }> {
  const service = options.service ?? new SimpleEmbeddingService();

  // Only initialize if we created the default service
  if (!options.service) {
    // Initialize with the requested model key
    const simpleService = service as SimpleEmbeddingService;
    if (typeof simpleService.initializeWithModel === 'function') {
      await simpleService.initializeWithModel(modelKey, undefined, options.device);
    } else {
      await service.initialize?.({}, undefined);
    }
  }

  // Get model config - if using custom service, determine dimensions first
  let modelConfig = SimpleEmbeddingService.getModelConfig(modelKey);
  if (!modelConfig && options.service) {
    // For custom services, generate a test embedding to get dimensions
    const serviceConfig = service.getConfig();
    const testEmbedding = await service.generateEmbedding('test');
    modelConfig = {
      id: serviceConfig.modelId || 'custom-model',
      name: 'Custom Service Model',
      dimensions: testEmbedding.embedding.length,
      quantized: false,
      description: 'Custom embedding service model',
      tags: ['custom'],
      origin: 'custom',
      size: 'unknown',
    };
  }
  if (!modelConfig) throw new Error(`Model config not found for key: ${modelKey}`);

  return { service, modelConfig };
}

/**
 * Validates the dimension metadata returned by the embedding service.
 * Ensures the size is finite, within pgvector's limits, and emits telemetry when we diverge
 * from the historical 768D default so downstream consumers can react.
 */
function ensureModelDimension(
  modelConfig: ModelConfig,
  modelKey: string,
  log: (msg: string, meta?: unknown) => void
): number {
  const dimensions = Number(modelConfig.dimensions);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    const errorMsg = `Model '${modelKey}' reported an invalid embedding dimension (${modelConfig.dimensions}).`;
    log('worker_model_dimension_invalid', {
      modelKey,
      dimensions: modelConfig.dimensions,
    });
    throw new Error(errorMsg);
  }

  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_warning', {
      modelKey,
      dimensions,
      message: `pgvector supports up to ${MAX_EMBEDDING_DIMENSION} dimensions; verify provider settings.`,
    });
    throw new Error(
      `Model '${modelKey}' exceeds the supported embedding dimension limit (${MAX_EMBEDDING_DIMENSION}). Received ${dimensions}.`
    );
  }

  if (dimensions !== DEFAULT_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_notice', {
      modelKey,
      dimensions,
      default: DEFAULT_EMBEDDING_DIMENSION,
    });
  }

  return dimensions;
}

export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  const log = options.log || (() => {});

  // Check if worker is disabled BEFORE resolving model to avoid errors in tests
  if (!shouldStartWorker(options, log)) {
    return { stop: async () => {} };
  }

  const queueName = options.queue ?? 'embeddings';
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const modelResolution = resolveWorkerModel(options.modelKey);
  ensureLocalRuntime(modelResolution);
  let activeModelId = modelResolution.modelId;
  let activeCompositeKey = modelResolution.compositeKey;
  const workerId = options.workerId ?? `embed-worker-${generateUUID().slice(0, 8)}`;

  let { service, modelConfig } = await initializeEmbeddingService(options, activeModelId);
  let activeModelDimension = ensureModelDimension(modelConfig, activeCompositeKey, log);

  // REMOVED: Worker no longer auto-creates embedding sets on startup
  // Collections should ONLY be created by the user via the Create Collection dialog
  // The worker will use embeddingSetId from job payloads (see resolveTargetSetId function)

  const jq = new JobQueue(options.db);
  let running = true;

  // Detect pgvector availability once for write path
  let vectorEnabledForWrites = false;
  try {
    const res = await options.db.query<{ one: number }>(
      "SELECT 1 as one FROM pg_extension WHERE extname = 'vector'"
    );
    vectorEnabledForWrites = Array.isArray(res.rows) && res.rows.length > 0;
  } catch {
    vectorEnabledForWrites = false;
  }

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
  const reinitEveryN = Number(
    options.reinitEveryN ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } })?.process?.env?.[
        'EMBED_REINIT_EVERY'
      ] ??
      100
  );
  const forceCpuAfterFailures = Math.max(1, options.forceCpuAfterFailures ?? 3);

  async function ensureLocalModel(
    targetModelId: string,
    targetCompositeKey: string,
    opts?: { forceReinit?: boolean; forceCpu?: boolean }
  ): Promise<void> {
    const forceReinit = opts?.forceReinit ?? false;
    const forceCpu = opts?.forceCpu ?? false;
    const shouldReinitialize = forceCpu || forceReinit || targetModelId !== activeModelId;

    console.log('[EMBED-WORKER] ensureLocalModel check', {
      targetModelId,
      activeModelId,
      shouldReinitialize,
      forceReinit,
      forceCpu,
    });

    if (!shouldReinitialize) {
      return;
    }

    // CRITICAL FIX: In Electron main process, TransformersBackend tries to create Web Workers
    // which don't exist in Node.js. This causes it to fall back to synchronous execution,
    // blocking the entire app. Reject model switching for local providers.
    if (targetModelId !== activeModelId) {
      throw new Error(
        `Cannot switch local embedding models in main process (from ${activeModelId} to ${targetModelId}). ` +
          'Web Workers are not available in Node.js/Electron main process. ' +
          `Either process this job in the renderer, or ensure all jobs use the same local model: ${activeModelId}`
      );
    }

    console.log('[EMBED-WORKER] REINITIALIZING SERVICE - this blocks the main thread!');

    try {
      await service.dispose();
    } catch {}

    const device = forceCpu ? 'cpu' : options.device;
    const nextService = new SimpleEmbeddingService();
    await nextService.initializeWithModel(targetModelId, undefined, device);
    service = nextService;

    const cfg = SimpleEmbeddingService.getModelConfig(targetModelId);
    if (!cfg) {
      throw new Error(`Model config not found for key: ${targetModelId}`);
    }
    modelConfig = cfg;

    activeModelId = targetModelId;
    activeCompositeKey = targetCompositeKey;

    const refreshedDimension = ensureModelDimension(modelConfig, activeCompositeKey, log);
    activeModelDimension = refreshedDimension;

    // REMOVED: Worker no longer auto-creates embedding sets when switching models
    // Collections should ONLY be created by the user via the Create Collection dialog
    // The worker will use embeddingSetId from job payloads (see resolveTargetSetId function)

    processedSinceInit = 0;
    consecutiveFailures = 0;
  }

  async function resetService(forceCpu = false) {
    await ensureLocalModel(activeModelId, activeCompositeKey, {
      forceReinit: true,
      forceCpu,
    });
  }

  type ClaimedJob = NonNullable<Awaited<ReturnType<typeof jq.claim>>>;

  async function generateLocalEmbedding(
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>,
    expectedDimension: number
  ): Promise<EmbeddingResult> {
    if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Invalid expected embedding dimension (${expectedDimension}).`);
    }

    console.log('[EMBED-WORKER] Calling service.generateEmbedding - THIS MAY BLOCK MAIN THREAD!', {
      contentLength: chunk.content.length,
      expectedDimension,
    });

    const svcAny = service as unknown as {
      generateDocEmbedding?: (t: string) => Promise<EmbeddingResult>;
      generateEmbedding: (t: string) => Promise<EmbeddingResult>;
    };
    const result = svcAny.generateDocEmbedding
      ? await svcAny.generateDocEmbedding(chunk.content)
      : await service.generateEmbedding(chunk.content);

    console.log('[EMBED-WORKER] service.generateEmbedding completed');

    if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch for model '${activeCompositeKey}': received ${result.embedding.length}, expected ${expectedDimension}. ` +
          'Verify provider configuration (dimension/size parameter) and retry.'
      );
    }

    return result;
  }

  function resolveJobModel(payload: EmbedChunkPayload): {
    compositeKey: string;
    provider: EmbeddingProviderType;
    modelId: string;
  } {
    const rawModelKey = payload.modelKey ?? undefined;
    const providerHint = payload.provider ?? undefined;

    const candidateComposite = (() => {
      if (!rawModelKey) {
        return undefined;
      }
      const parsed = parseProviderModelKey(rawModelKey);
      if (parsed) {
        return rawModelKey;
      }
      if (providerHint && isHostedProvider(providerHint)) {
        return formatProviderModelKey(providerHint, rawModelKey);
      }
      return rawModelKey;
    })();

    const compositeKey = candidateComposite ?? activeCompositeKey;
    const parsed = parseProviderModelKey(compositeKey);

    if (parsed) {
      return {
        compositeKey,
        provider: parsed.provider,
        modelId: parsed.modelId,
      };
    }

    return {
      compositeKey,
      provider: 'local',
      modelId: compositeKey,
    };
  }

  async function generateHostedEmbedding(
    provider: Exclude<EmbeddingProviderType, 'local'>,
    modelId: string,
    expectedDimension: number,
    text: string
  ): Promise<number[]> {
    const supportedProvider = toSupportedHostedProvider(provider);
    const config = buildHostedProviderConfig(supportedProvider, modelId, expectedDimension);
    const providerInstance = await createHostedProviderInstance(supportedProvider, config);
    const embedResult = await providerInstance.embed({ text, modelId });
    if (!embedResult.ok) {
      throw new Error(formatHostedEmbedError(supportedProvider, embedResult.error));
    }

    const embedding = embedResult.value.embedding;
    validateHostedEmbeddingDimensions(supportedProvider, modelId, embedding, expectedDimension);

    return embedding;
  }

  function assertEmbedChunkJob(claimed: ClaimedJob): EmbedChunkPayload {
    if (claimed.jobType !== 'embed_chunk') {
      throw new Error(`Unsupported job type: ${claimed.jobType}`);
    }
    const payload = (claimed.payload || {}) as EmbedChunkPayload;
    if (!payload.chunkId) {
      throw new Error('Missing chunkId in payload');
    }
    return payload;
  }

  async function loadChunkOrThrow(
    chunkId: string
  ): Promise<NonNullable<Awaited<ReturnType<typeof loadChunk>>>> {
    const chunk = await loadChunk(options.db, chunkId);
    if (!chunk) {
      throw new Error(`Chunk not found: ${chunkId}`);
    }
    return chunk;
  }

  function resolveTargetSetId(
    payload: EmbedChunkPayload,
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>
  ): string {
    const targetSetId = payload.embeddingSetId ?? chunk.embeddingSetId;
    if (!targetSetId) {
      throw new Error(
        'Job payload missing embeddingSetId. Jobs must specify which collection to use. ' +
          'Collections should be created via the Create Collection dialog before enqueueing jobs.'
      );
    }
    return targetSetId;
  }

  async function determineExpectedDimension(
    targetSetId: string,
    payload: EmbedChunkPayload
  ): Promise<number> {
    const setDimension = await resolveEmbeddingSetDimension(options.db, targetSetId);
    if (
      typeof payload.expectedDimension === 'number' &&
      payload.expectedDimension !== setDimension &&
      Number.isFinite(payload.expectedDimension)
    ) {
      log('worker_expected_dimension_mismatch', {
        chunkId: payload.chunkId,
        payload: payload.expectedDimension,
        embeddingSetId: targetSetId,
        embeddingSetDimension: setDimension,
      });
    }

    if (!Number.isFinite(setDimension) || setDimension <= 0) {
      if (!Number.isFinite(activeModelDimension) || activeModelDimension <= 0) {
        throw new Error(`Invalid expected embedding dimension (${activeModelDimension}).`);
      }
      return activeModelDimension;
    }

    return setDimension;
  }

  function isEmbeddingUpToDate(
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>,
    expectedHash: string
  ): boolean {
    return Boolean(chunk.embeddingHash && chunk.embeddingHash === expectedHash);
  }

  async function executeJobPayload(claimed: ClaimedJob, leaseToken: string): Promise<void> {
    console.log('[EMBED-WORKER] Job start', {
      jobId: claimed.id,
      activeModelId,
      activeCompositeKey,
    });

    const payload = assertEmbedChunkJob(claimed);
    console.log('[EMBED-WORKER] Job payload', {
      chunkId: payload.chunkId,
      payloadModelKey: payload.modelKey,
      payloadProvider: payload.provider,
    });

    const chunk = await loadChunkOrThrow(payload.chunkId);
    const targetSetId = resolveTargetSetId(payload, chunk);
    const expectedDimension = await determineExpectedDimension(targetSetId, payload);
    const jobModel = resolveJobModel(payload);

    console.log('[EMBED-WORKER] Resolved job model', {
      jobModelId: jobModel.modelId,
      jobCompositeKey: jobModel.compositeKey,
      jobProvider: jobModel.provider,
      willReinitialize: jobModel.modelId !== activeModelId,
    });

    const expectedHash = await sha256Hex(`${chunk.contentHash}:${jobModel.compositeKey}`);

    if (isEmbeddingUpToDate(chunk, expectedHash)) {
      await jq.complete({ id: claimed.id, leaseToken });
      return;
    }

    let embedding: number[];
    if (jobModel.provider === 'local') {
      console.log('[EMBED-WORKER] Processing local embedding...');
      await ensureLocalModel(jobModel.modelId, jobModel.compositeKey);
      console.log('[EMBED-WORKER] About to call generateLocalEmbedding...');
      const result = await generateLocalEmbedding(chunk, expectedDimension);
      console.log('[EMBED-WORKER] generateLocalEmbedding returned', {
        dimensions: result.dimensions,
      });
      embedding = result.embedding;
    } else {
      embedding = await generateHostedEmbedding(
        jobModel.provider,
        jobModel.modelId,
        expectedDimension,
        chunk.content
      );
    }

    await updateChunkEmbedding(
      options.db,
      chunk.id,
      embedding,
      targetSetId,
      expectedHash,
      vectorEnabledForWrites
    );
    await jq.complete({ id: claimed.id, leaseToken });
  }

  async function handleClaimedJob(claimed: ClaimedJob): Promise<void> {
    // Our Job shape retains DB column name `lease_token`; use it directly
    const leaseToken = claimed.lease_token as string;
    const jobId = claimed.id;

    const hb = setInterval(() => {
      // Fire-and-forget heartbeat; log errors for observability
      jq.heartbeat({ id: jobId, leaseToken, extendMs: leaseMs }).catch((err) =>
        log('worker_heartbeat_error', { jobId, error: String(err) })
      );
    }, heartbeatMs);

    const jobStart = Date.now();
    try {
      await executeJobPayload(claimed, leaseToken);
      const dur = Date.now() - jobStart;
      metrics.jobsProcessed += 1;
      metrics.totalDurationMs += dur;
      processedSinceInit += 1;
      consecutiveFailures = 0;
      if (reinitEveryN > 0 && processedSinceInit >= reinitEveryN) {
        // Periodic re-init to release native resources (WebGPU/WASM)
        await resetService(false);
      }
      log('worker_job_complete', {
        jobId,
        attempts: claimed.attempts,
        durationMs: dur,
        queue: claimed.queue,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Truncate to ~4k to fit error column expectations
      const truncated = message.slice(0, 4000);
      await jq.fail({ id: jobId, leaseToken, error: truncated });
      metrics.jobsFailed += 1;
      consecutiveFailures += 1;
      // If repeated model execution errors occur, force CPU re-init
      const looksLikeModelExecError =
        /model execution/i.test(truncated) || /\b\d{6,}\b/.test(truncated);
      if (consecutiveFailures >= forceCpuAfterFailures && looksLikeModelExecError) {
        log('worker_reset_service', { reason: 'consecutive_failures', consecutiveFailures });
        await resetService(true);
      }
      log('worker_job_fail', { jobId, attempts: claimed.attempts, error: truncated });
    } finally {
      clearInterval(hb);
    }
  }

  async function processOne(): Promise<void> {
    try {
      const claimed = await jq.claim({ queue: queueName, leaseMs, workerId });
      if (!claimed) {
        await sleep(400); // idle backoff
        return;
      }

      await handleClaimedJob(claimed);
      // Small yield to let GC/native resources settle
      await sleep(5);
    } catch (err) {
      // If database is closed/closing, gracefully stop the worker
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('PGlite is closed') || message.includes('closed')) {
        running = false; // Stop the worker loop
        return;
      }
      // Re-throw other errors
      throw err;
    }
  }

  const loops: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    loops.push(
      (async () => {
        while (running) {
          await processOne();
        }
      })()
    );
  }

  // Periodic metrics logger
  const metricsInterval = Number(
    options.metricsIntervalMs ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } })?.process?.env?.[
        'WORKER_METRICS_INTERVAL_MS'
      ] ??
      30000
  );
  const metricsTimer = setInterval(
    () => {
      if (!running) return;
      const uptimeMs = Date.now() - metrics.startedAt;
      const avgMs = metrics.jobsProcessed > 0 ? metrics.totalDurationMs / metrics.jobsProcessed : 0;
      log('worker_metrics', {
        uptimeMs,
        processed: metrics.jobsProcessed,
        failed: metrics.jobsFailed,
        avgDurationMs: Math.round(avgMs),
        concurrency,
        queue: queueName,
        modelKey: activeCompositeKey,
      });
    },
    Math.max(5000, metricsInterval)
  );

  return {
    stop: async () => {
      running = false;
      await Promise.race([Promise.allSettled(loops).then(() => {}), sleep(leaseMs)]);
      try {
        await service.dispose();
      } catch {
        // ignore
      }
      clearInterval(metricsTimer);
    },
  };
}
