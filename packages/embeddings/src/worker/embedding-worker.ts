import type { IDatabase } from '@brainstrike/db';
import { JobQueue } from '@brainstrike/db';
import { generateUUID } from '@brainstrike/utils';
import { SimpleEmbeddingService } from '../bge-m3-service';
import type { EmbeddingResult, EmbeddingService, ModelConfig } from '../types';

type Distance = 'cosine' | 'l2' | 'ip';

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

async function getOrCreateEmbeddingSet(
  db: IDatabase,
  modelKey: string,
  modelId: string,
  dimensions: number,
  distance: Distance
): Promise<string> {
  // Try fetch by unique composite
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM embedding_sets WHERE model_key = $1 AND dimensions = $2 AND distance = $3 LIMIT 1',
    [modelKey, dimensions, distance]
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const id = generateUUID();
  const now = new Date().toISOString();
  const res = await db.query<{ id: string }>(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (model_key, dimensions, distance)
     DO UPDATE SET model_id = EXCLUDED.model_id
     RETURNING id`,
    [id, modelKey, modelId, dimensions, distance, now]
  );
  const row = res.rows[0];
  if (!row) throw new Error('Failed to create embedding set');
  return row.id;
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

function resolveModelKey(fromOptions?: string): string {
  const env = (() => {
    try {
      if (typeof process !== 'undefined' && process.env && process.env['EMBED_MODEL_KEY']) {
        return String(process.env['EMBED_MODEL_KEY']);
      }
      return '';
    } catch {
      return '';
    }
  })();
  return fromOptions || env || SimpleEmbeddingService.getDefaultModelKey();
}

function resolveBooleanEnv(key: string, defaultValue = false): boolean {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[key];
      return v ? String(v).toLowerCase() === 'true' : defaultValue;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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

export async function startEmbeddingWorker(
  options: EmbeddingWorkerOptions
): Promise<EmbeddingWorkerController> {
  const log = options.log || (() => {});
  const queueName = options.queue ?? 'embeddings';
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const modelKey = resolveModelKey(options.modelKey);
  const distance: Distance = options.distance ?? 'cosine';
  const workerId = options.workerId ?? `embed-worker-${generateUUID().slice(0, 8)}`;

  // Optional: allow disabling at runtime via env
  const enabled =
    typeof options.enable === 'boolean'
      ? options.enable
      : resolveBooleanEnv('EMBED_QUEUE_ENABLED', true);
  if (!enabled) {
    log('Embedding worker disabled via EMBED_QUEUE_ENABLED=false');
    return { stop: async () => {} };
  }

  let { service, modelConfig } = await initializeEmbeddingService(options, modelKey);

  const embeddingSetId = await getOrCreateEmbeddingSet(
    options.db,
    modelKey,
    modelConfig.id,
    modelConfig.dimensions,
    distance
  );

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

  // Note: schema uses VECTOR(768) by default; ensure selected model matches to avoid errors

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

  async function resetService(forceCpu = false) {
    try {
      await service.dispose();
    } catch {}
    // Reinitialize service
    const device = forceCpu ? 'cpu' : options.device;
    const s = new SimpleEmbeddingService();
    await s.initializeWithModel(modelKey, undefined, device);
    service = s;
    // Refresh modelConfig in case anything changed
    const cfg = SimpleEmbeddingService.getModelConfig(modelKey);
    if (cfg) modelConfig = cfg;
    processedSinceInit = 0;
    consecutiveFailures = 0;
  }

  type ClaimedJob = NonNullable<Awaited<ReturnType<typeof jq.claim>>>;

  async function validateAndGenerateEmbedding(
    chunk: NonNullable<Awaited<ReturnType<typeof loadChunk>>>
  ): Promise<EmbeddingResult> {
    const svcAny = service as unknown as {
      generateDocEmbedding?: (t: string) => Promise<EmbeddingResult>;
      generateEmbedding: (t: string) => Promise<EmbeddingResult>;
    };
    const result = svcAny.generateDocEmbedding
      ? await svcAny.generateDocEmbedding(chunk.content)
      : await service.generateEmbedding(chunk.content);

    const expectedDimensions = modelConfig?.dimensions ?? 0;
    if (!Array.isArray(result.embedding) || result.embedding.length !== expectedDimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${result.embedding.length}, expected ${expectedDimensions}`
      );
    }

    return result;
  }

  async function executeJobPayload(claimed: ClaimedJob, leaseToken: string): Promise<void> {
    if (claimed.jobType !== 'embed_chunk') {
      throw new Error(`Unsupported job type: ${claimed.jobType}`);
    }
    const payload = (claimed.payload || {}) as EmbedChunkPayload;
    if (!payload.chunkId) throw new Error('Missing chunkId in payload');

    const chunk = await loadChunk(options.db, payload.chunkId);
    if (!chunk) throw new Error(`Chunk not found: ${payload.chunkId}`);

    const targetSetId = payload.embeddingSetId ?? chunk.embeddingSetId ?? embeddingSetId;
    const expectedHash = await sha256Hex(`${chunk.contentHash}:${modelKey}`);

    // Idempotency: if embedding exists and hash matches, treat as complete
    if (chunk.embeddingHash && chunk.embeddingHash === expectedHash) {
      await jq.complete({ id: claimed.id, leaseToken });
      return;
    }

    const result = await validateAndGenerateEmbedding(chunk);
    await updateChunkEmbedding(
      options.db,
      chunk.id,
      result.embedding,
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
    const claimed = await jq.claim({ queue: queueName, leaseMs, workerId });
    if (!claimed) {
      await sleep(400); // idle backoff
      return;
    }

    await handleClaimedJob(claimed);
    // Small yield to let GC/native resources settle
    await sleep(5);
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
        modelKey,
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
