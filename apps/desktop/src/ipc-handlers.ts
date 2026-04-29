import path from 'node:path';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  type DatabaseWorkOptions,
  type DatabaseWorkPriority,
  type DatabaseWorkScheduler,
  type DatabaseWorkSchedulerOptions,
  type DatabaseWorkSchedulerSnapshot,
  escapePGliteLiveQueryFormatPercents,
  JobQueue,
  parseManagedCacheBatchArgs,
} from '@brainstrike/db';
import type { DirectoryHandle, FileHandle, SerializableFileNode } from '@brainstrike/file-system';
import { AccessError, getTestDirectoryStructure } from '@brainstrike/file-system';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { LayoutLoadResult, LayoutPersistenceResult } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { createRequestId } from '@brainstrike/worker-runtime';
import type { LiveQuery, LiveQueryResults } from '@electric-sql/pglite/live';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow, ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import { z } from 'zod';
import {
  BackfillMaintenanceCoordinator,
  type GpuMemoryReclaimConfig,
  type GpuMemoryReclaimMode,
} from './backfill-maintenance-coordinator';
import type { ChunkingHostManager } from './chunking-host-manager';
import { DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL } from './db-shared';
import { enqueueEmbeddingBackfill } from './embedding-backfill';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_BACKFILL_CANCELED_MESSAGE,
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
  type EmbeddingBackfillSource,
} from './embedding-host-shared';
import { createFileReadErrorPayload } from './file-read-errors';
import type { DesktopSettingsStoreSchema } from './store-schema';

// import { getDatabase } from './db-main'; // Disabled - using renderer process database

// Storage keys for persistent data
const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;
const MOCK_PATH_PREFIX = '/mock/' as const;
const E2E_FILE_SYSTEM_FIXTURE_KEY = '__brainstrike_e2e_file_system_fixture__' as const;

/**
 * Register all IPC handlers used by the desktop application.
 */
interface RegisterIpcHandlerOptions {
  chunkingHostManager?: ChunkingHostManager;
  embeddingHostManager?: EmbeddingHostManager;
  onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
}

interface LiveSubscriptionRecord {
  handle: LiveQuery<unknown>;
  id: number;
  listener: (results: LiveQueryResults<unknown>) => void;
  mode: 'query' | 'incremental';
  webContentsId: number;
}

interface ElectronE2eFileSystemFixture {
  directoriesByPath: Record<string, SerializableFileNode[]>;
  fileContentsByPath: Record<string, string>;
  readDirectoryCalls: string[];
  readFileByPathCalls: string[];
  readFileCalls: string[];
  requestDirectoryAccessCount: number;
  rootHandle: DirectoryHandle & {
    id: string;
    type: 'directory';
  };
}

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
const liveSubscriptionOwnerListeners = new Set<number>();
let nextLiveSubscriptionId = 1;
const logger = createLogger('DesktopIpcHandlers');
let desktopDatabaseWorkScheduler: DatabaseWorkScheduler = createDatabaseWorkScheduler();

// ---------------------------------------------------------------------------
// Live query IPC throttling
//
// Live query updates are always queued in a Map (deduplicating by subscription
// ID) and flushed on a timer. This prevents IPC flooding during heavy database
// mutations (e.g., 30K-chunk embedding backfills that generate ~90K job_queue
// mutations, each triggering multiple live queries).
//
// Foreground: 200ms flush interval — responsive UI updates without flooding
// Background: subscriptions stay attached. PGlite 0.4.4 treats the last listener
// unsubscribe as terminal for a live-query handle, so pressure control must happen
// at the IPC delivery layer via deduped batched sends.
// Focus: immediate flush — user sees up-to-date state on return
// ---------------------------------------------------------------------------
let isBackgrounded = false;
const pendingLiveUpdates = new Map<number, { id: number; results: unknown }>();
let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_FLUSH_BACKGROUND_INTERVAL_MS = 2000;
const LIVE_FLUSH_FOREGROUND_INTERVAL_MS = 200;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_BATCHES = 4;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS = 250;
const BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS = 10 * 60 * 1000;
// Manual and background-indexing backfills are both user-visible indexing work,
// but neither should occupy the foreground UI database lane.
const EMBEDDING_BACKFILL_DATABASE_PRIORITY: DatabaseWorkPriority = 'background';
interface EmbeddingBackfillInFlightState {
  progress: { current: number; total: number } | null;
  requestId: string;
  source: EmbeddingBackfillSource;
}

const embeddingBackfillsInFlight = new Map<string, EmbeddingBackfillInFlightState>();
const embeddingBackfillsCanceled = new Set<string>();
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

interface EmbeddingBackfillRequest {
  gpuMemoryReclaimConfig: GpuMemoryReclaimConfig;
  hostManager: EmbeddingHostManager;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
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

function resolveEmbeddingBackfillRequest(
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
    normalizedEmbeddingSetId: embeddingSetId.trim(),
    gpuMemoryReclaimConfig: resolveGpuMemoryReclaimConfig(),
    source,
  };
}

