import {
  createDatabasePressureController,
  type DatabasePressureSnapshotSource,
  type DatabaseWorkSchedulerSnapshot,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  type IDatabase,
  type ProfileBootstrapRuntime,
} from '@brainstrike/db';
import type {
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
  EmbeddingWorkerStorage,
  ForegroundEmbeddingGate,
} from '@brainstrike/embeddings/worker';
import { parsePositiveIntegerConfig } from '@brainstrike/platform-utils';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils/logger';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/utils/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingQosInputs,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';

const logger = createLogger('EmbeddingWorkerConfig');
// Desktop local embedding runs in a hidden renderer backed by the DB scheduler.
// Use WebGPU-sized batches when the scheduler is idle, then collapse to one-at-a-time
// under foreground pressure so browsing/searching remains foreground-first.
const DESKTOP_IDLE_EMBED_CLAIM_BATCH_SIZE = 16;
const DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE = 1;
const DESKTOP_EMBED_INTER_BATCH_DELAY_MS = 75;
const DESKTOP_EMBED_MAX_PENDING_COMPLETION_BATCHES = 2;
const DESKTOP_EMBED_MAX_PENDING_COMPLETION_BYTES = 786_432;
const DESKTOP_EMBED_MAX_PENDING_COMPLETION_CHUNKS = 32;
const DESKTOP_EMBED_STREAM_BATCH_SIZE = 8;
const DESKTOP_PRESSURE_POLL_MS = 50;
const DESKTOP_SCHEDULER_SNAPSHOT_CACHE_MS = 10;
const DESKTOP_POWER_SNAPSHOT_CACHE_MS = 1000;
const DESKTOP_FOREGROUND_PRESSURE_WINDOW_MS = 1500;
const DESKTOP_FOREGROUND_WAIT_P95_THRESHOLD_MS = 75;
const DESKTOP_FOREGROUND_SERVICE_P95_THRESHOLD_MS = 120;
const DESKTOP_PIPELINE_SNAPSHOT_CACHE_MS = 500;
const HIGH_RETAINED_HEAP_RATIO = 0.75;

type PositiveIntegerEmbeddingEnvKey =
  | 'VITE_EMBED_CLAIM_BATCH_SIZE'
  | 'VITE_EMBED_COMPLETION_OVERLAP_BATCHES'
  | 'VITE_EMBED_CONCURRENCY'
  | 'VITE_EMBED_INTER_BATCH_DELAY_MS'
  | 'VITE_EMBED_LEASE_MS'
  | 'VITE_EMBED_MAX_PENDING_COMPLETION_BYTES'
  | 'VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS'
  | 'VITE_EMBED_STREAM_BATCH_SIZE';

interface WorkspaceIndexingPowerBridge {
  getSnapshot?: () => Promise<WorkspaceIndexingPowerSnapshot>;
}

interface BrowserPerformanceMemory {
  readonly jsHeapSizeLimit?: number;
  readonly usedJSHeapSize?: number;
}

interface EmbeddingPipelineTelemetry {
  readonly readAcceleratorIdleRatio: () => WorkspaceIndexingQosInputs['pipeline']['accelerator'];
  readonly readStalledProgress: (
    queueDepth: WorkspaceIndexingQosInputs['pipeline']['queueDepth']
  ) => WorkspaceIndexingQosInputs['pipeline']['progress'];
  readonly recordLog: (msg: string, meta?: unknown) => void;
}

function parsePositiveIntegerEnv(name: PositiveIntegerEmbeddingEnvKey, fallback: number): number {
  return parsePositiveIntegerConfig({
    defaultValue: fallback,
    name,
    rawValue: import.meta.env[name],
  });
}

function createPressureSnapshotSource(db: IDatabase): DatabasePressureSnapshotSource {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return scheduler;
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Desktop embedding worker requires database QoS scheduler snapshots.');
  }

  return {
    getSnapshot: createCachedSnapshotReader(schedulerSnapshot, DESKTOP_SCHEDULER_SNAPSHOT_CACHE_MS),
  };
}

function createReadPowerSnapshot(): (() => Promise<WorkspaceIndexingPowerSnapshot>) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { power?: WorkspaceIndexingPowerBridge }).power;
  const getSnapshot = bridge?.getSnapshot;
  if (typeof getSnapshot !== 'function') {
    return null;
  }
  return createCachedSnapshotReader(
    async () => assertValidWorkspaceIndexingPowerSnapshot(await getSnapshot()),
    DESKTOP_POWER_SNAPSHOT_CACHE_MS
  );
}

