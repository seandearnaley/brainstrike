import path from 'node:path';
import { JobQueue } from '@brainstrike/db';
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
import { enqueueEmbeddingBackfill } from './embedding-backfill';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
  EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL,
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

// ---------------------------------------------------------------------------
// Live query IPC throttling
//
// Live query updates are always queued in a Map (deduplicating by subscription
// ID) and flushed on a timer. This prevents IPC flooding during heavy database
// mutations (e.g., 30K-chunk embedding backfills that generate ~90K job_queue
// mutations, each triggering multiple live queries).
//
// Foreground: 200ms flush interval — responsive UI updates without flooding
// Background: 2000ms flush interval — reduces idle IPC traffic
// Focus: immediate flush — user sees up-to-date state on return
// ---------------------------------------------------------------------------
let isBackgrounded = false;
let liveSubscriptionPauseDepth = 0;
const pendingLiveUpdates = new Map<number, { id: number; results: unknown }>();
let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_FLUSH_BACKGROUND_INTERVAL_MS = 2000;
const LIVE_FLUSH_FOREGROUND_INTERVAL_MS = 200;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_BATCHES = 4;
const EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS = 250;
const embeddingBackfillsInFlight = new Set<string>();

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
        throw error;
      }
    }
  } finally {
    // Intentional: if this flush hits an unexpected send failure, we surface that
    // error and drop the queued updates rather than retrying stale payloads against
    // a renderer/window state that may already be invalid.
    pendingLiveUpdates.clear();
  }
}

/** Flush any pending dedup+batch live query updates immediately. Exported for testing. */
export { flushPendingLiveUpdates };

export function setBackgrounded(value: boolean): void {
  const wasBackgrounded = isBackgrounded;
  isBackgrounded = value;
  if (value && !wasBackgrounded) {
    acquireLiveSubscriptionPause();
  }
  if (!value && wasBackgrounded) {
    releaseLiveSubscriptionPause();
    flushPendingLiveUpdates();
  }
}

// Reference-counted pause/resume for PGlite live query subscriptions.
// Multiple callers (window blur, backfill) can pause independently;
// subscriptions only resume when ALL callers have released.
function acquireLiveSubscriptionPause(): void {
  liveSubscriptionPauseDepth += 1;
  if (liveSubscriptionPauseDepth === 1) {
    for (const record of liveSubscriptions.values()) {
      try {
        void record.handle.unsubscribe(record.listener);
      } catch {
        // Ignore errors — subscription may already be cleaned up
      }
    }
  }
}