function getElectronE2eFileSystemFixture(): ElectronE2eFileSystemFixture | null {
  const fixture = (
    globalThis as typeof globalThis & {
      [E2E_FILE_SYSTEM_FIXTURE_KEY]?: ElectronE2eFileSystemFixture;
    }
  )[E2E_FILE_SYSTEM_FIXTURE_KEY];
  return fixture ?? null;
}

function isDisposedRenderFrameSendError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Electron does not currently expose a stable error code for this path, so
  // we have to match the message text and update this check if Electron changes it.
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

async function runDesktopEmbeddingBackfill(params: {
  event: IpcMainInvokeEvent;
  gpuMemoryReclaimConfig: GpuMemoryReclaimConfig;
  hostManager: EmbeddingHostManager;
  normalizedEmbeddingSetId: string;
  source: EmbeddingBackfillSource;
}): Promise<{ requestId: string }> {
  const { event, gpuMemoryReclaimConfig, hostManager, normalizedEmbeddingSetId, source } = params;
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

    const { getDatabase } = await import('./db-main');
    const db = await getDatabase();
    logger.info('Desktop embedding backfill scheduling resolved', {
      embeddingSetId: normalizedEmbeddingSetId,
      priority: EMBEDDING_BACKFILL_DATABASE_PRIORITY,
      requestId: backfillRequestId,
      source,
    });
    const scheduledDb = createScheduledDbHandle(
      db,
      desktopDatabaseWorkScheduler,
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
              queueCapacityTimeoutMs: BACKGROUND_INDEXING_BACKFILL_QUEUE_CAPACITY_TIMEOUT_MS,
            }
          : {}),
      }
    );
    return { requestId: backfillRequestId };
  } finally {
    embeddingBackfillsInFlight.delete(normalizedEmbeddingSetId);
    embeddingBackfillsCanceled.delete(normalizedEmbeddingSetId);
    if (!isBackgrounded) {
      flushPendingLiveUpdates();
    }
  }
}

async function cleanupLiveSubscriptionsForOwner(
  webContentsId: number,
  options?: { releaseOwnerRegistration?: boolean }
): Promise<void> {
  if (options?.releaseOwnerRegistration) {
    liveSubscriptionOwnerListeners.delete(webContentsId);
  }
  const ownedSubscriptionIds = Array.from(liveSubscriptions.values())
    .filter((subscription) => subscription.webContentsId === webContentsId)
    .map((subscription) => subscription.id);

  await Promise.allSettled(ownedSubscriptionIds.map((id) => cleanupLiveSubscription(id)));
}

async function cleanupDisposedLiveSubscriptionOwner(
  webContentsId: number,
  reason: 'missing-owner' | 'disposed-frame-send'
): Promise<void> {
  logger.debug('Cleaning up live subscriptions for unavailable renderer owner', {
    webContentsId,
    reason,
  });
  pendingLiveUpdates.forEach((_payload, subId) => {
    const record = liveSubscriptions.get(subId);
    // Safe: deleting Map entries during forEach skips not-yet-visited keys per ES spec.
    if (record?.webContentsId === webContentsId) {
      pendingLiveUpdates.delete(subId);
    }
  });
  await cleanupLiveSubscriptionsForOwner(webContentsId);
}

function scheduleDisposedLiveSubscriptionOwnerCleanup(
  webContentsId: number,
  reason: 'missing-owner' | 'disposed-frame-send'
): void {
  void cleanupDisposedLiveSubscriptionOwner(webContentsId, reason).catch((error) => {
    logger.error('Failed to clean up live subscriptions for unavailable renderer owner', {
      webContentsId,
      reason,
      error,
    });
  });
}

function sendLiveQueryUpdateToSender(
  sender: Pick<Electron.WebContents, 'id' | 'isDestroyed' | 'send'>,
  subscriptionId: number,
  results: LiveQueryResults<unknown>
): void {
  if (sender.isDestroyed()) {
    void cleanupLiveSubscription(subscriptionId);
    return;
  }
  // Always dedup+batch: the Map overwrites previous pending updates for the
  // same subscription, so even thousands of mutations per flush window only
  // produce one IPC send per subscription.
  pendingLiveUpdates.set(subscriptionId, { id: subscriptionId, results });
  if (!liveFlushTimer) {
    const intervalMs = isBackgrounded
      ? LIVE_FLUSH_BACKGROUND_INTERVAL_MS
      : LIVE_FLUSH_FOREGROUND_INTERVAL_MS;
    liveFlushTimer = setTimeout(flushPendingLiveUpdates, intervalMs);
  }
}