function createCachedSnapshotReader<TSnapshot>(
  readSnapshot: () => TSnapshot | Promise<TSnapshot>,
  cacheMs: number,
  now: () => number = () => Date.now()
): () => Promise<TSnapshot> {
  let cachedSnapshot: TSnapshot | null = null;
  let cachedAt = 0;
  let pendingSnapshot: Promise<TSnapshot> | null = null;
  return async () => {
    const readAt = now();
    if (cachedSnapshot && readAt - cachedAt <= cacheMs) {
      return cachedSnapshot;
    }
    if (pendingSnapshot) {
      // Concurrent permit and claim-size checks intentionally share one IPC read.
      return pendingSnapshot;
    }
    cachedSnapshot = null;
    cachedAt = 0;
    pendingSnapshot = Promise.resolve()
      .then(readSnapshot)
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedAt = now();
        return snapshot;
      });
    try {
      return await pendingSnapshot;
    } finally {
      pendingSnapshot = null;
    }
  };
}

function getDesktopDatabasePressureReason(snapshot: DatabaseWorkSchedulerSnapshot): string | null {
  // The stats window is intentionally evaluated after the scheduler quiet
  // window: recent foreground work always wins, even if latency samples are low.
  // If the scheduler quiet window is tuned longer than this desktop stats
  // window, the quiet-window branch deliberately owns that full period.
  return getDatabasePressureWaitingReason(snapshot, snapshot.snapshotAt, {
    foregroundPressureWindowMs: DESKTOP_FOREGROUND_PRESSURE_WINDOW_MS,
    foregroundServiceP95ThresholdMs: DESKTOP_FOREGROUND_SERVICE_P95_THRESHOLD_MS,
    foregroundWaitP95ThresholdMs: DESKTOP_FOREGROUND_WAIT_P95_THRESHOLD_MS,
  });
}

function toWorkspaceIndexingDatabasePressure(
  snapshot: DatabaseWorkSchedulerSnapshot
): WorkspaceIndexingDatabasePressure {
  const reason = getDesktopDatabasePressureReason(snapshot);
  const normalPressure = reason?.startsWith('normal-') === true;
  return {
    available: true,
    foregroundPressure: reason !== null && !normalPressure,
    normalPressure,
  };
}

function readRendererMemoryPressure(): WorkspaceIndexingQosInputs['pipeline']['memory'] {
  const memory = (globalThis.performance as Performance & { memory?: BrowserPerformanceMemory })
    .memory;
  const used = memory?.usedJSHeapSize;
  const limit = memory?.jsHeapSizeLimit;
  if (
    typeof used !== 'number' ||
    typeof limit !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return { available: false };
  }
  const retainedHeapRatio = used / limit;
  return {
    available: true,
    pressure: retainedHeapRatio >= HIGH_RETAINED_HEAP_RATIO ? 'high' : 'normal',
    retainedHeapRatio,
  };
}

async function readEmbeddingQueueDepth(
  db: IDatabase
): Promise<WorkspaceIndexingQosInputs['pipeline']['queueDepth']> {
  const result = await db.query<{ count: number | string }>(
    `SELECT CAST(COUNT(*) AS INTEGER) AS count
       FROM job_queue
      WHERE queue = 'embeddings'
        AND job_type = 'embed_chunk'
        AND state IN ('queued', 'running')`
  );
  const rawCount = result.rows[0]?.count;
  const activeEmbeddingJobs = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? 0);
  if (!Number.isFinite(activeEmbeddingJobs) || activeEmbeddingJobs < 0) {
    throw new Error('Workspace Index QoS received an invalid embedding queue depth.');
  }
  return {
    activeEmbeddingJobs,
    available: true,
  };
}

