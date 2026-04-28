import {
  createDatabasePressureController,
  type DatabasePressureSnapshotSource,
  type DatabaseWorkSchedulerSnapshot,
  getDatabaseWorkScheduler,
  type IDatabase,
} from '@brainstrike/db';
import type { EmbeddingWorkerOptions } from '@brainstrike/embeddings/worker';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('EmbeddingWorkerConfig');
const DESKTOP_IDLE_EMBED_CLAIM_BATCH_SIZE = 16;
const DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE = 1;
const DESKTOP_EMBED_INTER_BATCH_DELAY_MS = 75;
const DESKTOP_PRESSURE_POLL_MS = 50;
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
    getSnapshot: schedulerSnapshot,
  };
}

function hasForegroundDatabasePressure(snapshot: DatabaseWorkSchedulerSnapshot): boolean {
  // Normal priority is treated as foreground-visible pressure in the desktop
  // embedding host: it is used for user-facing DB work that should still run
  // ahead of background embedding claims.
  if (snapshot.runningPriority === 'foreground' || snapshot.runningPriority === 'normal') {
    return true;
  }
  if (snapshot.queued.foreground > 0 || snapshot.queued.normal > 0) {
    return true;
  }
  const now = snapshot.snapshotAt;
  if (
    snapshot.lastForegroundAt !== null &&
    now - snapshot.lastForegroundAt < snapshot.foregroundQuietMs
  ) {
    return true;
  }
  // The stats window is intentionally evaluated after the scheduler quiet
  // window: recent foreground work always wins, even if latency samples are low.
  if (
    snapshot.lastForegroundAt !== null &&
    now - snapshot.lastForegroundAt <= DESKTOP_FOREGROUND_PRESSURE_WINDOW_MS
  ) {
    const foregroundStats = snapshot.priorityStats.foreground;
    return (
      foregroundStats.waitP95Ms > DESKTOP_FOREGROUND_WAIT_P95_THRESHOLD_MS ||
      foregroundStats.serviceP95Ms > DESKTOP_FOREGROUND_SERVICE_P95_THRESHOLD_MS
    );
  }
  return false;
}

function createDesktopPressureControls(
  db: IDatabase,
  idleClaimBatchSize: number
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
    waitForBackgroundPermit: pressureController.waitForBackgroundPermit,
  };
}

export function createEmbeddingWorkerConfig(db: IDatabase): EmbeddingWorkerOptions {
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
    ...createDesktopPressureControls(db, claimBatchSize),
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
