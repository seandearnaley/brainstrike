import {
  createDatabasePressureController,
  type DatabasePressureSnapshotSource,
  type DatabaseWorkSchedulerSnapshot,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  type IDatabase,
} from '@brainstrike/db';
import type {
  EmbeddingWorkerOptions,
  ForegroundEmbeddingGate,
} from '@brainstrike/embeddings/worker';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('EmbeddingWorkerConfig');
// Desktop local embedding runs in a hidden renderer backed by the DB scheduler.
// Use WebGPU-sized batches when the scheduler is idle, then collapse to one-at-a-time
// under foreground pressure so browsing/searching remains foreground-first.
const DESKTOP_IDLE_EMBED_CLAIM_BATCH_SIZE = 16;
const DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE = 1;
const DESKTOP_EMBED_INTER_BATCH_DELAY_MS = 75;
const DESKTOP_PRESSURE_POLL_MS = 50;
const DESKTOP_SCHEDULER_SNAPSHOT_CACHE_MS = 10;
const DESKTOP_FOREGROUND_PRESSURE_WINDOW_MS = 1500;
const DESKTOP_FOREGROUND_WAIT_P95_THRESHOLD_MS = 75;
const DESKTOP_FOREGROUND_SERVICE_P95_THRESHOLD_MS = 120;

function parsePositiveIntegerEnv(
  name:
    | 'VITE_EMBED_CLAIM_BATCH_SIZE'
    | 'VITE_EMBED_CONCURRENCY'
    | 'VITE_EMBED_INTER_BATCH_DELAY_MS'
    | 'VITE_EMBED_LEASE_MS',
  fallback: number
): number {
  const raw = import.meta.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return parsed;
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
    getSnapshot: createCachedSchedulerSnapshotReader(schedulerSnapshot),
  };
}

function createCachedSchedulerSnapshotReader(
  readSnapshot: () => DatabaseWorkSchedulerSnapshot | Promise<DatabaseWorkSchedulerSnapshot>,
  now: () => number = () => Date.now()
): () => Promise<DatabaseWorkSchedulerSnapshot> {
  let cachedSnapshot: DatabaseWorkSchedulerSnapshot | null = null;
  let cachedAt = 0;
  let pendingSnapshot: Promise<DatabaseWorkSchedulerSnapshot> | null = null;
  return async () => {
    const readAt = now();
    if (cachedSnapshot && readAt - cachedAt <= DESKTOP_SCHEDULER_SNAPSHOT_CACHE_MS) {
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

function hasForegroundDatabasePressure(snapshot: DatabaseWorkSchedulerSnapshot): boolean {
  // The stats window is intentionally evaluated after the scheduler quiet
  // window: recent foreground work always wins, even if latency samples are low.
  // If the scheduler quiet window is tuned longer than this desktop stats
  // window, the quiet-window branch deliberately owns that full period.
  return (
    getDatabasePressureWaitingReason(snapshot, snapshot.snapshotAt, {
      foregroundPressureWindowMs: DESKTOP_FOREGROUND_PRESSURE_WINDOW_MS,
      foregroundServiceP95ThresholdMs: DESKTOP_FOREGROUND_SERVICE_P95_THRESHOLD_MS,
      foregroundWaitP95ThresholdMs: DESKTOP_FOREGROUND_WAIT_P95_THRESHOLD_MS,
    }) !== null
  );
}

type BackgroundPermit = NonNullable<EmbeddingWorkerOptions['waitForBackgroundPermit']>;

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
  idleClaimBatchSize: number,
  gate: ForegroundEmbeddingGate | undefined
): Pick<EmbeddingWorkerOptions, 'resolveClaimBatchSize' | 'waitForBackgroundPermit'> {
  const snapshotSource = createPressureSnapshotSource(db);
  const pressureController = createDatabasePressureController({
    pollMs: DESKTOP_PRESSURE_POLL_MS,
    snapshotSource,
  });
  return {
    resolveClaimBatchSize: async () => {
      const snapshot = await snapshotSource.getSnapshot();
      if (hasForegroundDatabasePressure(snapshot)) {
        return DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE;
      }
      return idleClaimBatchSize;
    },
    waitForBackgroundPermit: composeClaimPermit(pressureController.waitForBackgroundPermit, gate),
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
  const modelKey = import.meta.env['VITE_EMBED_MODEL_KEY'];

  return {
    db,
    claimBatchSize,
    concurrency,
    interBatchDelayMs,
    leaseMs,
    ...createDesktopPressureControls(db, claimBatchSize, gate),
    ...(modelKey ? { modelKey } : {}),
    log: (msg: string, meta?: unknown) => {
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