function createEmbeddingPipelineTelemetry(
  now: () => number = () => Date.now()
): EmbeddingPipelineTelemetry {
  let lastProgressAt: number | null = null;
  let lastIdleRatio: number | null = null;

  return {
    readAcceleratorIdleRatio: () =>
      typeof lastIdleRatio === 'number'
        ? {
            available: true,
            idleRatio: lastIdleRatio,
          }
        : { available: false },
    readStalledProgress: (queueDepth) => {
      if (!queueDepth.available || queueDepth.activeEmbeddingJobs <= 0) {
        return {
          available: true,
          stalledForMs: null,
        };
      }
      return {
        available: true,
        stalledForMs: lastProgressAt === null ? null : Math.max(0, now() - lastProgressAt),
      };
    },
    recordLog: (msg, meta) => {
      if (msg !== 'embedding_pipeline_timing' || typeof meta !== 'object' || meta === null) {
        return;
      }
      const record = meta as Record<string, unknown>;
      const inferenceMs = Number(record['inferenceMs'] ?? 0);
      const completionWaitMs = Number(record['completionWaitMs'] ?? 0);
      if (!(Number.isFinite(inferenceMs) && Number.isFinite(completionWaitMs))) {
        return;
      }
      const denominator = Math.max(1, inferenceMs + completionWaitMs);
      lastIdleRatio = Math.max(0, Math.min(1, completionWaitMs / denominator));
      lastProgressAt = now();
    },
  };
}

function createDesktopPipelineInputsReader(
  db: IDatabase,
  telemetry: EmbeddingPipelineTelemetry
): () => Promise<WorkspaceIndexingQosInputs['pipeline']> {
  const readQueueDepth = createCachedSnapshotReader(
    () => readEmbeddingQueueDepth(db),
    DESKTOP_PIPELINE_SNAPSHOT_CACHE_MS
  );
  return async () => {
    const queueDepth = await readQueueDepth();
    return {
      accelerator: telemetry.readAcceleratorIdleRatio(),
      memory: readRendererMemoryPressure(),
      progress: telemetry.readStalledProgress(queueDepth),
      queueDepth,
    };
  };
}

function createUnavailablePipelineInputs(): WorkspaceIndexingQosInputs['pipeline'] {
  return {
    accelerator: { available: false },
    memory: readRendererMemoryPressure(),
    progress: { available: false },
    queueDepth: { available: false },
  };
}

function resolveDesktopClaimBatchSize(
  snapshot: DatabaseWorkSchedulerSnapshot,
  idleClaimBatchSize: number,
  powerSnapshot: WorkspaceIndexingPowerSnapshot | null,
  foregroundQueryActive: boolean,
  pipeline: WorkspaceIndexingQosInputs['pipeline'],
  observeQosTransition: (policy: WorkspaceIndexingQosPolicy) => void
): number | null {
  const policy = resolveWorkspaceIndexingQosPolicy({
    dbPressure: toWorkspaceIndexingDatabasePressure(snapshot),
    foregroundQueryActive,
    idleState: powerSnapshot?.idleState ?? 'active',
    idleTimeMs: powerSnapshot?.idleTimeMs ?? 0,
    manualPaused: false,
    pipeline,
    powerSource: powerSnapshot?.powerSource ?? 'unknown',
    // TODO(workspace-index-qos): wire hosted provider rate-limit telemetry once
    // the embedding queue records provider throttling independently of failures.
    providerRateLimited: false,
    recentUserInputMs: null,
    thermalState: powerSnapshot?.thermalState ?? 'unknown',
    windowVisible: false,
  });
  observeQosTransition(policy);
  if (!policy.allowNewWork) {
    return null;
  }
  const positiveClaimBatchSize =
    policy.workerClaimBatchSize > 0
      ? policy.workerClaimBatchSize
      : DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE;
  return Math.min(positiveClaimBatchSize, idleClaimBatchSize);
}

type BackgroundPermit = NonNullable<EmbeddingWorkerOptions['waitForBackgroundPermit']>;
type EmbeddingWorkerConfigRuntimeEngine = Extract<
  ProfileBootstrapRuntime['engine'],
  'pglite' | 'turso'
>;

interface EmbeddingWorkerConfigOptions {
  readonly runtimeEngine: EmbeddingWorkerConfigRuntimeEngine;
  readonly storage?: EmbeddingWorkerStorage;
}

