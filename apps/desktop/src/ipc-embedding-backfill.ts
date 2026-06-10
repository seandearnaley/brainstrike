import {
  createScheduledDbHandle,
  type DatabaseWorkPriority,
  type DatabaseWorkScheduler,
  JobQueue,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { createRequestId } from '@brainstrike/worker-runtime';
import type { IpcMainInvokeEvent } from 'electron';
import {
  BackfillMaintenanceCoordinator,
  type GpuMemoryReclaimConfig,
  type GpuMemoryReclaimMode,
} from './backfill-maintenance-coordinator';
import { getDatabase } from './db-main';
import { enqueueEmbeddingBackfill } from './embedding-backfill';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_BACKFILL_CANCELED_MESSAGE,
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  type EmbeddingBackfillSource,
} from './embedding-host-shared';

const logger = createLogger('DesktopEmbeddingBackfillIpc');

// Manual and background-indexing backfills are both user-visible indexing work,
// but neither should occupy the foreground UI database lane.
const EMBEDDING_BACKFILL_DATABASE_PRIORITY: DatabaseWorkPriority = 'background';
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_BATCHES = 4;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS = 250;
const BACKGROUND_INDEXING_BACKFILL_DRAIN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 10 * 60 * 1000;
// Automatic embedding-host reclaim remains opt-in. The real 12k-chunk desktop
// backfill path is stable without it, while automatic reclaim still introduces
// host lifecycle churn under load that can interrupt backfill.
const GPU_MEMORY_RECLAIM_DEFAULT_ENABLED = false;
const GPU_MEMORY_RECLAIM_DEFAULT_ITEM_THRESHOLD = 500;
const GPU_MEMORY_RECLAIM_DEFAULT_MINIMUM_INTERVAL_MS = 15_000;
// When reclaim is explicitly enabled, only in-renderer reset is supported.
// Full BrowserWindow recreation introduced host lifecycle churn and renderer
// instability under real backfill load.
const GPU_MEMORY_RECLAIM_DEFAULT_MODE: GpuMemoryReclaimMode = 'reset';
const MAX_EMBEDDING_BACKFILL_SET_ID_LENGTH = 256;
const EMBEDDING_BACKFILL_SET_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

interface EmbeddingBackfillInFlightState {
  progress: { current: number; total: number } | null;
  requestId: string;
  source: EmbeddingBackfillSource;
}

export interface EmbeddingBackfillRequest {
  gpuMemoryReclaimConfig: GpuMemoryReclaimConfig;
  hostManager: EmbeddingHostManager;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
}

const embeddingBackfillsInFlight = new Map<string, EmbeddingBackfillInFlightState>();
const embeddingBackfillsCanceled = new Set<string>();

export function resetEmbeddingBackfillStateForTests(): void {
  embeddingBackfillsInFlight.clear();
  embeddingBackfillsCanceled.clear();
}

function parseStrictBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new Error(`${name} must be set to one of: "true", "false", "1", or "0" when configured.`);
}

function parseStrictPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return Number.parseInt(raw, 10);
}

function parseStrictGpuMemoryReclaimModeEnv(
  name: string,
  fallback: GpuMemoryReclaimMode
): GpuMemoryReclaimMode {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === 'reset') {
    return raw;
  }
  throw new Error(`${name} must be set to "reset" when configured.`);
}

function resolveGpuMemoryReclaimConfig(): GpuMemoryReclaimConfig {
  return {
    enabled:
      parseStrictBooleanEnv('BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED') ??
      GPU_MEMORY_RECLAIM_DEFAULT_ENABLED,
    itemThreshold: parseStrictPositiveIntegerEnv(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD',
      GPU_MEMORY_RECLAIM_DEFAULT_ITEM_THRESHOLD
    ),
    minimumIntervalMs: parseStrictPositiveIntegerEnv(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS',
      GPU_MEMORY_RECLAIM_DEFAULT_MINIMUM_INTERVAL_MS
    ),
    mode: parseStrictGpuMemoryReclaimModeEnv(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE',
      GPU_MEMORY_RECLAIM_DEFAULT_MODE
    ),
  };
}