function flushPendingLiveUpdates(): void {
  if (liveFlushTimer) {
    clearTimeout(liveFlushTimer);
    liveFlushTimer = null;
  }
  if (pendingLiveUpdates.size === 0) {
    return;
  }
  const allWindows = BrowserWindow.getAllWindows();
  try {
    for (const [subId, payload] of pendingLiveUpdates) {
      const record = liveSubscriptions.get(subId);
      if (!record) {
        continue;
      }
      const owner = allWindows.find((w) => w.webContents.id === record.webContentsId);
      if (!owner || owner.webContents.isDestroyed()) {
        // cleanupDisposedLiveSubscriptionOwner synchronously deletes other pending
        // entries for the same owner; Map iteration skips those deleted keys.
        scheduleDisposedLiveSubscriptionOwnerCleanup(record.webContentsId, 'missing-owner');
        continue;
      }
      try {
        owner.webContents.send('db:live-query:update', payload);
      } catch (error) {
        if (isDisposedRenderFrameSendError(error)) {
          scheduleDisposedLiveSubscriptionOwnerCleanup(record.webContentsId, 'disposed-frame-send');
          continue;
        }
        logger.warn('Failed to deliver live query update to renderer', {
          subscriptionId: subId,
          webContentsId: record.webContentsId,
          error,
        });
      }
    }
  } finally {
    // Intentional: each flush drops the queued batch after either delivering it or
    // logging an unrecoverable send failure. Subsequent live-query emissions enqueue
    // fresh state instead of retrying stale payloads.
    pendingLiveUpdates.clear();
  }
}

/** Flush any pending dedup+batch live query updates immediately. Exported for testing. */
export { flushPendingLiveUpdates };

export function setBackgrounded(value: boolean): void {
  const wasBackgrounded = isBackgrounded;
  isBackgrounded = value;
  if (!value && wasBackgrounded) {
    flushPendingLiveUpdates();
  }
}

function hasTooLargeCode(error: unknown): error is { code: 'TOO_LARGE'; message?: unknown } {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === 'TOO_LARGE';
}

function getFileTooLargeMessage(error: unknown): string | null {
  if (hasTooLargeCode(error)) {
    if (error instanceof Error) {
      return error.message;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : 'File too large';
  }

  if (error instanceof AccessError && error.operation === 'read') {
    return error.message.includes('File too large') ? error.message : null;
  }
  if (error instanceof Error && error.message.startsWith('File too large:')) {
    return error.message;
  }
  return null;
}

const panelPersistenceStateSchema = z.object({
  sizes: z.array(
    z.number().superRefine((value, ctx) => {
      if (!Number.isFinite(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Panel size must be a finite number',
        });
      }
    })
  ),
  showConsole: z.boolean(),
  showLeftPanel: z.boolean(),
  showRightPanel: z.boolean(),
});

/**
 * Wrap a database operation with corruption detection and auto-recovery.
 * If the operation fails with a corruption error (XX002, etc.), it will
 * reset the database and retry the operation once.
 */
async function withCorruptionRecovery<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const { isCorruptionError, handleRuntimeCorruption } = await import('./db-main');
    if (isCorruptionError(error)) {
      logger.warn(`Corruption detected in ${context}, attempting auto-recovery...`);
      await handleRuntimeCorruption(context);
      // Retry the operation with fresh database
      return await operation();
    }
    throw error;
  }
}

/**
 * Build refresh arguments from payload, filtering undefined values
 */
function buildRefreshArgs(
  payload: { offset?: number; limit?: number } | undefined
): { offset?: number; limit?: number } | undefined {
  if (!payload) {
    return;
  }
  const args: { offset?: number; limit?: number } = {};
  if (payload.offset !== undefined) {
    args.offset = payload.offset;
  }
  if (payload.limit !== undefined) {
    args.limit = payload.limit;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

/**
 * Handle errors from live query refresh, including corruption detection
 */
async function handleLiveQueryRefreshError(
  error: unknown,
  queryId: number | undefined
): Promise<{ success: boolean; message: string; corrupted?: boolean }> {
  const { isCorruptionError, handleRuntimeCorruption } = await import('./db-main');
  if (isCorruptionError(error)) {
    logger.warn('Corruption detected in db:live-query:refresh, resetting database...');
    await handleRuntimeCorruption('db:live-query:refresh');
    return {
      success: false,
      message: 'Database was corrupted and has been reset. Please reload the application.',
      corrupted: true,
    };
  }
  logger.warn('Failed to refresh live query', { id: queryId, error });
  return {
    success: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code === '42P01') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('relation') && message.includes('does not exist');
}

async function clearOptionalRelation(
  tx: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  tableName: string
): Promise<void> {
  try {
    await tx.query(`DELETE FROM ${tableName}`);
  } catch (error) {
    if (isMissingRelationError(error)) {
      return;
    }
    logger.warn('Failed to clear optional database table', { error, tableName });
    throw error;
  }
}

function isDatabaseWorkPriority(value: unknown): value is DatabaseWorkPriority {
  return value === 'foreground' || value === 'normal' || value === 'background';
}

function parseDatabaseWorkOptions(value: unknown): DatabaseWorkOptions {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database work options must be an object when provided.');
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'label')) {
    throw new Error('Database work options may only include priority and label.');
  }
  const candidate = value as { label?: unknown; priority?: unknown };
  if (candidate.priority !== undefined && !isDatabaseWorkPriority(candidate.priority)) {
    throw new Error('Database work priority must be foreground, normal, or background.');
  }
  if (candidate.label !== undefined && typeof candidate.label !== 'string') {
    throw new Error('Database work label must be a string when provided.');
  }
  const options: { label?: string; priority?: DatabaseWorkPriority } = {};
  if (candidate.label !== undefined) {
    options.label = candidate.label;
  }
  if (candidate.priority !== undefined) {
    options.priority = candidate.priority;
  }
  return options;
}

