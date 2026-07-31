import {
  MASTRA_MEMORY_TABLES,
  MASTRA_VECTOR_TABLE,
  MASTRA_WORKFLOW_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  type DatabaseWorkOptions,
  escapePGliteLiveQueryFormatPercents,
  parseManagedCacheBatchArgs,
  type ResetTable,
  runStatementsInTransaction,
  type TransactionStatement,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import type { LiveQuery, LiveQueryResults } from '@electric-sql/pglite/live';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow, ipcMain } from 'electron';
import {
  DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL,
  DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL,
  DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL,
  parseInsertChunksAndEnqueueEmbeddingJobsArgs,
  parseManagedCacheInvalidationsArgs,
} from '../db-shared';
import { isDisposedRenderFrameSendError } from '../ipc-embedding-backfill';
import {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resolveSqlParamsAndWorkOptions,
  runScheduledDatabaseWork,
} from '../platform/desktop-database-work';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import {
  type RuntimeDatabaseCorruptionHandler,
  recoverRuntimeDatabaseCorruption,
} from './runtime-database-corruption';

interface DatabaseHostWindowMatcher {
  readonly isHostWindow: (window: BrowserWindow) => boolean;
}

interface RegisterDatabaseIpcHandlersOptions {
  readonly chunkingHostManager?: DatabaseHostWindowMatcher;
  readonly embeddingHostManager?: DatabaseHostWindowMatcher;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
  readonly onRuntimeCorruption?: RuntimeDatabaseCorruptionHandler;
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

interface PGliteLiveQuerySurface {
  readonly live: {
    readonly incrementalQuery: (options: {
      key: string;
      limit?: number;
      offset?: number;
      params: readonly unknown[] | null;
      query: string;
    }) => Promise<LiveQuery<unknown>>;
    readonly query: (options: {
      limit?: number;
      offset?: number;
      params: readonly unknown[] | null;
      query: string;
    }) => Promise<LiveQuery<unknown>>;
  };
}

/**
 * Derived from the reset-table registry (BST-992): the registry owns the SET
 * every table-enumerating reset path clears; this file owns desktop's order
 * and mechanics. `file_chunks`/`file_records` are excluded because `clearAll`
 * counts and bare-DELETEs them (they are guaranteed by migrations, never
 * legitimately absent), so they never go through the probe helper. A closed
 * literal union on purpose — with `to_regclass` a stale name is a permanent
 * silent skip, so `string` is forbidden here (platform-contracts).
 */
type OptionalRelationTable = Exclude<ResetTable, 'file_chunks' | 'file_records'>;

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
const liveSubscriptionOwnerListeners = new Set<number>();
const pendingLiveUpdates = new Map<number, { id: number; results: unknown }>();
const LIVE_FLUSH_BACKGROUND_INTERVAL_MS = 2000;
const LIVE_FLUSH_FOREGROUND_INTERVAL_MS = 200;
const MAX_RENDERER_SQL_BYTES = 1_000_000;
const logger = createLogger('DatabaseIpc');
const DESTRUCTIVE_SCHEMA_SQL_PATTERN =
  /(?:^|;)\s*(?:drop\s+\w+|truncate(?:\s+table)?\b|alter\s+table\b[^;]*\bdrop\s+(?:column|constraint|index|primary\s+key|foreign\s+key|unique|check|not\s+null|default|identity|expression)\b)/iu;

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

async function runWithCorruptionRecovery<T>(
  operation: () => Promise<T>,
  context: string,
  recover: RuntimeDatabaseCorruptionHandler
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const { isCorruptionError } = await import('../db-main');
    if (isCorruptionError(error)) {
      logger.warn(`Corruption detected in ${context}; replacing the database without retrying.`);
      await recover(context);
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
  queryId: number | undefined,
  recover: RuntimeDatabaseCorruptionHandler
): Promise<{ success: boolean; message: string; corrupted?: boolean }> {
  const { isCorruptionError } = await import('../db-main');
  if (isCorruptionError(error)) {
    logger.warn('Corruption detected in db:live-query:refresh, resetting database...');
    await recover('db:live-query:refresh');
  }
  logger.warn('Failed to refresh live query', { error, id: queryId });
  return {
    message: error instanceof Error ? error.message : String(error),
    success: false,
  };
}

/**
 * Deletes every row of a relation that may legitimately be ABSENT, PROBING for
 * it first rather than deleting and catching 42P01.
 *
 * The whole `db:clearAll` body runs inside ONE `db.transaction(...)`, and PGlite
 * is real Postgres: a statement error puts the transaction into the ABORTED
 * state, after which every later command fails with `25P02 current transaction
 * is aborted, commands ignored until end of transaction block` until ROLLBACK.
 * Catching the original 42P01 does NOT undo that, and there are no savepoints
 * anywhere in this repo — so a "tolerated" missing relation rolled the ENTIRE
 * clear back and the user's Clear Database silently did nothing. `to_regclass`
 * returns NULL for an absent relation instead of raising, so the probe can never
 * poison the transaction (BST-558 review).
 *
 * That hazard was live for `mastra_workflow_snapshot` — created lazily by
 * `PgliteWorkflowsStore.initialize()` and by NO migration, so "absent" is the
 * normal state for a never-used assistant. It was latent, not absent, for the
 * migration-created tables: unreachable only for as long as every one of them
 * keeps being created by a numbered migration that has already run. Probing
 * makes every call site safe BY CONSTRUCTION instead of by that coincidence.
 *
 * The DELETE after a successful probe is deliberately NOT wrapped. Nothing in
 * this repo ever DROPs these relations, so the probe/delete race is unreachable,
 * and a tolerated 42P01 there could not recover anyway — it would leave the
 * transaction aborted and resurface as a misleading 25P02. A genuine delete
 * failure must surface as itself.
 *
 * `tableName` is a fixed union, never a caller-supplied string: with
 * `to_regclass` a STALE name is indistinguishable from an absent table, so a
 * typo would become a permanent SILENT skip rather than a visible error. The
 * Mastra names come from the assistant-contract schema constants, never local
 * literals, for the same reason.
 */
async function clearOptionalRelation(
  tx: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  tableName: OptionalRelationTable
): Promise<void> {
  const probe = await tx.query(`SELECT to_regclass('${tableName}') IS NOT NULL AS present`);
  if ((probe.rows[0] as { present?: boolean } | undefined)?.present !== true) {
    // `debug`, not `warn`: warn+ records are persisted into
    // brainstrike_diagnostic_events — one of the tables this clear is emptying.
    logger.debug('Skipped absent database table during clear', { tableName });
    return;
  }
  await tx.query(`DELETE FROM ${tableName}`);
}

function getLiveQuerySurface(db: unknown): PGliteLiveQuerySurface {
  if (!db || typeof db !== 'object') {
    throw new Error('Live query extension is not available');
  }
  const live = (db as { live?: unknown }).live;
  if (!live || typeof live !== 'object') {
    throw new Error('Live query extension is not available');
  }
  const surface = live as { incrementalQuery?: unknown; query?: unknown };
  if (typeof surface.query !== 'function' || typeof surface.incrementalQuery !== 'function') {
    throw new Error('Live query extension is not available');
  }
  return db as PGliteLiveQuerySurface;
}

function assertRendererSql(channel: 'db:exec' | 'db:query' | 'db:transaction', sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error(`${channel} SQL must be a non-empty string.`);
  }
  if (sql.includes('\0')) {
    throw new Error(`${channel} SQL must not contain null bytes.`);
  }
  if (Buffer.byteLength(sql, 'utf8') > MAX_RENDERER_SQL_BYTES) {
    throw new Error(`${channel} SQL exceeds ${MAX_RENDERER_SQL_BYTES} bytes.`);
  }
  // The desktop renderer is trusted app code, not user-authored SQL. Some
  // local-first features still bootstrap app-owned tables through the exposed
  // database handle, but destructive schema/data-loss operations must stay on
  // named reset or migration paths. The matcher is statement-oriented so a
  // harmless literal like DEFAULT 'drop' is not treated as destructive DDL.
  if (DESTRUCTIVE_SCHEMA_SQL_PATTERN.test(sql)) {
    throw new Error(`${channel} does not permit destructive schema SQL from the renderer.`);
  }
}

async function createLiveQueryHandle(
  db: PGliteLiveQuerySurface,
  payload: LiveQueryPayload
): Promise<LiveQuery<unknown>> {
  const liveQueryOptions: {
    limit?: number;
    offset?: number;
    params: readonly unknown[] | null;
    query: string;
  } = {
    params: payload.params ?? null,
    query: escapePGliteLiveQueryFormatPercents(payload.query, payload.params),
  };
  if (payload.limit !== undefined) {
    liveQueryOptions.limit = payload.limit;
  }
  if (payload.offset !== undefined) {
    liveQueryOptions.offset = payload.offset;
  }

  const isIncremental = payload.mode === 'incremental';
  if (isIncremental) {
    if (!payload.key) {
      throw new Error('Live incremental queries require a key column');
    }
    return await db.live.incrementalQuery({
      ...liveQueryOptions,
      key: payload.key,
    });
  }
  return await db.live.query(liveQueryOptions);
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
  if (liveFlushTimer) {
    clearTimeout(liveFlushTimer);
    liveFlushTimer = null;
  }
  pendingLiveUpdates.clear();
  const ids = Array.from(liveSubscriptions.keys());
  if (ids.length > 0) {
    await Promise.allSettled(ids.map((id) => cleanupLiveSubscription(id)));
  }
  liveSubscriptions.clear();
  liveSubscriptionOwnerListeners.clear();
  nextLiveSubscriptionId = 1;
  isBackgrounded = false;
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
  const recover = async (context: string): Promise<void> => {
    // Stop renderer-owned reactive handles before the DB host is torn down.
    // This prevents their refresh timers from retaining the old database and
    // allocating an unbounded stream of failed updates during recovery.
    await cleanupAllLiveSubscriptions();
    await recoverRuntimeDatabaseCorruption(context, options?.onRuntimeCorruption);
  };
  const withCorruptionRecovery = async <T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> => await runWithCorruptionRecovery(operation, context, recover);

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
      assertRendererSql('db:query', sql);
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
      assertRendererSql('db:exec', sql);
      return runScheduledDatabaseWork(event, options, workOptions, 'db:exec', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('../db-main');
          const db = await getDatabase();
          return params === undefined ? await db.exec(sql) : await db.exec(sql, params);
        }, 'db:exec')
      );
    }
  );

  // Atomic transaction over IPC (#1141): run an ordered statement list inside ONE
  // pglite.transaction() in main and return statements[resultIndex] rows. PGlite's
  // transaction lock serializes a concurrent db:query (e.g. the FTS half of a hybrid
  // search) so it can't interleave — the isolation/error-coupling fix that raw
  // BEGIN/COMMIT over separate IPC calls can't provide.
  registry.registerInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.transaction,
    async (
      event: IpcMainInvokeEvent,
      statements: TransactionStatement[],
      resultIndex: number,
      workOptions?: DatabaseWorkOptions
    ) => {
      if (!Array.isArray(statements) || statements.length === 0) {
        throw new Error('db:transaction requires a non-empty statements array.');
      }
      for (const statement of statements) {
        assertRendererSql('db:transaction', statement?.sql);
      }
      return runScheduledDatabaseWork(event, options, workOptions, 'db:transaction', async () =>
        withCorruptionRecovery(async () => {
          const { getDatabase } = await import('../db-main');
          const db = await getDatabase();
          return runStatementsInTransaction(db, statements, resultIndex);
        }, 'db:transaction')
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

          const handle = await createLiveQueryHandle(getLiveQuerySurface(db), payload);
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
        return { message: 'Subscription not found', success: false };
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
            return await handleLiveQueryRefreshError(error, payload?.id, recover);
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

  registry.registerInvoke(
    'db',
    DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown, workOptions?: DatabaseWorkOptions) => {
      const parsedPayload = parseManagedCacheInvalidationsArgs(payload);
      return runScheduledDatabaseWork(
        event,
        options,
        workOptions,
        DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL,
        async () =>
          withCorruptionRecovery(async () => {
            const { getDbHostManager } = await import('../db-host-manager');
            return await getDbHostManager().invalidateManagedCacheEntriesByIdentity(parsedPayload);
          }, DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL)
      );
    }
  );

  registry.registerInvoke(
    'db',
    DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown, workOptions?: DatabaseWorkOptions) => {
      const parsedPayload = parseInsertChunksAndEnqueueEmbeddingJobsArgs(payload);
      return runScheduledDatabaseWork(
        event,
        options,
        workOptions,
        DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL,
        async () =>
          withCorruptionRecovery(async () => {
            const { getDbHostManager } = await import('../db-host-manager');
            await getDbHostManager().insertChunksAndEnqueueEmbeddingJobs(parsedPayload);
          }, DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL)
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
            // Previously delete-and-log: a non-missing-relation failure here was
            // only WARNED about and never rethrown, so the clear died one
            // statement later with a misleading `25P02 …transaction is
            // aborted…` instead of the real cause. Probing tolerates a genuinely
            // absent relation and lets every other failure surface as itself.
            await clearOptionalRelation(tx, 'selection_snapshot_files');
            await clearOptionalRelation(tx, 'selection_snapshots');
            await tx.query('DELETE FROM file_records');
            // After file_records (the FK child): stale roots would otherwise
            // survive clearAll and resurface as ghost workspaces once
            // consumers read the roots table.
            await clearOptionalRelation(tx, 'roots');
            await clearOptionalRelation(tx, 'collection_indexing_stats');
            await clearOptionalRelation(tx, 'embedding_sets');
            await clearOptionalRelation(tx, 'job_queue');
            // Durable per-thread token usage (Phase 5.1) is a new persisted
            // store; a factory reset must wipe it so cost/usage history does not
            // survive a "true fresh start" (see FACTORY RESET CONTRACT). It has
            // no FK, so nothing cascades it — it must be cleared explicitly.
            await clearOptionalRelation(tx, 'brainstrike_assistant_run_usage');
            // Terminal provider forensics are FK-less and may contain response
            // metadata/error text, so clear them before their parent runs.
            await clearOptionalRelation(tx, 'brainstrike_assistant_run_errors');
            // Per-run outcome labels (Task Ledger): analytic facts with no FK,
            // so nothing cascades them — clear explicitly per the FACTORY RESET
            // CONTRACT so verdict history cannot survive a fresh start.
            await clearOptionalRelation(tx, 'brainstrike_assistant_run_outcomes');
            // Durable per-thread assistant task list (P0 task-list tool): a
            // factory reset must wipe the plan so it does not survive a "true
            // fresh start" (FACTORY RESET CONTRACT). No FK, so clear explicitly.
            await clearOptionalRelation(tx, 'brainstrike_assistant_task_lists');
            // Per-turn edit checkpoint journal (undo of agent file edits): a
            // factory reset must wipe stored before-content + revert history so
            // it does not survive a "true fresh start" (FACTORY RESET CONTRACT).
            // No FK, so nothing cascades it — clear explicitly.
            await clearOptionalRelation(tx, 'brainstrike_assistant_edit_checkpoints');
            // assistant-ui branch topology is client-owned durable state; clear
            // it explicitly so prompt carousels cannot survive factory reset.
            await clearOptionalRelation(tx, 'brainstrike_assistant_message_parents');
            // Revisions cascade from prompt_items. The singleton embedding
            // profile is app configuration and remains available after clear.
            await clearOptionalRelation(tx, 'prompt_items');
            // Complete tool outputs are independently retained and have no FK
            // to Mastra messages, so clear them explicitly. Only an older
            // pre-migration-068 database may omit this table; any other delete
            // failure remains visible through clearOptionalRelation.
            await clearOptionalRelation(tx, 'brainstrike_assistant_tool_output_artifacts');
            // Brainstrike-owned thread grouping is durable assistant
            // presentation state. Clear placements before their logical group
            // parents, and clear both before the Mastra threads they organize.
            await clearOptionalRelation(tx, 'brainstrike_assistant_thread_placements');
            await clearOptionalRelation(tx, 'brainstrike_assistant_thread_groups');
            // Mastra creates all of its memory relations lazily, so a fresh
            // profile can legitimately omit any of them. Probe first, then wipe
            // every durable assistant-memory store so no conversation,
            // resource, or observational-memory state survives factory reset.
            await clearOptionalRelation(tx, MASTRA_MEMORY_TABLES.messages);
            await clearOptionalRelation(tx, MASTRA_MEMORY_TABLES.threads);
            await clearOptionalRelation(tx, MASTRA_MEMORY_TABLES.resources);
            await clearOptionalRelation(tx, MASTRA_MEMORY_TABLES.observationalMemory);
            // Vector rows may span multiple indexes, models, and namespaces.
            // Factory reset intentionally clears the whole relation rather than
            // guessing which subset belongs to the current configuration.
            await clearOptionalRelation(tx, MASTRA_VECTOR_TABLE);
            // Suspended Mastra workflow snapshots (BST-558): the only durable
            // assistant store with an UNBOUNDED lifetime — nothing deletes rows
            // in production, and a suspended run retains its pending tool call
            // and arguments. No FK cascades it, so clear it explicitly per the
            // FACTORY RESET CONTRACT. The table is created lazily by
            // PgliteWorkflowsStore.initialize() and by NO migration, so a
            // database where the assistant never ran legitimately lacks the
            // relation. That "absent" case is the NORMAL state here, not a
            // legacy edge — which is why clearOptionalRelation probes rather
            // than deletes-and-catches for every table it touches.
            await clearOptionalRelation(tx, MASTRA_WORKFLOW_TABLE);
            // Durable diagnostic events (Flight Recorder P1): warn+ error log.
            // No FK, so nothing cascades it — clear explicitly per the FACTORY
            // RESET CONTRACT so error history cannot survive a fresh start.
            await clearOptionalRelation(tx, 'brainstrike_diagnostic_events');
            // Thread search index rows are derived from mastra messages, but a
            // factory reset must wipe extracted text + the sync watermark so
            // conversation content cannot survive a "true fresh start" (FACTORY
            // RESET CONTRACT). The singleton search profile is app
            // configuration and remains, like the prompt profile.
            await clearOptionalRelation(tx, 'brainstrike_thread_message_index');
            await clearOptionalRelation(tx, 'brainstrike_thread_search_state');

            return {
              deletedChunks,
              deletedFiles,
              message: 'Database cleared successfully',
              success: true,
            };
          }
        );
      } catch (error) {
        const { isCorruptionError } = await import('../db-main');
        if (isCorruptionError(error)) {
          logger.warn('Corruption detected in db:clearAll, resetting database...');
          await recover('db:clearAll');
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
