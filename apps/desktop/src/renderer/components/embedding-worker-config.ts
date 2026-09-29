import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  createDatabasePressureController,
  type DatabaseIntegrityWatcher,
  type DatabasePressureSnapshotSource,
  type DatabaseWorkSchedulerSnapshot,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  getDesktopDatabaseBridge,
  type IDatabase,
  isBackgroundDatabaseWorkAdmitted,
} from '@brainstrike/db';
import type {
  EmbeddingWorkerOptions,
  EmbeddingWorkerPipelineCapacity,
  ForegroundEmbeddingGate,
} from '@brainstrike/embeddings/worker';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/indexing-contract/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingQosInputs,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/indexing-contract/workspace-indexing-qos';
import { createLogger } from '@brainstrike/logging';
import { parsePositiveIntegerConfig } from '@brainstrike/platform-utils';
import { getEmbeddingHostIntegrityWatcher } from './embedding-host-database-integrity';

const logger = createLogger('EmbeddingWorkerConfig');
// BST-1334: these two fire once per completed streaming batch (hundreds of pairs in a
// single backfill) and dominate desktop diagnostic-log exports at `info`. The measured
// payloads are unchanged — only the emitted level drops to `debug` — so the QoS telemetry
// derived from `embedding_pipeline_timing` in recordLog() below is unaffected. Every other
// embedding-worker log message (worker_metrics, embedding_stats_refresh,
// worker_model_dimension_notice, embedding_cache_stats, embedding_cache_eviction, etc.) is
// low-frequency and stays at `info`.
const EMBEDDING_PIPELINE_TIMING_LOG_MESSAGE = 'embedding_pipeline_timing';
const EMBEDDING_COMPLETION_BATCH_LOG_MESSAGE = 'embedding_completion_batch';
const HIGH_FREQUENCY_EMBEDDING_LOG_MESSAGES = new Set<string>([
  EMBEDDING_COMPLETION_BATCH_LOG_MESSAGE,
  EMBEDDING_PIPELINE_TIMING_LOG_MESSAGE,
]);
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
// Max time the embedding CLAIM path yields to `foreground-db-pressure` before it
// proceeds with gentle, constrained claims. Mirrors the app-shell sync bound
// (workspace-collection-sync-service's FOREGROUND_DB_PRESSURE_STARVATION_MS) and
// exists for the same reason: every main-window renderer query defaults to
// `foreground` priority, so an active Explorer/Database surface keeps
// `foreground-quiet-window` / `foreground-latency` asserted more or less
// continuously. Without a bound the claim loop sits at ZERO claims for as long
// as the user keeps the window busy — the queue only grows, `running` stays 0,
// and a manual backfill's queue-capacity wait becomes unsatisfiable because the
// only consumer that can free capacity is the one being starved.
// Genuine `foreground-query` activity is NOT bypassed: the QoS resolver keeps
// yielding fully for that, which preserves the GPU-exclusivity contract.
const DESKTOP_EMBED_FOREGROUND_DB_PRESSURE_STARVATION_MS = 5000;

