import {
  createDatabaseWorkScheduler,
  type DatabaseWorkOptions,
  type DatabaseWorkPriority,
  type DatabaseWorkScheduler,
  type DatabaseWorkSchedulerOptions,
  type DatabaseWorkSchedulerSnapshot,
  escapePGliteLiveQueryFormatPercents,
  parseManagedCacheBatchArgs,
} from '@brainstrike/db';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { createLogger } from '@brainstrike/utils/logger';
import type { LiveQuery, LiveQueryResults } from '@electric-sql/pglite/live';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow, ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import type { ChunkingHostManager } from './chunking-host-manager';
import { DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL } from './db-shared';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
} from './embedding-host-shared';
import { registerFileSystemIpcHandlers } from './ipc-domains/file-system-ipc';
import { registerStoragePreferencesIpcHandlers } from './ipc-domains/storage-preferences-ipc';
import {
  cancelAllDesktopEmbeddingBackfills,
  cancelDesktopEmbeddingBackfill,
  getDesktopEmbeddingBackfillsInFlight,
  isDisposedRenderFrameSendError,
  resolveEmbeddingBackfillRequest,
  runDesktopEmbeddingBackfill,
} from './ipc-embedding-backfill';
import type { DesktopSettingsStoreSchema } from './store-schema';

// import { getDatabase } from './db-main'; // Disabled - using renderer process database

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

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
const liveSubscriptionOwnerListeners = new Set<number>();
let nextLiveSubscriptionId = 1;
const logger = createLogger('DesktopIpcHandlers');
let desktopDatabaseWorkScheduler: DatabaseWorkScheduler = createDatabaseWorkScheduler();
let desktopDatabaseResetBarrier: Promise<void> | null = null;

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
const DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS = 5000;

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
  const workOptions = resolveDatabaseWorkOptions(
    event,
    registerOptions,
    explicitOptions,
    fallbackLabel
  );
  return waitForDesktopDatabaseResetBarrier().then(() =>
    desktopDatabaseWorkScheduler.run(operation, workOptions)
  );
}

export function getDesktopDatabaseWorkSchedulerSnapshot(): DatabaseWorkSchedulerSnapshot {
  return desktopDatabaseWorkScheduler.getSnapshot();
}

export function runDesktopScheduledDatabaseWork<T>(
  options: DatabaseWorkOptions,
  operation: () => Promise<T>
): Promise<T> {
  return waitForDesktopDatabaseResetBarrier().then(() =>
    desktopDatabaseWorkScheduler.run(operation, options)
  );
}

async function waitForDesktopDatabaseResetBarrier(): Promise<void> {
  const barrier = desktopDatabaseResetBarrier;
  if (!barrier) {
    return;
  }
  await barrier;
}

export async function runWithDesktopDatabaseResetBarrier<T>(
  operation: () => Promise<T>
): Promise<T> {
  if (desktopDatabaseResetBarrier) {
    throw new Error('Desktop database reset barrier is already active.');
  }

  let releaseBarrier!: () => void;
  desktopDatabaseResetBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  try {
    return await operation();
  } finally {
    releaseBarrier();
    desktopDatabaseResetBarrier = null;
  }
}

function isDesktopDatabaseWorkSchedulerIdle(snapshot: DatabaseWorkSchedulerSnapshot): boolean {
  return (
    snapshot.runningPriority === null &&
    snapshot.queued.foreground === 0 &&
    snapshot.queued.normal === 0 &&
    snapshot.queued.background === 0
  );
}

export async function waitForDesktopDatabaseWorkSchedulerIdle(
  timeoutMs = DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS
): Promise<void> {
  if (isDesktopDatabaseWorkSchedulerIdle(desktopDatabaseWorkScheduler.getSnapshot())) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const resolveIfIdle = (snapshot: DatabaseWorkSchedulerSnapshot) => {
      if (!isDesktopDatabaseWorkSchedulerIdle(snapshot)) {
        return;
      }
      cleanup();
      resolve();
    };

    timeout = setTimeout(() => {
      const snapshot = desktopDatabaseWorkScheduler.getSnapshot();
      cleanup();
      reject(
        new Error(
          `Desktop database work did not become idle within ${timeoutMs}ms. ` +
            `running=${snapshot.runningLabel ?? 'none'} queued=${JSON.stringify(snapshot.queued)}`
        )
      );
    }, timeoutMs);

    unsubscribe = desktopDatabaseWorkScheduler.subscribe(resolveIfIdle);
    resolveIfIdle(desktopDatabaseWorkScheduler.getSnapshot());
  });
}

export function resetDesktopDatabaseWorkSchedulerForTests(
  options?: DatabaseWorkSchedulerOptions
): void {
  desktopDatabaseWorkScheduler = createDatabaseWorkScheduler(options);
  desktopDatabaseResetBarrier = null;
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

export async function cleanupDesktopLiveSubscriptionsForShutdown(): Promise<void> {
  await cleanupAllLiveSubscriptions();
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

  const unregisterStoragePreferencesIpcHandlers = registerStoragePreferencesIpcHandlers({
    getStore,
    storage,
  });
  const unregisterFileSystemIpcHandlers = registerFileSystemIpcHandlers({
    fileSystem,
    storage,
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
    cancelAllDesktopEmbeddingBackfills();
  });

  registerHandler(
    EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL,
    async (_event: IpcMainInvokeEvent, embeddingSetId: unknown) => {
      if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
        throw new Error('Embedding backfill cancellation requires a non-empty embeddingSetId.');
      }
      cancelDesktopEmbeddingBackfill(embeddingSetId.trim());
    }
  );

  registerHandler(
    EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
    async (event: IpcMainInvokeEvent, embeddingSetId: unknown) =>
      withCorruptionRecovery(
        async () =>
          await runDesktopEmbeddingBackfill({
            databaseWorkScheduler: desktopDatabaseWorkScheduler,
            event,
            flushPendingLiveUpdates,
            isBackgrounded: () => isBackgrounded,
            ...resolveEmbeddingBackfillRequest(embeddingSetId, embeddingHostManager),
          }),
        EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL
      )
  );

  // Expose in-flight backfill state so the renderer can re-attach to progress
  // after a crash recovery reload.
  registerHandler(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL, async () =>
    getDesktopEmbeddingBackfillsInFlight()
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
    unregisterFileSystemIpcHandlers();
    unregisterStoragePreferencesIpcHandlers();
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    registeredChannels.clear();
    void cleanupAllLiveSubscriptions();
  };
}