function resolveDesktopPipelineCapacity(
  snapshot: DatabaseWorkSchedulerSnapshot,
  fallback: {
    readonly maxPendingCompletionBatches: number;
    readonly maxPendingCompletionBytes: number;
    readonly maxPendingCompletionChunks: number;
    readonly streamBatchSize: number;
  },
  powerSnapshot: WorkspaceIndexingPowerSnapshot | null,
  foregroundQueryActive: boolean,
  pipeline: WorkspaceIndexingQosInputs['pipeline'],
  observeQosTransition: (policy: WorkspaceIndexingQosPolicy) => void
): EmbeddingWorkerPipelineCapacity | null {
  const policy = resolveWorkspaceIndexingQosPolicy({
    dbPressure: toWorkspaceIndexingDatabasePressure(snapshot),
    foregroundQueryActive,
    idleState: powerSnapshot?.idleState ?? 'active',
    idleTimeMs: powerSnapshot?.idleTimeMs ?? 0,
    manualPaused: false,
    pipeline,
    powerSource: powerSnapshot?.powerSource ?? 'unknown',
    providerRateLimited: false,
    recentUserInputMs: null,
    thermalState: powerSnapshot?.thermalState ?? 'unknown',
    windowVisible: false,
  });
  observeQosTransition(policy);
  return {
    maxPendingCompletionBatches: Math.min(
      policy.completionOverlapBatches,
      fallback.maxPendingCompletionBatches
    ),
    maxPendingCompletionBytes: Math.min(
      policy.maxPendingCompletionBytes,
      fallback.maxPendingCompletionBytes
    ),
    maxPendingCompletionChunks: Math.min(
      policy.maxPendingCompletionChunks,
      fallback.maxPendingCompletionChunks
    ),
    streamBatchSize: Math.min(policy.streamBatchSize, fallback.streamBatchSize),
  };
}

/**
 * Wrap a DB-pressure permit so the worker also yields the GPU to an in-flight
 * foreground query embedding — but ONLY at the claim boundary (never completion),
 * which keeps draining deadlock-free.
 */
export function composeClaimPermit(
  base: BackgroundPermit,
  gate: ForegroundEmbeddingGate | undefined
): BackgroundPermit {
  if (!gate) {
    return base;
  }
  return async (permitOptions) => {
    await base(permitOptions);
    if (permitOptions?.label === 'embedding claim') {
      await gate.waitUntilInactive();
    }
  };
}

function createDesktopPressureControls(
  db: IDatabase,
  fallback: {
    readonly claimBatchSize: number;
    readonly maxPendingCompletionBatches: number;
    readonly maxPendingCompletionBytes: number;
    readonly maxPendingCompletionChunks: number;
    readonly streamBatchSize: number;
  },
  gate: ForegroundEmbeddingGate | undefined,
  telemetry: EmbeddingPipelineTelemetry
): Pick<
  EmbeddingWorkerOptions,
  'resolveClaimBatchSize' | 'resolvePipelineCapacity' | 'waitForBackgroundPermit'
> {
  const snapshotSource = createPressureSnapshotSource(db);
  const readPowerSnapshot = createReadPowerSnapshot();
  const pressureController = createDatabasePressureController({
    pollMs: DESKTOP_PRESSURE_POLL_MS,
    snapshotSource,
  });
  const readPipelineInputs = createDesktopPipelineInputsReader(db, telemetry);
  // One tracker per worker config: claim-size reads re-resolve the QoS policy
  // every cycle, and the tracker logs only (state, reason) transitions.
  const observeQosTransition = createWorkspaceIndexingQosTransitionLogger('desktop-host-claim');
  return {
    resolveClaimBatchSize: async () => {
      const snapshot = await snapshotSource.getSnapshot();
      const foregroundQueryActive = gate?.isActive() ?? false;
      const dbPressure = toWorkspaceIndexingDatabasePressure(snapshot);
      return resolveDesktopClaimBatchSize(
        snapshot,
        fallback.claimBatchSize,
        readPowerSnapshot ? await readPowerSnapshot() : null,
        foregroundQueryActive,
        foregroundQueryActive || (dbPressure.available && dbPressure.foregroundPressure)
          ? createUnavailablePipelineInputs()
          : await readPipelineInputs(),
        observeQosTransition
      );
    },
    resolvePipelineCapacity: async () => {
      const snapshot = await snapshotSource.getSnapshot();
      const foregroundQueryActive = gate?.isActive() ?? false;
      const dbPressure = toWorkspaceIndexingDatabasePressure(snapshot);
      return resolveDesktopPipelineCapacity(
        snapshot,
        fallback,
        readPowerSnapshot ? await readPowerSnapshot() : null,
        foregroundQueryActive,
        foregroundQueryActive || (dbPressure.available && dbPressure.foregroundPressure)
          ? createUnavailablePipelineInputs()
          : await readPipelineInputs(),
        observeQosTransition
      );
    },
    waitForBackgroundPermit: composeClaimPermit(pressureController.waitForBackgroundPermit, gate),
  };
}