type PositiveIntegerEmbeddingEnvKey =
  | 'VITE_EMBED_CLAIM_BATCH_SIZE'
  | 'VITE_EMBED_FOREGROUND_DB_PRESSURE_STARVATION_MS'
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

  const schedulerSnapshot = getDesktopDatabaseBridge()?.schedulerSnapshot;
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
      // Not `.then(readSnapshot)`: that forwards `undefined` as an argument, and
      // IPC-backed readers reject any arity their contract does not declare.
      .then(() => readSnapshot())
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
  return getDatabasePressureWaitingReason(snapshot, {
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
    `SELECT COUNT(*)::int AS count
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
      if (
        msg !== EMBEDDING_PIPELINE_TIMING_LOG_MESSAGE ||
        typeof meta !== 'object' ||
        meta === null
      ) {
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
  observeQosTransition: (policy: WorkspaceIndexingQosPolicy) => void,
  starvation: ForegroundDbPressureStarvationTracker
): number | null {
  const policy = resolveWorkspaceIndexingQosPolicy({
    dbPressure: toWorkspaceIndexingDatabasePressure(snapshot),
    foregroundDbPressureStarvationBypass: starvation.isBypassing(),
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
  starvation.observePolicy(policy);
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

/**
 * The DB pressure controller accepts an abort signal; the worker-facing permit
 * contract does not. Keeping the wider shape on the INPUT is what lets the claim
 * wrapper bound its own wait without widening the worker's option type.
 */
type AbortableBackgroundPermit = (options: {
  readonly label: string;
  readonly signal?: AbortSignal;
}) => Promise<void>;

export interface ForegroundDbPressureStarvationTracker {
  /** True once the claim path has been blocked by foreground DB pressure past the bound. */
  readonly isBypassing: () => boolean;
  /** Clears the starvation clock; call when the claim path is admitted without pressure. */
  readonly noteAdmitted: () => void;
  /** Starts (or continues) the starvation clock; call when the claim path is held back. */
  readonly noteBlocked: () => void;
  /** Latches/clears the clock from the resolved policy, and warns once per episode. */
  readonly observePolicy: (policy: WorkspaceIndexingQosPolicy) => void;
  /** Bound, exposed so the permit wait and the policy bypass share ONE deadline. */
  readonly starvationMs: number;
}

/**
 * Bounds how long the embedding claim path yields to foreground DB pressure.
 *
 * The clock only advances while the claim path is actually held back by
 * `foreground-db-pressure`; any admission that did not need the bypass resets
 * it. That keeps a genuinely quiet system on the full idle claim batch while
 * guaranteeing a starved worker still claims — at `system-constrained` batch
 * size 1 — instead of sitting at zero indefinitely.
 */
export function createForegroundDbPressureStarvationTracker(options?: {
  readonly elapsedNow?: () => number;
  readonly log?: (message: string, meta?: unknown) => void;
  readonly starvationMs?: number;
}): ForegroundDbPressureStarvationTracker {
  const elapsedNow = options?.elapsedNow ?? (() => globalThis.performance.now());
  const starvationMs = options?.starvationMs ?? DESKTOP_EMBED_FOREGROUND_DB_PRESSURE_STARVATION_MS;
  const log = options?.log ?? ((message, meta) => logger.warn(message, meta));
  let blockedSince: number | null = null;
  let warned = false;

  const noteBlocked = (): void => {
    blockedSince ??= elapsedNow();
  };
  const noteAdmitted = (): void => {
    blockedSince = null;
    warned = false;
  };
  const isBypassing = (): boolean =>
    blockedSince !== null && elapsedNow() - blockedSince >= starvationMs;

  return {
    isBypassing,
    noteAdmitted,
    noteBlocked,
    observePolicy: (policy) => {
      if (policy.reason !== 'foreground-db-pressure') {
        // Any other reason (including a full foreground-query yield) is not the
        // starvation this bound exists for; do not let it accumulate.
        noteAdmitted();
        return;
      }
      noteBlocked();
      if (!(isBypassing() && !warned)) {
        return;
      }
      warned = true;
      log(
        'Embedding claim path exceeded the foreground-db-pressure starvation bound; proceeding with constrained claims',
        { starvationMs }
      );
    },
    starvationMs,
  };
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
 *
 * The DB-pressure wait itself is BOUNDED for the claim label. `waitForBackgroundPermit`
 * polls until pressure clears with no maximum, so a continuously busy main window
 * parks the claim loop forever — the worker never even reaches claim-size
 * resolution, `running` stays 0, and anything waiting on queue drain (a manual
 * backfill) deadlocks against it. Past the bound the claim proceeds and the
 * starvation tracker downgrades the claim batch to `system-constrained` size
 * rather than dropping the yield entirely.
 *
 * The foreground-query gate is deliberately NOT bounded here: a query embedding
 * is short-lived, user-visible, and owns the accelerator exclusively by design.
 */
export function composeClaimPermit(
  base: AbortableBackgroundPermit,
  gate: ForegroundEmbeddingGate | undefined,
  starvation: ForegroundDbPressureStarvationTracker
): BackgroundPermit {
  return async (permitOptions) => {
    if (permitOptions?.label !== 'embedding claim') {
      await base(permitOptions);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, starvation.starvationMs);
    try {
      await base({ ...permitOptions, signal: controller.signal });
      // The starvation clock is owned solely by observePolicy (evaluated on the
      // very next claim-size read against the same cached snapshot); resolving
      // the permit is NOT by itself evidence that pressure has cleared.
    } catch (error) {
      if (!controller.signal.aborted) {
        throw error;
      }
      starvation.noteBlocked();
    } finally {
      clearTimeout(timeoutId);
    }
    await gate?.waitUntilInactive();
  };
}

/**
 * Parks every background permit while main holds the database in an integrity
 * state that does not admit background work (BST-1870), then defers to `base`.
 * Without it the rejected claim loops the worker's `Critical worker error in
 * processBatch` error plus a one-second sleep, and each error is forwarded into
 * the diagnostic-events table: a foreground write into the protected database.
 *
 * Compose it OUTSIDE `composeClaimPermit`: the starvation bound only relaxes
 * foreground-pressure yielding and must never admit a claim under containment.
 * An unreadable state rejects rather than admitting.
 */
export function composeIntegrityHold(
  base: BackgroundPermit,
  watcher: Pick<DatabaseIntegrityWatcher, 'current' | 'waitUntilBackgroundAdmitted'>,
  log: (message: string, meta?: unknown) => void
): BackgroundPermit {
  let warnedRevision: number | null = null;
  const parkWhileContained = async (): Promise<void> => {
    const snapshot = await watcher.current();
    if (isBackgroundDatabaseWorkAdmitted(snapshot.state)) {
      return;
    }
    if (warnedRevision !== snapshot.revision) {
      warnedRevision = snapshot.revision;
      log('Embedding claims paused: database integrity containment is active', {
        revision: snapshot.revision,
        state: snapshot.state,
      });
    }
    await watcher.waitUntilBackgroundAdmitted();
  };
  return async (permitOptions) => {
    // `base` can wait a long time on pressure or the foreground gate, and
    // containment may begin meanwhile: re-check after it, and run every gate
    // again once admitted, so a claim is released only while admitted.
    for (;;) {
      await parkWhileContained();
      await base(permitOptions);
      if (isBackgroundDatabaseWorkAdmitted((await watcher.current()).state)) {
        return;
      }
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
  const integrityWatcher = getEmbeddingHostIntegrityWatcher();
  const readPowerSnapshot = createReadPowerSnapshot();
  const pressureController = createDatabasePressureController({
    pollMs: DESKTOP_PRESSURE_POLL_MS,
    snapshotSource,
  });
  const readPipelineInputs = createDesktopPipelineInputsReader(db, telemetry);
  // One tracker per worker config: claim-size reads re-resolve the QoS policy
  // every cycle, and the tracker logs only (state, reason) transitions.
  const observeQosTransition = createWorkspaceIndexingQosTransitionLogger('desktop-host-claim');
  // One starvation clock shared by the permit wait and the claim-size policy, so
  // the two admission gates cannot each yield "just under" the bound forever.
  const starvation = createForegroundDbPressureStarvationTracker({
    starvationMs: parsePositiveIntegerEnv(
      'VITE_EMBED_FOREGROUND_DB_PRESSURE_STARVATION_MS',
      DESKTOP_EMBED_FOREGROUND_DB_PRESSURE_STARVATION_MS
    ),
  });
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
        observeQosTransition,
        starvation
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
    waitForBackgroundPermit: composeIntegrityHold(
      composeClaimPermit(pressureController.waitForBackgroundPermit, gate, starvation),
      integrityWatcher,
      (message, meta) => logger.warn(message, meta)
    ),
  };
}

export function createEmbeddingWorkerConfig(
  db: IDatabase,
  gate?: ForegroundEmbeddingGate
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
    claimBatchSize,
    concurrency,
    db,
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
      const emit = HIGH_FREQUENCY_EMBEDDING_LOG_MESSAGES.has(msg) ? logger.debug : logger.info;
      if (meta) {
        emit(msg, meta);
        return;
      }
      emit(msg);
    },
    onDownloadProgress: (modelId: string, progress: number) => {
      const store = useModelRegistryStore.getState();
      store.setDownloadProgress(modelId, progress);
      store.setDownloading(modelId, progress < 100);
    },
  };
}