export function resolveEmbeddingBackfillRequest(
  request: unknown,
  embeddingHostManager: EmbeddingHostManager | null | undefined
): EmbeddingBackfillRequest {
  const embeddingSetId =
    typeof request === 'string'
      ? request
      : typeof request === 'object' && request !== null && 'embeddingSetId' in request
        ? (request as { embeddingSetId?: unknown }).embeddingSetId
        : null;
  if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
    throw new Error('Embedding backfill requires a non-empty embeddingSetId.');
  }
  const normalizedEmbeddingSetId = embeddingSetId.trim();
  if (normalizedEmbeddingSetId.length > MAX_EMBEDDING_BACKFILL_SET_ID_LENGTH) {
    throw new Error(
      `Embedding backfill embeddingSetId must be at most ${MAX_EMBEDDING_BACKFILL_SET_ID_LENGTH} characters.`
    );
  }
  if (!EMBEDDING_BACKFILL_SET_ID_PATTERN.test(normalizedEmbeddingSetId)) {
    throw new Error(
      'Embedding backfill embeddingSetId may only include letters, numbers, dots, underscores, hyphens, and colons.'
    );
  }
  if (!embeddingHostManager) {
    throw new Error('Embedding host manager is required for desktop backfill.');
  }
  const sourceCandidate =
    typeof request === 'object' && request !== null && 'source' in request
      ? (request as { source?: unknown }).source
      : undefined;
  const source: EmbeddingBackfillSource =
    sourceCandidate === 'background-indexing' ? 'background-indexing' : 'manual';
  return {
    hostManager: embeddingHostManager,
    normalizedEmbeddingSetId,
    gpuMemoryReclaimConfig: resolveGpuMemoryReclaimConfig(),
    source,
  };
}

export function isDisposedRenderFrameSendError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Electron does not currently expose a stable error code for this path, so
  // we have to match the message text. Verified against Electron 38.x; re-check
  // this contract during Electron upgrades or if Electron exposes a stable code.
  return error.message.toLowerCase().includes('frame was disposed');
}

function createDesktopBackfillProgressReporter(params: {
  backfillProgressTargetUnavailableRef: { current: boolean };
  backfillRequestId: string;
  event: IpcMainInvokeEvent;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
}): (done: number, total: number) => void {
  const {
    backfillProgressTargetUnavailableRef,
    backfillRequestId,
    event,
    normalizedEmbeddingSetId,
    source,
  } = params;

  return (done: number, total: number) => {
    const inFlight = embeddingBackfillsInFlight.get(normalizedEmbeddingSetId);
    if (inFlight) {
      inFlight.progress = { current: done, total };
    }
    if (backfillProgressTargetUnavailableRef.current || event.sender.isDestroyed()) {
      backfillProgressTargetUnavailableRef.current = true;
      return;
    }
    try {
      event.sender.send(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
        embeddingSetId: normalizedEmbeddingSetId,
        requestId: backfillRequestId,
        source,
        stage: 'backfill',
        current: done,
        total,
      });
    } catch (error) {
      if (isDisposedRenderFrameSendError(error)) {
        backfillProgressTargetUnavailableRef.current = true;
        logger.debug('Stopped desktop backfill progress sends after renderer frame disposal', {
          embeddingSetId: normalizedEmbeddingSetId,
          requestId: backfillRequestId,
        });
        return;
      }
      throw error;
    }
  };
}

