import {
  type DatabaseWorkOptions,
  escapePGliteLiveQueryFormatPercents,
  parseManagedCacheBatchArgs,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import type { LiveQuery, LiveQueryResults } from '@electric-sql/pglite/live';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow, ipcMain } from 'electron';
import { DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL } from '../db-shared';
import { isDisposedRenderFrameSendError } from '../ipc-embedding-backfill';
import {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resolveSqlParamsAndWorkOptions,
  runScheduledDatabaseWork,
} from '../platform/desktop-database-work';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';

interface DatabaseHostWindowMatcher {
  readonly isHostWindow: (window: BrowserWindow) => boolean;
}

interface RegisterDatabaseIpcHandlersOptions {
  readonly chunkingHostManager?: DatabaseHostWindowMatcher;
  readonly embeddingHostManager?: DatabaseHostWindowMatcher;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
}

interface LiveSubscriptionRecord {
  readonly handle: LiveQuery<unknown>;
  readonly id: number;
  readonly listener: (results: LiveQueryResults<unknown>) => void;
  readonly mode: 'query' | 'incremental';
  readonly webContentsId: number;
}

interface LiveQueryPayload {
  readonly key?: string;
  readonly limit?: number;
  readonly mode?: 'query' | 'incremental';
  readonly offset?: number;
  readonly params?: readonly unknown[];
  readonly query: string;
}

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
const liveSubscriptionOwnerListeners = new Set<number>();
const pendingLiveUpdates = new Map<number, { id: number; results: unknown }>();
const LIVE_FLUSH_BACKGROUND_INTERVAL_MS = 2000;
const LIVE_FLUSH_FOREGROUND_INTERVAL_MS = 200;
const logger = createLogger('DatabaseIpc');

let nextLiveSubscriptionId = 1;
let isBackgrounded = false;
let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
    reason,
    webContentsId,
  });
  pendingLiveUpdates.forEach((_payload, subId) => {
    const record = liveSubscriptions.get(subId);
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
      error,
      reason,
      webContentsId,
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
  pendingLiveUpdates.set(subscriptionId, { id: subscriptionId, results });
  if (!liveFlushTimer) {
    const intervalMs = isBackgrounded
      ? LIVE_FLUSH_BACKGROUND_INTERVAL_MS
      : LIVE_FLUSH_FOREGROUND_INTERVAL_MS;
    liveFlushTimer = setTimeout(flushPendingLiveUpdates, intervalMs);
  }
}

export function flushPendingLiveUpdates(): void {
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
        scheduleDisposedLiveSubscriptionOwnerCleanup(record.webContentsId, 'missing-owner');
        continue;
      }
      try {
        owner.webContents.send(DESKTOP_IPC_CHANNELS.db.liveQueryUpdate, payload);
      } catch (error) {
        if (isDisposedRenderFrameSendError(error)) {
          scheduleDisposedLiveSubscriptionOwnerCleanup(record.webContentsId, 'disposed-frame-send');
          continue;
        }
        logger.warn('Failed to deliver live query update to renderer', {
          error,
          subscriptionId: subId,
          webContentsId: record.webContentsId,
        });
      }
    }
  } finally {
    pendingLiveUpdates.clear();
  }
}

export function setBackgrounded(value: boolean): void {
  const wasBackgrounded = isBackgrounded;
  isBackgrounded = value;
  if (!value && wasBackgrounded) {
    flushPendingLiveUpdates();
  }
}

export function isDesktopDatabaseBackgrounded(): boolean {
  return isBackgrounded;
}

async function withCorruptionRecovery<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const { isCorruptionError, handleRuntimeCorruption } = await import('../db-main');
    if (isCorruptionError(error)) {
      logger.warn(`Corruption detected in ${context}, attempting auto-recovery...`);
      await handleRuntimeCorruption(context);
      return await operation();
    }
    throw error;
  }
}

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