function releaseLiveSubscriptionPause(): void {
  if (liveSubscriptionPauseDepth <= 0) {
    return;
  }
  liveSubscriptionPauseDepth -= 1;
  if (liveSubscriptionPauseDepth === 0) {
    for (const record of liveSubscriptions.values()) {
      try {
        record.handle.subscribe(record.listener);
      } catch {
        // Ignore errors — subscription may have been cleaned up
      }
    }
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
      query: payload.query,
      params: payload.params ?? null,
      key: payload.key,
      offset: payload.offset,
      limit: payload.limit,
    });
  }
  return await db.live.query({
    query: payload.query,
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
  registerHandler('db:query', async (_evt: IpcMainInvokeEvent, sql: string, params?: unknown[]) =>
    withCorruptionRecovery(async () => {
      const { getDatabase } = await import('./db-main');
      const db = await getDatabase();
      return await db.query(sql, params);
    }, 'db:query')
  );

  registerHandler('db:exec', async (_evt: IpcMainInvokeEvent, sql: string) =>
    withCorruptionRecovery(async () => {
      const { getDatabase } = await import('./db-main');
      const db = await getDatabase();
      return await db.exec(sql);
    }, 'db:exec')
  );

  registerHandler(
    EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
    async (event: IpcMainInvokeEvent, embeddingSetId: unknown) =>
      withCorruptionRecovery(async () => {
        if (typeof embeddingSetId !== 'string' || embeddingSetId.trim().length === 0) {
          throw new Error('Embedding backfill requires a non-empty embeddingSetId.');
        }
        if (!embeddingHostManager) {
          throw new Error('Embedding host manager is required for desktop backfill.');
        }
        const normalizedEmbeddingSetId = embeddingSetId.trim();
        if (embeddingBackfillsInFlight.has(normalizedEmbeddingSetId)) {
          throw new Error(
            `Embedding backfill is already running for set ${normalizedEmbeddingSetId}.`
          );
        }
        const backfillRequestId = createRequestId('embedding-backfill');
        let backfillProgressTargetUnavailable = false;
        embeddingBackfillsInFlight.add(normalizedEmbeddingSetId);

        // Pause all PGlite live query subscriptions during backfill.
        // The backfill generates ~3× total_chunks mutations in job_queue
        // (insert + running + succeeded per chunk). Each mutation causes
        // PGlite to re-evaluate ALL active live queries, consuming massive
        // main-process CPU and flooding the renderer with IPC updates.
        // Pausing subscriptions stops PGlite from evaluating queries entirely.
        acquireLiveSubscriptionPause();

        try {
          const hostStatus = await embeddingHostManager.ensureStarted({ waitForRunning: true });
          if (hostStatus.state !== 'running') {
            throw new Error(
              hostStatus.lastError ?? 'Embedding host failed to reach the running state.'
            );
          }
          const { getDatabase } = await import('./db-main');
          const db = await getDatabase();
          const jobQueue = new JobQueue(db);
          return await enqueueEmbeddingBackfill(
            db,
            jobQueue,
            normalizedEmbeddingSetId,
            (done: number, total: number) => {
              if (backfillProgressTargetUnavailable || event.sender.isDestroyed()) {
                backfillProgressTargetUnavailable = true;
                return;
              }
              try {
                event.sender.send(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
                  embeddingSetId: normalizedEmbeddingSetId,
                  requestId: backfillRequestId,
                  stage: 'backfill',
                  current: done,
                  total,
                });
              } catch (error) {
                if (isDisposedRenderFrameSendError(error)) {
                  backfillProgressTargetUnavailable = true;
                  logger.debug(
                    'Stopped desktop backfill progress sends after renderer frame disposal',
                    {
                      embeddingSetId: normalizedEmbeddingSetId,
                      requestId: backfillRequestId,
                    }
                  );
                  return;
                }
                throw error;
              }
            },
            {
              assertCanContinue: () => {
                const status = embeddingHostManager?.getStatus();
                if (!status) {
                  return;
                }
                if (status.state === 'error') {
                  throw new Error(
                    status.lastError ?? 'Embedding host entered an error state during backfill.'
                  );
                }
                if (status.state === 'stopped' || status.state === 'stopping') {
                  throw new Error('Embedding host stopped while backfill was in progress.');
                }
              },
              progressIntervalBatches: EMBEDDING_BACKFILL_PROGRESS_INTERVAL_BATCHES,
              progressIntervalMs: EMBEDDING_BACKFILL_PROGRESS_INTERVAL_MS,
            }
          );
        } finally {
          embeddingBackfillsInFlight.delete(normalizedEmbeddingSetId);
          // Always release the pause ref so the depth counter stays balanced.
          // If the window is still backgrounded, depth remains ≥1 (from
          // setBackgrounded) and subscriptions stay paused — which is correct.
          // Only flush pending updates if we're in the foreground.
          releaseLiveSubscriptionPause();
          if (!isBackgrounded) {
            flushPendingLiveUpdates();
          }
        }
      }, EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL)
  );

  // Expose in-flight backfill state so the renderer can re-attach to progress
  // after a crash recovery reload.
  registerHandler(EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL, async () =>
    Array.from(embeddingBackfillsInFlight)
  );

  registerHandler(
    'db:live-query:start',
    async (event: IpcMainInvokeEvent, payload: LiveQueryPayload) =>
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
  );

  registerHandler('db:live-query:stop', async (_event: IpcMainInvokeEvent, id: number) => {
    await cleanupLiveSubscription(Number(id));
    return { success: true };
  });

  registerHandler(
    'db:live-query:refresh',
    async (
      _event: IpcMainInvokeEvent,
      payload: { id: number; offset?: number; limit?: number }
    ) => {
      const record = liveSubscriptions.get(Number(payload?.id));
      if (!record) {
        return { success: false, message: 'Subscription not found' };
      }
      try {
        const refreshArgs = buildRefreshArgs(payload);
        await record.handle.refresh(refreshArgs);
        return { success: true };
      } catch (error) {
        return await handleLiveQueryRefreshError(error, payload?.id);
      }
    }
  );

  // Database test handler for connection validation
  registerHandler('db:ping', async (_e: IpcMainInvokeEvent) => {
    // Lightweight connectivity check; does not initialize DB
    return { success: true, message: 'ping' };
  });

  registerHandler('db:diagnostics', async (_e: IpcMainInvokeEvent) => {
    const { getDatabaseDiagnostics } = await import('./db-main');
    return getDatabaseDiagnostics();
  });

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
          dbLocation: 'Main Process',
        };
      }, 'db:test');
    } catch (error) {
      return {
        success: false,
        message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        dbLocation: 'Main Process',
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
          try {
            await tx.query('DELETE FROM embedding_sets');
          } catch {}
          try {
            await tx.query('DELETE FROM job_queue');
          } catch {}

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