function isDatabaseWorkOptionsArgument(value: unknown): value is DatabaseWorkOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'label')) {
    return false;
  }
  const candidate = value as { label?: unknown; priority?: unknown };
  if (candidate.priority !== undefined && !isDatabaseWorkPriority(candidate.priority)) {
    return false;
  }
  return candidate.label === undefined || typeof candidate.label === 'string';
}

function resolveSqlParamsAndWorkOptions(
  channel: string,
  paramsOrOptions: unknown,
  maybeOptions: unknown
): {
  readonly params: unknown[] | undefined;
  readonly workOptions: unknown;
} {
  if (paramsOrOptions === undefined) {
    return { params: undefined, workOptions: maybeOptions };
  }
  if (Array.isArray(paramsOrOptions)) {
    return { params: paramsOrOptions, workOptions: maybeOptions };
  }
  if (isDatabaseWorkOptionsArgument(paramsOrOptions)) {
    return { params: undefined, workOptions: paramsOrOptions };
  }
  throw new Error(`${channel} parameters must be an array when provided.`);
}

function getSenderOwnerWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (!event.sender) {
    return null;
  }
  const sender = event.sender as IpcMainInvokeEvent['sender'] & {
    getOwnerBrowserWindow?: () => BrowserWindow | null;
  };
  const ownerFromSender = sender.getOwnerBrowserWindow?.();
  if (ownerFromSender) {
    return ownerFromSender;
  }
  const fromWebContents = (
    BrowserWindow as typeof BrowserWindow & {
      fromWebContents?: (webContents: IpcMainInvokeEvent['sender']) => BrowserWindow | null;
    }
  ).fromWebContents;
  return fromWebContents?.(event.sender) ?? null;
}

function resolveDefaultDatabaseWorkPriority(
  event: IpcMainInvokeEvent,
  options:
    | Pick<RegisterIpcHandlerOptions, 'chunkingHostManager' | 'embeddingHostManager'>
    | undefined
): DatabaseWorkPriority {
  const ownerWindow = getSenderOwnerWindow(event);
  if (ownerWindow && options?.embeddingHostManager?.isHostWindow(ownerWindow)) {
    return 'background';
  }
  if (ownerWindow && options?.chunkingHostManager?.isHostWindow(ownerWindow)) {
    return 'background';
  }
  return 'foreground';
}

function resolveDatabaseWorkOptions(
  event: IpcMainInvokeEvent,
  registerOptions:
    | Pick<RegisterIpcHandlerOptions, 'chunkingHostManager' | 'embeddingHostManager'>
    | undefined,
  explicitOptions: unknown,
  fallbackLabel: string
): DatabaseWorkOptions {
  const parsedOptions = parseDatabaseWorkOptions(explicitOptions);
  return {
    label: parsedOptions.label ?? fallbackLabel,
    priority: parsedOptions.priority ?? resolveDefaultDatabaseWorkPriority(event, registerOptions),
  };
}

function runScheduledDatabaseWork<T>(
  event: IpcMainInvokeEvent,
  registerOptions:
    | Pick<RegisterIpcHandlerOptions, 'chunkingHostManager' | 'embeddingHostManager'>
    | undefined,
  explicitOptions: unknown,
  fallbackLabel: string,
  operation: () => Promise<T>
): Promise<T> {
  return desktopDatabaseWorkScheduler.run(
    operation,
    resolveDatabaseWorkOptions(event, registerOptions, explicitOptions, fallbackLabel)
  );
}

export function getDesktopDatabaseWorkSchedulerSnapshot(): DatabaseWorkSchedulerSnapshot {
  return desktopDatabaseWorkScheduler.getSnapshot();
}

export function resetDesktopDatabaseWorkSchedulerForTests(
  options?: DatabaseWorkSchedulerOptions
): void {
  desktopDatabaseWorkScheduler = createDatabaseWorkScheduler(options);
}

interface LiveQueryPayload {
  key?: string;
  limit?: number;
  mode?: 'query' | 'incremental';
  offset?: number;
  params?: readonly unknown[];
  query: string;
}

/**
 * Create a live query handle based on the payload mode
 */
async function createLiveQueryHandle(
  // biome-ignore lint/suspicious/noExplicitAny: PGlite db type not available at compile time
  db: any,
  payload: LiveQueryPayload
): Promise<LiveQuery<unknown>> {
  const isIncremental = payload.mode === 'incremental';
  if (isIncremental) {
    if (!payload.key) {
      throw new Error('Live incremental queries require a key column');
    }
    return await db.live.incrementalQuery({
      query: escapePGliteLiveQueryFormatPercents(payload.query, payload.params),
      params: payload.params ?? null,
      key: payload.key,
      offset: payload.offset,
      limit: payload.limit,
    });
  }
  return await db.live.query({
    query: escapePGliteLiveQueryFormatPercents(payload.query, payload.params),
    params: payload.params ?? null,
    offset: payload.offset,
    limit: payload.limit,
  });
}