async function handleLiveQueryRefreshError(
  error: unknown,
  queryId: number | undefined
): Promise<{ success: boolean; message: string; corrupted?: boolean }> {
  const { isCorruptionError, handleRuntimeCorruption } = await import('../db-main');
  if (isCorruptionError(error)) {
    logger.warn('Corruption detected in db:live-query:refresh, resetting database...');
    await handleRuntimeCorruption('db:live-query:refresh');
    return {
      corrupted: true,
      message: 'Database was corrupted and has been reset. Please reload the application.',
      success: false,
    };
  }
  logger.warn('Failed to refresh live query', { error, id: queryId });
  return {
    message: error instanceof Error ? error.message : String(error),
    success: false,
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
      key: payload.key,
      limit: payload.limit,
      offset: payload.offset,
      params: payload.params ?? null,
      query: escapePGliteLiveQueryFormatPercents(payload.query, payload.params),
    });
  }
  return await db.live.query({
    limit: payload.limit,
    offset: payload.offset,
    params: payload.params ?? null,
    query: escapePGliteLiveQueryFormatPercents(payload.query, payload.params),
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
    logger.warn('Failed to cleanup live query subscription', { error, id });
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

export function registerDatabaseIpcHandlers(
  options?: RegisterDatabaseIpcHandlersOptions
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.query,
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
          const { getDatabase } = await import('../db-main');
          const db = await getDatabase();
          return params === undefined ? await db.query(sql) : await db.query(sql, params);
        }, 'db:query')
      );
    }
  );

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.exec,
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
          const { getDatabase } = await import('../db-main');
          const db = await getDatabase();
          return params === undefined ? await db.exec(sql) : await db.exec(sql, params);
        }, 'db:exec')
      );
    }
  );

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryStart,
    async (
      event: IpcMainInvokeEvent,
      payload: LiveQueryPayload,
      workOptions?: DatabaseWorkOptions
    ) =>
      runScheduledDatabaseWork(event, options, workOptions, 'db:live-query:start', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('../db-main');
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
          liveSubscriptions.set(id, { handle, id, listener, mode, webContentsId: sender.id });
          registerLiveSubscriptionOwner(sender);

          return { id, initialResults: handle.initialResults };
        }, 'db:live-query:start')
      )
  );

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryStop,
    async (_event, id: number) => {
      await cleanupLiveSubscription(Number(id));
      return { success: true };
    }
  );

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryRefresh,
    async (
      event: IpcMainInvokeEvent,
      payload: { id: number; offset?: number; limit?: number },
      workOptions?: DatabaseWorkOptions
    ) => {
      const record = liveSubscriptions.get(Number(payload?.id));
      if (!record) {
        return { success: false, message: 'Subscription not found' };
      }
      return runScheduledDatabaseWork(
        event,
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

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.ping, async () => ({
    message: 'ping',
    success: true,
  }));

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.diagnostics, async () => {
    const { getDbHostManager } = await import('../db-host-manager');
    return await getDbHostManager().getDiagnostics();
  });

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.schedulerSnapshot, async () =>
    getDesktopDatabaseWorkSchedulerSnapshot()
  );

  registry.registerInvoke(
    'db',
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
            const { getDbHostManager } = await import('../db-host-manager');
            await getDbHostManager().applyManagedCacheBatch(parsedPayload);
          }, DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL)
      );
    }
  );

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.test, async () => {
    try {
      return await withCorruptionRecovery(async () => {
        const { getDatabase } = await import('../db-main');
        const db = await getDatabase();
        await db.query('SELECT 1');
        return {
          dbLocation: 'DB Host',
          message: 'Database connection successful',
          success: true,
        };
      }, 'db:test');
    } catch (error) {
      return {
        dbLocation: 'DB Host',
        message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      };
    }
  });

  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.clearAll,
    async (_event, confirmationToken?: string) => {
      try {
        if (!confirmationToken || confirmationToken !== 'CONFIRM_CLEAR_DATABASE') {
          return {
            deletedChunks: 0,
            deletedFiles: 0,
            message: 'Unauthorized: Invalid or missing confirmation token',
            success: false,
          };
        }

        const { getDatabase } = await import('../db-main');
        const db = await getDatabase();

        return await db.transaction(
          async (tx: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => {
            const chunksResult = await tx.query('SELECT COUNT(*) as count FROM file_chunks');
            const deletedChunks = Number(
              (chunksResult.rows[0] as { count: string | number })?.count || 0
            );

            const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
            const deletedFiles = Number(
              (filesResult.rows[0] as { count: string | number })?.count || 0
            );

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
            await clearOptionalRelation(tx, 'collection_indexing_stats');
            await clearOptionalRelation(tx, 'embedding_sets');
            await clearOptionalRelation(tx, 'job_queue');

            return {
              deletedChunks,
              deletedFiles,
              message: 'Database cleared successfully',
              success: true,
            };
          }
        );
      } catch (error) {
        const { isCorruptionError, handleRuntimeCorruption } = await import('../db-main');
        if (isCorruptionError(error)) {
          logger.warn('Corruption detected in db:clearAll, resetting database...');
          await handleRuntimeCorruption('db:clearAll');
          return {
            corrupted: true,
            deletedChunks: 0,
            deletedFiles: 0,
            message: 'Database was corrupted and has been fully reset.',
            success: true,
          };
        }
        return {
          deletedChunks: 0,
          deletedFiles: 0,
          message: `Database clear failed: ${error instanceof Error ? error.message : String(error)}`,
          success: false,
        };
      }
    }
  );

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.resetLocal, async () => {
    if (options?.onResetLocal) {
      return options.onResetLocal();
    }

    const { resetLocalDatabase } = await import('../db-main');
    try {
      await resetLocalDatabase();
      return { success: true };
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error), success: false };
    }
  });

  registry.registerInvoke('db', DESKTOP_IPC_CHANNELS.db.getUserDataPath, async () => {
    const { getDatabaseDiagnostics } = await import('../db-main');
    return getDatabaseDiagnostics().dataDir;
  });

  return () => {
    registry.unregisterAll();
    void cleanupAllLiveSubscriptions();
  };
}
