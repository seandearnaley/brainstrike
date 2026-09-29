import {
  createScheduledDbHandle,
  type DatabaseWorkPriority,
  type DatabaseWorkScheduler,
  type DimensionIndexMaintenanceStrategy,
  JobQueue,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { createRequestId } from '@brainstrike/worker-runtime';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import {
  BackfillMaintenanceCoordinator,
  type GpuMemoryReclaimConfig,
  type GpuMemoryReclaimMode,
} from './backfill-maintenance-coordinator';
import { assertBackgroundDatabaseWorkAdmitted } from './database-integrity-state';
import { getDatabase } from './db-main';
import { isDesktopShuttingDown, isExpectedBackfillTeardown } from './desktop-shutdown-state';
import {
  type EnqueueEmbeddingBackfillOptions,
  enqueueEmbeddingBackfill,
} from './embedding-backfill';
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
  progressTargets: Map<WebContents, EmbeddingBackfillProgressTarget>;
  requestId: string;
  source: EmbeddingBackfillSource;
}

interface EmbeddingBackfillProgressTarget {
  sender: WebContents;
  unavailableRef: { current: boolean };
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

function resolveBackgroundDimensionIndexMaintenanceStrategy(
  getDimensionIndexMaintenanceStrategy: (() => DimensionIndexMaintenanceStrategy | null) | undefined
): DimensionIndexMaintenanceStrategy {
  const strategy = getDimensionIndexMaintenanceStrategy?.() ?? null;
  if (!strategy) {
    throw new Error(
      'Background indexing backfill requires dimension index maintenance strategy from startup capability probe.'
    );
  }
  return strategy;
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
    gpuMemoryReclaimConfig: resolveGpuMemoryReclaimConfig(),
    hostManager: embeddingHostManager,
    normalizedEmbeddingSetId,
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

function createDesktopBackfillProgressTarget(
  event: IpcMainInvokeEvent
): EmbeddingBackfillProgressTarget {
  return {
    sender: event.sender,
    unavailableRef: { current: false },
  };
}

function registerDesktopBackfillProgressTarget(
  inFlight: EmbeddingBackfillInFlightState,
  event: IpcMainInvokeEvent
): EmbeddingBackfillProgressTarget {
  const target = createDesktopBackfillProgressTarget(event);
  inFlight.progressTargets.set(event.sender, target);
  return target;
}

function sendDesktopBackfillProgressToTarget(params: {
  current: number;
  message?: string;
  normalizedEmbeddingSetId: string;
  requestId: string;
  source: EmbeddingBackfillSource;
  stage: string;
  target: EmbeddingBackfillProgressTarget;
  total: number;
}): boolean {
  const { current, message, normalizedEmbeddingSetId, requestId, source, stage, target, total } =
    params;

  if (target.unavailableRef.current || target.sender.isDestroyed()) {
    target.unavailableRef.current = true;
    return false;
  }
  try {
    target.sender.send(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
      current,
      embeddingSetId: normalizedEmbeddingSetId,
      requestId,
      source,
      stage,
      total,
      ...(message ? { message } : {}),
    });
  } catch (error) {
    if (isDisposedRenderFrameSendError(error)) {
      target.unavailableRef.current = true;
      logger.debug('Stopped desktop backfill progress sends after renderer frame disposal', {
        embeddingSetId: normalizedEmbeddingSetId,
        requestId,
      });
      return false;
    }
    throw error;
  }
  return true;
}

function broadcastDesktopBackfillProgress(params: {
  current: number;
  message?: string;
  normalizedEmbeddingSetId: string;
  requestId: string;
  source: EmbeddingBackfillSource;
  stage: string;
  total: number;
}): void {
  const inFlight = embeddingBackfillsInFlight.get(params.normalizedEmbeddingSetId);
  if (!inFlight) {
    return;
  }
  for (const [sender, target] of inFlight.progressTargets) {
    const delivered = sendDesktopBackfillProgressToTarget({
      ...params,
      target,
    });
    if (!delivered) {
      inFlight.progressTargets.delete(sender);
    }
  }
}

function createDesktopBackfillProgressReporter(params: {
  backfillRequestId: string;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
}): (done: number, total: number) => void {
  const { backfillRequestId, normalizedEmbeddingSetId, source } = params;

  return (done: number, total: number) => {
    const inFlight = embeddingBackfillsInFlight.get(normalizedEmbeddingSetId);
    if (inFlight) {
      inFlight.progress = { current: done, total };
    }
    broadcastDesktopBackfillProgress({
      current: done,
      normalizedEmbeddingSetId,
      requestId: backfillRequestId,
      source,
      stage: 'backfill',
      total,
    });
  };
}

export async function runDesktopEmbeddingBackfill(params: {
  databaseWorkScheduler: DatabaseWorkScheduler;
  event: IpcMainInvokeEvent;
  flushPendingLiveUpdates: () => void;
  gpuMemoryReclaimConfig: GpuMemoryReclaimConfig;
  hostManager: EmbeddingHostManager;
  getDimensionIndexMaintenanceStrategy?: () => DimensionIndexMaintenanceStrategy | null;
  isBackgrounded: () => boolean;
  normalizedEmbeddingSetId: string;
  onDetachedFailure: (error: unknown) => Promise<void>;
  source: EmbeddingBackfillSource;
}): Promise<{ requestId: string }> {
  const {
    databaseWorkScheduler,
    event,
    flushPendingLiveUpdates,
    getDimensionIndexMaintenanceStrategy,
    gpuMemoryReclaimConfig,
    hostManager,
    isBackgrounded,
    normalizedEmbeddingSetId,
    onDetachedFailure,
    source,
  } = params;
  // Backfills are background database work: while an integrity error is
  // contained, refuse before the host starts or an in-flight entry exists.
  // Runs already in flight were canceled at the transition.
  assertBackgroundDatabaseWorkAdmitted();
  const inFlightBackfill = embeddingBackfillsInFlight.get(normalizedEmbeddingSetId);
  if (inFlightBackfill) {
    if (source === 'background-indexing') {
      const target = registerDesktopBackfillProgressTarget(inFlightBackfill, event);
      logger.info('Desktop background indexing backfill attached to existing run', {
        embeddingSetId: normalizedEmbeddingSetId,
        existingRequestId: inFlightBackfill.requestId,
        existingSource: inFlightBackfill.source,
        progress: inFlightBackfill.progress,
      });
      if (inFlightBackfill.progress) {
        sendDesktopBackfillProgressToTarget({
          current: inFlightBackfill.progress.current,
          normalizedEmbeddingSetId,
          requestId: inFlightBackfill.requestId,
          source: inFlightBackfill.source,
          stage: 'backfill',
          target,
          total: inFlightBackfill.progress.total,
        });
        if (target.unavailableRef.current) {
          inFlightBackfill.progressTargets.delete(event.sender);
        }
      }
      return { requestId: inFlightBackfill.requestId };
    }
    throw new Error(`Embedding backfill is already running for set ${normalizedEmbeddingSetId}.`);
  }

  const backfillRequestId = createRequestId(
    source === 'background-indexing' ? 'background-indexing-backfill' : 'embedding-backfill'
  );
  const maintenanceCoordinator = new BackfillMaintenanceCoordinator(
    gpuMemoryReclaimConfig,
    normalizedEmbeddingSetId,
    hostManager
  );
  const inFlightState: EmbeddingBackfillInFlightState = {
    progress: null,
    progressTargets: new Map(),
    requestId: backfillRequestId,
    source,
  };
  registerDesktopBackfillProgressTarget(inFlightState, event);
  embeddingBackfillsInFlight.set(normalizedEmbeddingSetId, inFlightState);

  const runBackfill = async (): Promise<void> => {
    if (isDesktopShuttingDown()) {
      // Starting the host now would recreate a hidden renderer that graceful
      // shutdown is about to dispose. Job rows stay durable for the next launch.
      throw new Error('Desktop is shutting down; the embedding backfill was not started.');
    }
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
    const backgroundIndexingOptions: Partial<EnqueueEmbeddingBackfillOptions> =
      source === 'background-indexing'
        ? {
            dimensionIndexMaintenanceStrategy: resolveBackgroundDimensionIndexMaintenanceStrategy(
              getDimensionIndexMaintenanceStrategy
            ),
            drainTimeoutMs: BACKGROUND_INDEXING_BACKFILL_DRAIN_TIMEOUT_MS,
            queueCapacityTimeoutMs: BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
            rebuildDimensionIndexOnCompletion: false,
          }
        : {};

    await enqueueEmbeddingBackfill(
      scheduledDb,
      jobQueue,
      normalizedEmbeddingSetId,
      createDesktopBackfillProgressReporter({
        backfillRequestId,
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
        ...backgroundIndexingOptions,
      }
    );
    logger.info('Desktop embedding backfill completed', {
      embeddingSetId: normalizedEmbeddingSetId,
      requestId: backfillRequestId,
      source,
    });
  };

  const runBackfillWithLifecycle = async (): Promise<void> => {
    try {
      await runBackfill();
      const progress = embeddingBackfillsInFlight.get(normalizedEmbeddingSetId)?.progress ?? {
        current: 0,
        total: 0,
      };
      broadcastDesktopBackfillProgress({
        current: progress.current,
        normalizedEmbeddingSetId,
        requestId: backfillRequestId,
        source,
        stage: 'complete',
        total: progress.total,
      });
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
      } else if (isExpectedBackfillTeardown(error)) {
        // Expected teardown: the app is shutting down, or the logger thread-stream
        // was disposed mid-backfill. Not a failure — embed jobs persist in
        // job_queue and resume next launch, and a suspended dimension index is
        // rebuilt by scheduled maintenance. Logged at info, no UI error. Neutral
        // wording (not "during shutdown") because a logger teardown can fire when
        // the app is not quitting — provenance must not lie. The shuttingDown
        // field records which case it actually was.
        logger.info('Desktop embedding backfill stopped (benign teardown)', {
          embeddingSetId: normalizedEmbeddingSetId,
          error: message,
          requestId: backfillRequestId,
          shuttingDown: isDesktopShuttingDown(),
          source,
        });
      } else {
        logger.error('Desktop embedding backfill failed', {
          embeddingSetId: normalizedEmbeddingSetId,
          error: message,
          requestId: backfillRequestId,
          source,
        });
        const progress = embeddingBackfillsInFlight.get(normalizedEmbeddingSetId)?.progress ?? {
          current: 0,
          total: 0,
        };
        broadcastDesktopBackfillProgress({
          current: progress.current,
          message,
          normalizedEmbeddingSetId,
          requestId: backfillRequestId,
          source,
          stage: 'error',
          total: progress.total,
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
  };

  if (source === 'background-indexing') {
    void runBackfillWithLifecycle().catch(async (error: unknown) => {
      // The IPC request has already resolved, so its containment wrapper cannot
      // observe this terminal failure. Route it back to the IPC domain after
      // lifecycle cleanup has settled.
      try {
        await onDetachedFailure(error);
      } catch (handlerError) {
        logger.error('Failed to handle detached desktop embedding backfill failure', {
          embeddingSetId: normalizedEmbeddingSetId,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
          requestId: backfillRequestId,
          source,
        });
      }
    });
    return { requestId: backfillRequestId };
  }

  await runBackfillWithLifecycle();
  return { requestId: backfillRequestId };
}

export function cancelAllDesktopEmbeddingBackfills(): void {
  for (const embeddingSetId of embeddingBackfillsInFlight.keys()) {
    logCancellationRequested(embeddingSetId);
    embeddingBackfillsCanceled.add(embeddingSetId);
  }
}

export function cancelDesktopEmbeddingBackfill(embeddingSetId: string): void {
  logCancellationRequested(embeddingSetId);
  if (embeddingBackfillsInFlight.has(embeddingSetId)) {
    embeddingBackfillsCanceled.add(embeddingSetId);
  }
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
    progress: backfill.progress,
    requestId: backfill.requestId,
    source: backfill.source,
  }));
}