async function cleanupLiveSubscription(id: number): Promise<void> {
  const record = liveSubscriptions.get(id);
  if (!record) {
    return;
  }
  liveSubscriptions.delete(id);
  try {
    await record.handle.unsubscribe(record.listener);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    const normalizedMessage = rawMessage ? rawMessage.toLowerCase() : '';
    if (normalizedMessage.includes('pglite is closed')) {
      return;
    }
    logger.warn('Failed to cleanup live query subscription', { id, error });
  }
}

async function cleanupAllLiveSubscriptions(): Promise<void> {
  const ids = Array.from(liveSubscriptions.keys());
  if (ids.length === 0) {
    return;
  }
  await Promise.allSettled(ids.map((id) => cleanupLiveSubscription(id)));
  liveSubscriptions.clear();
  liveSubscriptionOwnerListeners.clear();
}

function registerLiveSubscriptionOwner(sender: Pick<Electron.WebContents, 'id' | 'once'>): void {
  if (liveSubscriptionOwnerListeners.has(sender.id)) {
    return;
  }

  liveSubscriptionOwnerListeners.add(sender.id);
  sender.once('destroyed', () => {
    void cleanupLiveSubscriptionsForOwner(sender.id, { releaseOwnerRegistration: true });
  });
}

export function registerIpcHandlers(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
  getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null,
  options?: RegisterIpcHandlerOptions
): () => void {
  const embeddingHostManager = options?.embeddingHostManager;
  const registeredChannels = new Set<string>();
  const registerHandler = <Args extends unknown[], Result>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
  ) => {
    ipcMain.handle(channel, handler);
    registeredChannels.add(channel);
  };

  registerHandler('storage:getItem', async (_e: IpcMainInvokeEvent, key: string) =>
    storage.getItem(key)
  );
  registerHandler('storage:setItem', async (_e: IpcMainInvokeEvent, key: string, value: string) =>
    storage.setItem(key, value)
  );
  registerHandler('storage:removeItem', async (_e: IpcMainInvokeEvent, key: string) =>
    storage.removeItem(key)
  );
  registerHandler('storage:clear', async (_e: IpcMainInvokeEvent) => storage.clear());
  registerHandler('storage:getAllKeys', async (_e: IpcMainInvokeEvent) => storage.getAllKeys());

  registerHandler('fs:requestDirectoryAccess', async (_e: IpcMainInvokeEvent) => {
    // Check if we're in test mode to avoid native dialogs
    const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];

    const nodeEnv = process.env['NODE_ENV'];
    const isTestMode =
      process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';

    if (isTestMode) {
      const fixture = getElectronE2eFileSystemFixture();
      if (fixture) {
        fixture.requestDirectoryAccessCount += 1;
        return fixture.rootHandle;
      }
      // Return a mock directory handle for testing
      return {
        id: 'mock-directory-handle',
        name: 'mock-test-directory',
        path: '/mock/test/directory',
        type: 'directory',
        kind: 'directory',
        platform: 'electron',
      };
    }

    return fileSystem.requestDirectoryAccess();
  });
  registerHandler('fs:readDirectory', async (_e: IpcMainInvokeEvent, handle: DirectoryHandle) => {
    const fixture = getElectronE2eFileSystemFixture();
    if (fixture) {
      fixture.readDirectoryCalls.push(handle.path);
      const entries = fixture.directoriesByPath[handle.path];
      if (!entries) {
        throw new AccessError(
          `Failed to read directory: no E2E fixture registered for ${handle.path}`,
          handle.path,
          'read'
        );
      }
      return entries;
    }

    // Check if this is a mock handle for testing
    if (
      handle &&
      typeof handle === 'object' &&
      'id' in handle &&
      handle.id === 'mock-directory-handle'
    ) {
      const rootPath = '/mock/test/directory';
      // Return IFileNode-compatible structure
      return getTestDirectoryStructure(rootPath);
    }
    return fileSystem.readDirectory(handle);
  });

  registerHandler('fs:readFile', async (_e: IpcMainInvokeEvent, handle: FileHandle) => {
    const fixture = getElectronE2eFileSystemFixture();
    if (fixture) {
      fixture.readFileCalls.push(handle.path);
      const content = fixture.fileContentsByPath[handle.path];
      if (content === undefined) {
        throw new AccessError(
          `Failed to read file: no E2E fixture registered for ${handle.path}`,
          handle.path,
          'read'
        );
      }
      return content;
    }

    // Check if this is a mock handle for testing
    if (
      handle &&
      typeof handle === 'object' &&
      'id' in handle &&
      String(handle.id).includes('mock-')
    ) {
      return 'Mock file content for testing purposes\nThis is a test file.\n';
    }
    try {
      return await fileSystem.readFile(handle);
    } catch (error) {
      const tooLargeMessage = getFileTooLargeMessage(error);
      if (!tooLargeMessage) {
        throw error;
      }
      logger.debug('Skipping oversized file read', {
        path: handle.path,
        message: tooLargeMessage,
      });
      return createFileReadErrorPayload(tooLargeMessage);
    }
  });

  // BST-307: Direct path-based file reading for persisted tab restoration
  registerHandler('fs:readFileByPath', async (_e: IpcMainInvokeEvent, absolutePath: string) => {
    const fixture = getElectronE2eFileSystemFixture();
    if (fixture) {
      fixture.readFileByPathCalls.push(absolutePath);
      const content = fixture.fileContentsByPath[absolutePath];
      if (content === undefined) {
        throw new AccessError(
          `Failed to read file by path: no E2E fixture registered for ${absolutePath}`,
          absolutePath,
          'read'
        );
      }
      return content;
    }

    // Check for mock paths in test mode
    if (absolutePath.startsWith(MOCK_PATH_PREFIX)) {
      return 'Mock file content for testing purposes\nThis is a test file.\n';
    }

    // Basic path validation
    const resolved = await resolveValidatedPath({ requestedPath: absolutePath });
    if (!resolved.ok) {
      throw new Error(`Invalid path: ${resolved.error}`);
    }

    try {
      return await fileSystem.readFileByPath(resolved.path);
    } catch (error) {
      const tooLargeMessage = getFileTooLargeMessage(error);
      if (!tooLargeMessage) {
        throw error;
      }
      logger.debug('Skipping oversized file read by path', {
        path: resolved.path,
        message: tooLargeMessage,
      });
      return createFileReadErrorPayload(tooLargeMessage);
    }
  });

  registerHandler('fs:exists', async (_e: IpcMainInvokeEvent, p: string) => {
    const fixture = getElectronE2eFileSystemFixture();
    if (fixture) {
      return (
        p === fixture.rootHandle.path ||
        p in fixture.directoriesByPath ||
        p in fixture.fileContentsByPath
      );
    }

    // Check for mock paths in test mode
    if (p.startsWith(MOCK_PATH_PREFIX)) {
      return true;
    }

    // Basic path validation - prevent obvious security issues
    const resolved = await resolveValidatedPath({ requestedPath: p });
    if (!resolved.ok) {
      logger.debug('Invalid path provided during exists check', {
        error: resolved.error,
        path: p,
      });
      return false;
    }

    return fileSystem.exists(resolved.path);
  });

  // Auto-restore last folder functionality for desktop

  /**
   * Attempts to restore the last opened folder if it still exists
   * @returns DirectoryHandle if successful, null if no folder or folder missing
   */
  registerHandler('fs:restoreLastFolder', async (_e: IpcMainInvokeEvent) => {
    try {
      const lastFolderPath = await storage.getItem(LAST_FOLDER_STORAGE_KEY);

      if (!lastFolderPath) {
        return null;
      }

      // Verify the folder still exists and is accessible
      const exists = await fileSystem.exists(lastFolderPath);

      if (!exists) {
        // Clean up invalid path
        await storage.removeItem(LAST_FOLDER_STORAGE_KEY);
        return null;
      }

      // Return a DirectoryHandle for the last folder
      const handle: DirectoryHandle = {
        path: lastFolderPath,
        name: path.basename(lastFolderPath),
        kind: 'directory' as const,
        platform: 'electron' as const,
      };
      return handle;
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Auto-restore failed', { error });
      }
      // If there's any error, just return null and let user select manually
      return null;
    }
  });

  /**
   * Saves the folder path for auto-restore on next application launch
   * @param folderPath - The folder path to save for future restoration
   */
  registerHandler('fs:saveLastFolder', async (_e: IpcMainInvokeEvent, folderPath: string) => {
    try {
      await storage.setItem(LAST_FOLDER_STORAGE_KEY, folderPath);
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.debug('Failed to save last folder', { error });
      }
      // Non-critical error, silently fail
      // The worst case is the user needs to select folder again on next launch
    }
  });

  // Layout persistence IPC handlers
  registerHandler(
    'layout:save',
    async (_e: IpcMainInvokeEvent, state: unknown): Promise<LayoutPersistenceResult> => {
      const store = getStore();
      if (!store) {
        logger.warn('Cannot save layout: store not initialized');
        return { success: false, message: 'Store not initialized' };
      }

      const parsed = panelPersistenceStateSchema.safeParse(state);
      if (!parsed.success) {
        logger.warn('Invalid panel layout payload', { issues: parsed.error.issues });
        return { success: false, message: 'Invalid panel layout payload' };
      }

      try {
        // Using proper type access for electron-store
        // biome-ignore lint/suspicious/noTsIgnore: Electron store types are incomplete
        // @ts-ignore
        store.set('panelLayout', { v1: parsed.data });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to save panel layout', { error: message });
        return { success: false, message };
      }
    }
  );

  registerHandler('layout:load', async (_e: IpcMainInvokeEvent): Promise<LayoutLoadResult> => {
    const store = getStore();
    if (!store) {
      logger.warn('Cannot load layout: store not initialized');
      return { success: false, message: 'Store not initialized' };
    }

    try {
      // Using proper type access for electron-store
      // biome-ignore lint/suspicious/noTsIgnore: Electron store types are incomplete
      // @ts-ignore
      const layout = store.get('panelLayout') as { v1?: unknown } | undefined;
      const candidate = layout?.v1;
      if (!candidate) {
        return { success: true, data: null };
      }

      const parsed = panelPersistenceStateSchema.safeParse(candidate);
      if (!parsed.success) {
        logger.warn('Invalid panel layout data in store', { issues: parsed.error.issues });
        return { success: false, message: 'Invalid panel layout data' };
      }

      return { success: true, data: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to load panel layout', { error: message });
      return { success: false, message };
    }
  });

  // Settings store clear handler for factory reset
  registerHandler('settings:clearAll', async (_e: IpcMainInvokeEvent) => {
    try {
      const store = getStore();
      if (!store) {
        return { success: false, message: 'Store not initialized' };
      }
      // Clear all settings from the store
      (store as ElectronStore<DesktopSettingsStoreSchema> & { clear: () => void }).clear();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Database IPC handlers (wrapped with corruption recovery)
  registerHandler(
    'db:query',
    async (
      event: IpcMainInvokeEvent,
      sql: string,
      paramsOrOptions?: unknown[] | DatabaseWorkOptions,
      maybeOptions?: DatabaseWorkOptions
    ) => {
      const { params, workOptions } = resolveSqlParamsAndWorkOptions(
        'db:query',
        paramsOrOptions,
        maybeOptions
      );
      return runScheduledDatabaseWork(event, options, workOptions, 'db:query', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('./db-main');
          const db = await getDatabase();
          return params === undefined ? await db.query(sql) : await db.query(sql, params);
        }, 'db:query')
      );
    }
  );

  registerHandler(
    'db:exec',
    async (
      event: IpcMainInvokeEvent,
      sql: string,
      paramsOrOptions?: unknown[] | DatabaseWorkOptions,
      maybeOptions?: DatabaseWorkOptions
    ) => {
      const { params, workOptions } = resolveSqlParamsAndWorkOptions(
        'db:exec',
        paramsOrOptions,
        maybeOptions
      );
      return runScheduledDatabaseWork(event, options, workOptions, 'db:exec', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('./db-main');
          const db = await getDatabase();
          return params === undefined ? await db.exec(sql) : await db.exec(sql, params);
        }, 'db:exec')
      );
    }
  );

  registerHandler(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL, async () => {
    for (const embeddingSetId of embeddingBackfillsInFlight.keys()) {
      embeddingBackfillsCanceled.add(embeddingSetId);
    }
  });

  registerHandler(
    EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
    async (_event: IpcMainInvokeEvent, embeddingSetId: unknown) => {
      if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
        throw new Error('Embedding backfill cancellation requires a non-empty embeddingSetId.');
      }
      embeddingBackfillsCanceled.add(embeddingSetId.trim());
    }
  );

  registerHandler(
    EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
    async (event: IpcMainInvokeEvent, embeddingSetId: unknown) =>
      withCorruptionRecovery(
        async () =>
          await runDesktopEmbeddingBackfill({
            event,
            ...resolveEmbeddingBackfillRequest(embeddingSetId, embeddingHostManager),
          }),
        EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL
      )
  );

  // Expose in-flight backfill state so the renderer can re-attach to progress
  // after a crash recovery reload.
  registerHandler(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL, async () =>
    Array.from(embeddingBackfillsInFlight.entries()).map(([embeddingSetId, backfill]) => ({
      embeddingSetId,
      requestId: backfill.requestId,
      source: backfill.source,
      progress: backfill.progress,
    }))
  );

  registerHandler(
    'db:live-query:start',
    async (
      event: IpcMainInvokeEvent,
      payload: LiveQueryPayload,
      workOptions?: DatabaseWorkOptions
    ) =>
      runScheduledDatabaseWork(event, options, workOptions, 'db:live-query:start', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('./db-main');
          const db = await getDatabase();
          if (!db.live) {
            throw new Error('Live query extension is not available');
          }

          const handle = await createLiveQueryHandle(db, payload);
          const mode: 'query' | 'incremental' =
            payload?.mode === 'incremental' ? 'incremental' : 'query';

          const id = nextLiveSubscriptionId++;
          const sender = event.sender;
          const listener = (results: LiveQueryResults<unknown>) =>
            sendLiveQueryUpdateToSender(sender, id, results);

          handle.subscribe(listener);
          liveSubscriptions.set(id, { id, mode, handle, listener, webContentsId: sender.id });
          registerLiveSubscriptionOwner(sender);

          return { id, initialResults: handle.initialResults };
        }, 'db:live-query:start')
      )
  );

  registerHandler('db:live-query:stop', async (_event: IpcMainInvokeEvent, id: number) => {
    await cleanupLiveSubscription(Number(id));
    return { success: true };
  });

  registerHandler(
    'db:live-query:refresh',
    async (
      _event: IpcMainInvokeEvent,
      payload: { id: number; offset?: number; limit?: number },
      workOptions?: DatabaseWorkOptions
    ) => {
      const record = liveSubscriptions.get(Number(payload?.id));
      if (!record) {
        return { success: false, message: 'Subscription not found' };
      }
      return runScheduledDatabaseWork(
        _event,
        options,
        workOptions,
        'db:live-query:refresh',
        async () => {
          try {
            const refreshArgs = buildRefreshArgs(payload);
            await record.handle.refresh(refreshArgs);
            return { success: true };
          } catch (error) {
            return await handleLiveQueryRefreshError(error, payload?.id);
          }
        }
      );
    }
  );

  // Database test handler for connection validation
  registerHandler('db:ping', async (_e: IpcMainInvokeEvent) => {
    // Lightweight connectivity check; does not initialize DB
    return { success: true, message: 'ping' };
  });

  registerHandler('db:diagnostics', async (_e: IpcMainInvokeEvent) => {
    const { getDbHostManager } = await import('./db-host-manager');
    return await getDbHostManager().getDiagnostics();
  });

  registerHandler('db:scheduler:snapshot', async (_e: IpcMainInvokeEvent) =>
    getDesktopDatabaseWorkSchedulerSnapshot()
  );

  registerHandler(
    DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown, workOptions?: DatabaseWorkOptions) => {
      const parsedPayload = parseManagedCacheBatchArgs(payload);
      return runScheduledDatabaseWork(
        event,
        options,
        workOptions,
        DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL,
        async () =>
          withCorruptionRecovery(async () => {
            const { getDbHostManager } = await import('./db-host-manager');
            await getDbHostManager().applyManagedCacheBatch(parsedPayload);
          }, DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL)
      );
    }
  );

  // Database test handler for full connection validation
  registerHandler('db:test', async (_e: IpcMainInvokeEvent) => {
    try {
      return await withCorruptionRecovery(async () => {
        const { getDatabase } = await import('./db-main');
        const db = await getDatabase();
        await db.query('SELECT 1');
        return {
          success: true,
          message: 'Database connection successful',
          dbLocation: 'DB Host',
        };
      }, 'db:test');
    } catch (error) {
      return {
        success: false,
        message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        dbLocation: 'DB Host',
      };
    }
  });

  // Bulk database cleanup handler - requires confirmation token for security
  registerHandler('db:clearAll', async (_e: IpcMainInvokeEvent, confirmationToken?: string) => {
    try {
      // Require confirmation token to prevent unauthorized clearing
      if (!confirmationToken || confirmationToken !== 'CONFIRM_CLEAR_DATABASE') {
        return {
          success: false,
          message: 'Unauthorized: Invalid or missing confirmation token',
          deletedFiles: 0,
          deletedChunks: 0,
        };
      }

      const { getDatabase } = await import('./db-main');
      const db = await getDatabase();

      // Use transaction for atomic operation
      return await db.transaction(
        async (tx: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => {
          // Count before deleting for feedback
          const chunksResult = await tx.query('SELECT COUNT(*) as count FROM file_chunks');
          const deletedChunks = Number(
            (chunksResult.rows[0] as { count: string | number })?.count || 0
          );

          const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
          const deletedFiles = Number(
            (filesResult.rows[0] as { count: string | number })?.count || 0
          );

          // Clear chunks first due to foreign key constraints
          await tx.query('DELETE FROM file_chunks');
          try {
            await tx.query('DELETE FROM selection_snapshot_files');
            await tx.query('DELETE FROM selection_snapshots');
          } catch (error) {
            if (!isMissingRelationError(error)) {
              logger.warn('Failed to clear selection snapshots', { error });
            }
          }
          await tx.query('DELETE FROM file_records');
          // Clear embedding sets and any queued jobs
          await clearOptionalRelation(tx, 'collection_indexing_stats');
          await clearOptionalRelation(tx, 'embedding_sets');
          await clearOptionalRelation(tx, 'job_queue');

          return {
            success: true,
            message: 'Database cleared successfully',
            deletedFiles,
            deletedChunks,
          };
        }
      );
    } catch (error) {
      // Check for corruption and attempt recovery
      const { isCorruptionError, handleRuntimeCorruption } = await import('./db-main');
      if (isCorruptionError(error)) {
        logger.warn('Corruption detected in db:clearAll, resetting database...');
        await handleRuntimeCorruption('db:clearAll');
        return {
          success: true,
          message: 'Database was corrupted and has been fully reset.',
          deletedFiles: 0,
          deletedChunks: 0,
          corrupted: true,
        };
      }
      return {
        success: false,
        message: `Database clear failed: ${error instanceof Error ? error.message : String(error)}`,
        deletedFiles: 0,
        deletedChunks: 0,
      };
    }
  });

  // Hard reset database on disk (desktop only)
  registerHandler('db:resetLocal', async (_e: IpcMainInvokeEvent) => {
    if (options?.onResetLocal) {
      return options.onResetLocal();
    }

    const { resetLocalDatabase } = await import('./db-main');
    try {
      await resetLocalDatabase();
      return { success: true };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  // Database path IPC handler for PGlite directory
  registerHandler('db:getUserDataPath', async (_e: IpcMainInvokeEvent) => {
    const { getDatabaseDiagnostics } = await import('./db-main');
    return getDatabaseDiagnostics().dataDir;
  });

  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    registeredChannels.clear();
    void cleanupAllLiveSubscriptions();
  };
}
