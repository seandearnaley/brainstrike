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
import { createLogger } from '@brainstrike/logging';
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

const ALL_INDEXING_HOSTS_SENDER_POLICY = {
  reason:
    'Invoked by the visible UI and the chunking-host and embedding-host hidden hosts (dist/hidden-preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;
const VISIBLE_ONLY_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;
// Every `db:*` channel `hidden-preload.ts` exposes to the embedding host besides
// the shared `db:query` (chunking host: `db:query` only; llm host: no db bridge).
const EMBEDDING_HOST_SHARED_SENDER_POLICY = { roles: ['embedding-host', 'visible-ui'] } as const;

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

interface E2eDbLiveQueryDiagnostics {
  readonly hostLiveQueryCount: number;
  readonly ipcLiveQueryCount: number;
  readonly managerLiveQueryCount: number;
}

const E2E_DB_LIVE_QUERY_DIAGNOSTICS_KEY = '__brainstrike_e2e_db_live_query_diagnostics__' as const;
type E2eDbLiveQueryDiagnosticsGlobal = Partial<
  Record<typeof E2E_DB_LIVE_QUERY_DIAGNOSTICS_KEY, () => Promise<E2eDbLiveQueryDiagnostics>>
>;

/**
 * Derived from the reset-table registry (BST-992): the registry owns the SET
 * every table-enumerating reset path clears; this file owns desktop's order
 * and mechanics. `file_chunks`/`file_records` are excluded because `clearAll`
 * counts and bare-DELETEs them (they are guaranteed by migrations, never
 * legitimately absent), so they never go through the probe helper. A closed
 * literal union on purpose — with `to_regclass` a stale name is a permanent
 * silent skip, so `string` is forbidden here (platform-contracts).
 *
 * `RegisteredBareDeleted` closes the fail-open edge of `Exclude`: if either
 * name ever left the registry, a bare `Exclude` would silently stop removing
 * it, whereas this constrained alias makes it a compile error.
 */
type RegisteredBareDeleted<T extends ResetTable> = T;
type BareDeletedTable = RegisteredBareDeleted<'file_chunks' | 'file_records'>;
type OptionalRelationTable = Exclude<ResetTable, BareDeletedTable>;

/**
 * The lifecycle surface the live-query owner reaper needs from a WebContents.
 * `on`/`removeListener` attach and detach the teardown listeners; `id` keys the
 * subscription records.
 */
type LiveSubscriptionOwner = Pick<Electron.WebContents, 'id' | 'on' | 'removeListener'>;

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
// WeakSet/WeakMap — never strongly retain a WebContents (mirrors fs-watch's
// reaperAttachedOwners / ownerLifecycleGenerations in file-system-watch-ipc.ts).
const liveSubscriptionReaperAttachedOwners = new WeakSet<LiveSubscriptionOwner>();
// Invalidates a db:live-query:start whose createLiveQueryHandle await straddles
// a reap: the finished handle belongs to a dead renderer context and must be
// torn down instead of registered.
const liveSubscriptionOwnerGenerations = new WeakMap<LiveSubscriptionOwner, number>();
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

function isE2eTestMode(): boolean {
  return (
    process.argv.includes('--test-mode') ||
    process.env['ELECTRON_IS_E2E_TEST'] === 'true' ||
    process.env['NODE_ENV'] === 'test'
  );
}

function liveSubscriptionOwnerGeneration(owner: LiveSubscriptionOwner): number {
  return liveSubscriptionOwnerGenerations.get(owner) ?? 0;
}

async function cleanupLiveSubscriptionsForOwner(webContentsId: number): Promise<void> {
  const ownedSubscriptionIds = Array.from(liveSubscriptions.values())
    .filter((subscription) => subscription.webContentsId === webContentsId)
    .map((subscription) => subscription.id);

  await Promise.allSettled(ownedSubscriptionIds.map((id) => cleanupLiveSubscription(id)));
}

async function cleanupDisposedLiveSubscriptionOwner(
  webContentsId: number,
  reason: 'missing-owner' | 'disposed-frame-send' | 'owner-teardown'
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
  reason: 'missing-owner' | 'disposed-frame-send' | 'owner-teardown'
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

export function assertRendererSql(
  channel: 'db:exec' | 'db:query' | 'db:transaction',
  sql: string
): void {
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
  nextLiveSubscriptionId = 1;
  isBackgrounded = false;
}

export async function cleanupDesktopLiveSubscriptionsForShutdown(): Promise<void> {
  await cleanupAllLiveSubscriptions();
}

/**
 * Reap every live-query subscription this renderer owns when its context goes
 * away. Mirrors the fs-watch owner reaper (`attachOwnerReaper` in
 * file-system-watch-ipc.ts) and covers all three teardown shapes: window
 * closed ('destroyed'), renderer crash ('render-process-gone' — the
 * WebContents survives), and main-frame reload/navigation ('did-navigate' —
 * the old page's hooks are gone). A 'destroyed'-only hook leaks reload
 * orphans: the WebContents survives Cmd+R and crash-recovery reloads, so every
 * old-page subscription keeps being computed by PGlite, serialized over IPC,
 * and dropped by the new page's id filter — unbounded growth until window
 * close.
 *
 * Because 'did-navigate' fires while the WebContents SURVIVES, `reap` removes
 * ALL three listeners when any one fires — otherwise the siblings of the fired
 * event linger and the next db:live-query:start re-attaches a fresh set,
 * piling listeners up on one WebContents. Listeners are re-attached on the
 * next db:live-query:start after a reap. Any firing also bumps the owner
 * generation so a start whose createLiveQueryHandle await straddled the reap
 * can detect it and discard the fresh handle instead of registering an orphan.
 */
function attachLiveSubscriptionOwnerReaper(owner: LiveSubscriptionOwner): void {
  if (liveSubscriptionReaperAttachedOwners.has(owner)) {
    return;
  }
  liveSubscriptionReaperAttachedOwners.add(owner);
  const reap = (): void => {
    liveSubscriptionOwnerGenerations.set(owner, liveSubscriptionOwnerGeneration(owner) + 1);
    liveSubscriptionReaperAttachedOwners.delete(owner);
    // Remove ALL teardown listeners — a fired 'did-navigate' leaves the
    // WebContents alive, so its siblings would otherwise linger and pile up.
    owner.removeListener('destroyed', reap);
    owner.removeListener('render-process-gone', reap);
    owner.removeListener('did-navigate', reap);
    scheduleDisposedLiveSubscriptionOwnerCleanup(owner.id, 'owner-teardown');
  };
  owner.on('destroyed', reap);
  owner.on('render-process-gone', reap);
  owner.on('did-navigate', reap);
}

export function registerDatabaseIpcHandlers(
  options?: RegisterDatabaseIpcHandlersOptions
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const e2eGlobal = globalThis as typeof globalThis & E2eDbLiveQueryDiagnosticsGlobal;
  const e2eLiveQueryDiagnostics = isE2eTestMode()
    ? async (): Promise<E2eDbLiveQueryDiagnostics> => {
        const { getDbHostManager } = await import('../db-host-manager');
        const diagnostics = await getDbHostManager().getLiveQueryDiagnosticsForTests();
        return {
          ...diagnostics,
          ipcLiveQueryCount: liveSubscriptions.size,
        };
      }
    : null;
  if (e2eLiveQueryDiagnostics) {
    e2eGlobal[E2E_DB_LIVE_QUERY_DIAGNOSTICS_KEY] = e2eLiveQueryDiagnostics;
  }
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

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.query,
    ALL_INDEXING_HOSTS_SENDER_POLICY,
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

  registry.registerAuthorizedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.exec,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
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
  registry.registerAuthorizedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.transaction,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
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

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryStart,
    VISIBLE_ONLY_SENDER_POLICY,
    async (
      event: IpcMainInvokeEvent,
      payload: LiveQueryPayload,
      workOptions?: DatabaseWorkOptions
    ) => {
      const sender = event.sender;
      // Mirrors fs-watch's pre-attach guard: attaching to an already-destroyed
      // WebContents arms a reaper whose teardown events have ALREADY fired, so
      // no reap would ever arrive and the subscription would be registered
      // permanently, retaining the dead sender through the update listener.
      if (sender.isDestroyed()) {
        throw new Error('db:live-query:start: the requesting renderer is already destroyed.');
      }
      // Read the generation and attach the reaper BEFORE any await — a reload
      // or crash landing while this start is queued or while
      // createLiveQueryHandle is in flight must still be observable.
      const ownerGeneration = liveSubscriptionOwnerGeneration(sender);
      attachLiveSubscriptionOwnerReaper(sender);
      return runScheduledDatabaseWork(
        event,
        options,
        workOptions,
        'db:live-query:start',
        async () =>
          withCorruptionRecovery(async () => {
            const { getDatabase } = await import('../db-main');
            const db = await getDatabase();

            const handle = await createLiveQueryHandle(getLiveQuerySurface(db), payload);
            if (liveSubscriptionOwnerGeneration(sender) !== ownerGeneration) {
              // The requesting renderer context was reaped mid-setup: this
              // handle already belongs to a dead page. Registering it would
              // create a permanent orphan the reap (which already ran) cannot
              // see, so tear it down and surface the teardown visibly.
              try {
                await handle.unsubscribe();
              } catch (error) {
                // Guarded (unlike every other teardown, which goes through
                // cleanupLiveSubscription's tolerance): a rejection here must
                // neither replace the context-changed error below nor — via
                // withCorruptionRecovery — let a benign reload race trigger a
                // full database replacement. Logged, never swallowed silently.
                logger.warn('Failed to tear down a live-query handle reaped mid-setup', { error });
              }
              throw new Error(
                'db:live-query:start: the requesting renderer context changed during setup.'
              );
            }
            const mode: 'query' | 'incremental' =
              payload?.mode === 'incremental' ? 'incremental' : 'query';

            const id = nextLiveSubscriptionId++;
            const listener = (results: LiveQueryResults<unknown>) =>
              sendLiveQueryUpdateToSender(sender, id, results);

            handle.subscribe(listener);
            liveSubscriptions.set(id, { handle, id, listener, mode, webContentsId: sender.id });

            return { id, initialResults: handle.initialResults };
          }, 'db:live-query:start')
      );
    }
  );

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryStop,
    VISIBLE_ONLY_SENDER_POLICY,
    async (_event, id: number) => {
      await cleanupLiveSubscription(Number(id));
      return { success: true };
    }
  );

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.liveQueryRefresh,
    VISIBLE_ONLY_SENDER_POLICY,
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

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.ping,
    VISIBLE_ONLY_SENDER_POLICY,
    async () => ({
      message: 'ping',
      success: true,
    })
  );

  registry.registerAuthorizedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.diagnostics,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
    async () => {
      const { getDbHostManager } = await import('../db-host-manager');
      return await getDbHostManager().getDiagnostics();
    }
  );

  registry.registerAuthorizedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.schedulerSnapshot,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
    async () => getDesktopDatabaseWorkSchedulerSnapshot()
  );

  registry.registerAuthorizedInvoke(
    'db',
    DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
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

  registry.registerAuthorizedInvoke(
    'db',
    DB_INVALIDATE_MANAGED_CACHE_ENTRIES_BY_IDENTITY_CHANNEL,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
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

  registry.registerAuthorizedInvoke(
    'db',
    DB_INSERT_CHUNKS_AND_ENQUEUE_JOBS_CHANNEL,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
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

  registry.registerAuthorizedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.test,
    EMBEDDING_HOST_SHARED_SENDER_POLICY,
    async () => {
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
    }
  );

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.clearAll,
    VISIBLE_ONLY_SENDER_POLICY,
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
            // Per-run experiment treatment records (migration 093, BST-1250):
            // FK-less experiment evidence must not survive a fresh start.
            await clearOptionalRelation(tx, 'brainstrike_assistant_run_treatments');
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
            // Soft-rewind tombstones (migration 080, BST-1115): hidden-message
            // bookkeeping over conversation content this clear destroys. No FK,
            // so clear explicitly per the FACTORY RESET CONTRACT.
            await clearOptionalRelation(tx, 'brainstrike_assistant_message_tombstones');
            // Shadow-git snapshot ledger (migration 081, BST-1164): turn↔oid
            // bookkeeping for threads this clear destroys. No FK, so clear
            // explicitly per the FACTORY RESET CONTRACT.
            await clearOptionalRelation(tx, 'brainstrike_workspace_snapshots');
            // Versioned Canvas documents (migration 082, BST-1173): no FK, so
            // clear their thread-owned content explicitly.
            await clearOptionalRelation(tx, 'brainstrike_canvas_versions');
            // Durable per-tool model-facing telemetry (migration 083): no FK,
            // so counters for deleted runs must be cleared explicitly.
            await clearOptionalRelation(tx, 'brainstrike_tool_call_telemetry');
            // Estimator/provider prompt-token calibration pairs (migration
            // 086): no FK, so calibration evidence is cleared explicitly.
            await clearOptionalRelation(tx, 'brainstrike_token_estimate_calibration');
            // Superseded native-tool projection overlays (migration 084): no
            // FK, so request-build rewrite state is cleared explicitly.
            await clearOptionalRelation(tx, 'brainstrike_assistant_tool_projection_rewrites');
            // Conversation-compaction ranges (migration 088): no FK, so exact
            // summarized-message sets are cleared explicitly.
            await clearOptionalRelation(tx, 'brainstrike_assistant_compaction_ranges');
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
            await clearOptionalRelation(tx, 'brainstrike_assistant_thread_workspaces');
            await clearOptionalRelation(tx, 'brainstrike_delegated_tool_decisions');
            await clearOptionalRelation(tx, 'brainstrike_delegated_invocations');
            await clearOptionalRelation(tx, 'brainstrike_delegated_conversations');
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
            // Forge PR cache (migration 110, BST-1391): FK-less, main-written.
            await clearOptionalRelation(tx, 'brainstrike_forge_prs');
            await clearOptionalRelation(tx, 'brainstrike_worktrees');
            await clearOptionalRelation(tx, 'brainstrike_mcp_tasks');
            await clearOptionalRelation(tx, 'brainstrike_mcp_task_authorities');
            // Mind op-log (migration 079, BST-993): tombstones for data this
            // clear just destroyed must not survive onto the fresh database.
            await clearOptionalRelation(tx, 'brainstrike_mind_ops');
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

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.resetLocal,
    VISIBLE_ONLY_SENDER_POLICY,
    async () => {
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
    }
  );

  registry.registerUnauthenticatedInvoke(
    'db',
    DESKTOP_IPC_CHANNELS.db.getUserDataPath,
    VISIBLE_ONLY_SENDER_POLICY,
    async () => {
      const { getDatabaseDiagnostics } = await import('../db-main');
      return getDatabaseDiagnostics().dataDir;
    }
  );

  return () => {
    registry.unregisterAll();
    void cleanupAllLiveSubscriptions();
    if (e2eGlobal[E2E_DB_LIVE_QUERY_DIAGNOSTICS_KEY] === e2eLiveQueryDiagnostics) {
      delete e2eGlobal[E2E_DB_LIVE_QUERY_DIAGNOSTICS_KEY];
    }
  };
}