function resolveEmbeddingWorkerStorageOptions(
  db: IDatabase,
  options: EmbeddingWorkerConfigOptions
): Pick<EmbeddingWorkerOptions, 'db' | 'storage'> {
  const runtimeEngine = options.runtimeEngine;
  if (!runtimeEngine) {
    throw new Error('Desktop embedding worker config requires an explicit database runtime.');
  }
  if (runtimeEngine === 'pglite') {
    if (options.storage) {
      throw new Error('PGlite embedding worker config must use the database handle.');
    }
    return { db };
  }
  if (runtimeEngine === 'turso') {
    if (!options.storage) {
      throw new Error('Turso embedding worker config requires an explicit storage port.');
    }
    return { storage: options.storage };
  }
  return unsupportedEmbeddingWorkerRuntime(runtimeEngine);
}

function unsupportedEmbeddingWorkerRuntime(runtimeEngine: never): never {
  throw new Error(`Unsupported embedding worker database runtime: ${String(runtimeEngine)}`);
}

export function createEmbeddingWorkerConfig(
  db: IDatabase,
  gate: ForegroundEmbeddingGate | undefined,
  options: EmbeddingWorkerConfigOptions
): EmbeddingWorkerOptions {
  const claimBatchSize = parsePositiveIntegerEnv(
    'VITE_EMBED_CLAIM_BATCH_SIZE',
    DESKTOP_IDLE_EMBED_CLAIM_BATCH_SIZE
  );
  const concurrency = parsePositiveIntegerEnv('VITE_EMBED_CONCURRENCY', 1);
  const interBatchDelayMs = parsePositiveIntegerEnv(
    'VITE_EMBED_INTER_BATCH_DELAY_MS',
    DESKTOP_EMBED_INTER_BATCH_DELAY_MS
  );
  const leaseMs = parsePositiveIntegerEnv('VITE_EMBED_LEASE_MS', 60_000);
  const maxPendingCompletionBatches = parsePositiveIntegerEnv(
    'VITE_EMBED_COMPLETION_OVERLAP_BATCHES',
    DESKTOP_EMBED_MAX_PENDING_COMPLETION_BATCHES
  );
  const maxPendingCompletionBytes = parsePositiveIntegerEnv(
    'VITE_EMBED_MAX_PENDING_COMPLETION_BYTES',
    DESKTOP_EMBED_MAX_PENDING_COMPLETION_BYTES
  );
  const maxPendingCompletionChunks = parsePositiveIntegerEnv(
    'VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS',
    DESKTOP_EMBED_MAX_PENDING_COMPLETION_CHUNKS
  );
  const streamBatchSize = parsePositiveIntegerEnv(
    'VITE_EMBED_STREAM_BATCH_SIZE',
    DESKTOP_EMBED_STREAM_BATCH_SIZE
  );
  const modelKey = import.meta.env['VITE_EMBED_MODEL_KEY'];
  const telemetry = createEmbeddingPipelineTelemetry();

  return {
    ...resolveEmbeddingWorkerStorageOptions(db, options),
    claimBatchSize,
    concurrency,
    interBatchDelayMs,
    leaseMs,
    maxPendingCompletionBatches,
    maxPendingCompletionBytes,
    maxPendingCompletionChunks,
    streamBatchSize,
    ...createDesktopPressureControls(
      db,
      {
        claimBatchSize,
        maxPendingCompletionBatches,
        maxPendingCompletionBytes,
        maxPendingCompletionChunks,
        streamBatchSize,
      },
      gate,
      telemetry
    ),
    ...(modelKey ? { modelKey } : {}),
    log: (msg: string, meta?: unknown) => {
      telemetry.recordLog(msg, meta);
      if (meta) {
        logger.info(msg, meta);
        return;
      }
      logger.info(msg);
    },
    onDownloadProgress: (modelId: string, progress: number) => {
      const store = useModelRegistryStore.getState();
      store.setDownloadProgress(modelId, progress);
      store.setDownloading(modelId, progress < 100);
    },
  };
}