export async function runDesktopEmbeddingBackfill(params: {
  databaseWorkScheduler: DatabaseWorkScheduler;
  event: IpcMainInvokeEvent;
  flushPendingLiveUpdates: () => void;
  gpuMemoryReclaimConfig: GpuMemoryReclaimConfig;
  hostManager: EmbeddingHostManager;
  isBackgrounded: () => boolean;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
}): Promise<{ requestId: string }> {
  const {
    databaseWorkScheduler,
    event,
    flushPendingLiveUpdates,
    gpuMemoryReclaimConfig,
    hostManager,
    isBackgrounded,
    normalizedEmbeddingSetId,
    source,
  } = params;
  if (embeddingBackfillsInFlight.has(normalizedEmbeddingSetId)) {
    throw new Error(`Embedding backfill is already running for set ${normalizedEmbeddingSetId}.`);
  }

  const backfillRequestId = createRequestId(
    source === 'background-indexing' ? 'background-indexing-backfill' : 'embedding-backfill'
  );
  const backfillProgressTargetUnavailableRef = { current: false };
  const maintenanceCoordinator = new BackfillMaintenanceCoordinator(
    gpuMemoryReclaimConfig,
    normalizedEmbeddingSetId,
    hostManager
  );
  embeddingBackfillsInFlight.set(normalizedEmbeddingSetId, {
    requestId: backfillRequestId,
    progress: null,
    source,
  });

  try {
    const hostStatus = await hostManager.ensureStarted({ waitForRunning: true });
    if (hostStatus.state !== 'running') {
      throw new Error(hostStatus.lastError ?? 'Embedding host failed to reach the running state.');
    }

    const db = await getDatabase();
    logger.info('Desktop embedding backfill scheduling resolved', {
      embeddingSetId: normalizedEmbeddingSetId,
      priority: EMBEDDING_BACKFILL_DATABASE_PRIORITY,
      requestId: backfillRequestId,
      source,
    });
    const scheduledDb = createScheduledDbHandle(
      db,
      databaseWorkScheduler,
      EMBEDDING_BACKFILL_DATABASE_PRIORITY
    );
    const jobQueue = new JobQueue(scheduledDb);

    await enqueueEmbeddingBackfill(
      scheduledDb,
      jobQueue,
      normalizedEmbeddingSetId,
      createDesktopBackfillProgressReporter({
        backfillProgressTargetUnavailableRef,
        backfillRequestId,
        event,
        normalizedEmbeddingSetId,
        source,
      }),
      {
        assertCanContinue: () => {
          if (embeddingBackfillsCanceled.has(normalizedEmbeddingSetId)) {
            throw new Error(EMBEDDING_BACKFILL_CANCELED_MESSAGE);
          }
          maintenanceCoordinator.assertCanContinue(hostManager.getStatus());
        },
        onDrainTick: async (completedSinceLastTick: number) => {
          maintenanceCoordinator.noteCompletedItems(completedSinceLastTick);
          await maintenanceCoordinator.runRequestedMaintenance();
        },
        progressIntervalBatches: EMBEDDING_BACKFILL_PROGRESS_INTERVAL_BATCHES,
        progressIntervalMs: EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS,
        ...(source === 'background-indexing'
          ? {
              drainTimeoutMs: BACKGROUND_INDEXING_BACKFILL_DRAIN_TIMEOUT_MS,
              queueCapacityTimeoutMs: BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
            }
          : {}),
      }
    );
    logger.info('Desktop embedding backfill completed', {
      embeddingSetId: normalizedEmbeddingSetId,
      requestId: backfillRequestId,
      source,
    });
    return { requestId: backfillRequestId };
  } catch (error) {
    // This invocation's IPC rejection is silently discarded by Electron when the
    // requesting renderer has been torn down (e.g. a top-level navigation
    // mid-backfill), so main MUST log the terminal outcome itself or the
    // backfill vanishes from the logs without a trace.
    const message = error instanceof Error ? error.message : String(error);
    // Classify canceled-vs-failed from the authoritative canceled set (still
    // populated here; the finally below clears it), not the error message —
    // a wrapped cancellation must not be logged at error level as a failure.
    if (embeddingBackfillsCanceled.has(normalizedEmbeddingSetId)) {
      logger.info('Desktop embedding backfill canceled', {
        embeddingSetId: normalizedEmbeddingSetId,
        requestId: backfillRequestId,
        source,
      });
    } else {
      logger.error('Desktop embedding backfill failed', {
        embeddingSetId: normalizedEmbeddingSetId,
        error: message,
        requestId: backfillRequestId,
        source,
      });
    }
    throw error;
  } finally {
    embeddingBackfillsInFlight.delete(normalizedEmbeddingSetId);
    embeddingBackfillsCanceled.delete(normalizedEmbeddingSetId);
    if (!isBackgrounded()) {
      flushPendingLiveUpdates();
    }
  }
}

export function cancelAllDesktopEmbeddingBackfills(): void {
  for (const embeddingSetId of embeddingBackfillsInFlight.keys()) {
    logCancellationRequested(embeddingSetId);
    embeddingBackfillsCanceled.add(embeddingSetId);
  }
}

export function cancelDesktopEmbeddingBackfill(embeddingSetId: string): void {
  logCancellationRequested(embeddingSetId);
  embeddingBackfillsCanceled.add(embeddingSetId);
}

function logCancellationRequested(embeddingSetId: string): void {
  const inFlight = embeddingBackfillsInFlight.get(embeddingSetId);
  logger.info('Desktop embedding backfill cancellation requested', {
    embeddingSetId,
    inFlight: Boolean(inFlight),
    ...(inFlight
      ? {
          progress: inFlight.progress,
          requestId: inFlight.requestId,
          source: inFlight.source,
        }
      : {}),
  });
}

export function getDesktopEmbeddingBackfillsInFlight(): Array<{
  embeddingSetId: string;
  progress: { current: number; total: number } | null;
  requestId: string;
  source: EmbeddingBackfillSource;
}> {
  return Array.from(embeddingBackfillsInFlight.entries()).map(([embeddingSetId, backfill]) => ({
    embeddingSetId,
    requestId: backfill.requestId,
    source: backfill.source,
    progress: backfill.progress,
  }));
}
