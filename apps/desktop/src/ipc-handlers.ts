import path from 'node:path';
import type {
  DirectoryHandle,
  ElectronFileSystemAdapter,
  FileHandle,
} from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import type { LiveQuery, LiveQueryResults } from '@electric-sql/pglite/live';
import type { IpcMainInvokeEvent } from 'electron';
import { app, ipcMain } from 'electron';
import type ElectronStore from 'electron-store';
import type { DesktopSettingsStoreSchema } from './store-schema';

// import { getDatabase } from './db-main'; // Disabled - using renderer process database

// Storage keys for persistent data
const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;

/**
 * Register all IPC handlers used by the desktop application.
 */
type RegisterIpcHandlerOptions = {
  onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
};

type LiveSubscriptionRecord = {
  id: number;
  mode: 'query' | 'incremental';
  handle: LiveQuery<unknown>;
  listener: (results: LiveQueryResults<unknown>) => void;
  webContentsId: number;
};

const liveSubscriptions = new Map<number, LiveSubscriptionRecord>();
let nextLiveSubscriptionId = 1;

async function cleanupLiveSubscription(id: number): Promise<void> {
  const record = liveSubscriptions.get(id);
  if (!record) return;
  liveSubscriptions.delete(id);
  try {
    await record.handle.unsubscribe(record.listener);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    const normalizedMessage = rawMessage ? rawMessage.toLowerCase() : '';
    if (normalizedMessage.includes('pglite is closed')) {
      return;
    }
    console.warn('Failed to cleanup live query subscription', id, error);
  }
}

export function registerIpcHandlers(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
  store: ElectronStore<DesktopSettingsStoreSchema>,
  options?: RegisterIpcHandlerOptions
) {
  ipcMain.handle('storage:getItem', async (_e: IpcMainInvokeEvent, key: string) =>
    storage.getItem(key)
  );
  ipcMain.handle('storage:setItem', async (_e: IpcMainInvokeEvent, key: string, value: string) =>
    storage.setItem(key, value)
  );
  ipcMain.handle('storage:removeItem', async (_e: IpcMainInvokeEvent, key: string) =>
    storage.removeItem(key)
  );
  ipcMain.handle('storage:clear', async () => storage.clear());
  ipcMain.handle('storage:getAllKeys', async () => storage.getAllKeys());

  ipcMain.handle('fs:requestDirectoryAccess', async () => {
    // Check if we're in test mode to avoid native dialogs
    const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];

    const nodeEnv = process.env['NODE_ENV'];
    const isTestMode =
      process.argv.includes('--test-mode') || electronTestEnv === 'true' || nodeEnv === 'test';

    if (isTestMode) {
      // Return a mock directory handle for testing
      return {
        id: 'mock-directory-handle',
        name: 'mock-test-directory',
        path: '/mock/test/directory',
        type: 'directory',
        kind: 'directory',
      };
    }

    return fileSystem.requestDirectoryAccess();
  });
  ipcMain.handle('fs:readDirectory', async (_e: IpcMainInvokeEvent, handle: DirectoryHandle) => {
    // Check if this is a mock handle for testing
    if (
      handle &&
      typeof handle === 'object' &&
      'id' in handle &&
      handle.id === 'mock-directory-handle'
    ) {
      return [
        { name: 'mock-file1.txt', type: 'file', size: 100 },
        { name: 'mock-file2.ts', type: 'file', size: 250 },
        { name: 'mock-subfolder', type: 'directory' },
      ];
    }
    return fileSystem.readDirectory(handle);
  });

  ipcMain.handle('fs:readFile', async (_e: IpcMainInvokeEvent, handle: FileHandle) => {
    // Check if this is a mock handle for testing
    if (
      handle &&
      typeof handle === 'object' &&
      'id' in handle &&
      String(handle.id).includes('mock-')
    ) {
      return 'Mock file content for testing purposes\nThis is a test file.\n';
    }
    return fileSystem.readFile(handle);
  });
  ipcMain.handle('fs:exists', async (_e: IpcMainInvokeEvent, p: string) => {
    // Basic path validation - prevent obvious security issues
    try {
      // Reject null bytes and other control characters that could be used maliciously
      if (p.includes('\0') || p.includes('\x00')) {
        return false;
      }

      // Reject paths with excessive traversal attempts (likely malicious)
      const traversalCount = (p.match(/\.\./g) || []).length;
      if (traversalCount > 10) {
        return false;
      }

      // Additional security checks for sensitive system directories on Unix systems
      const resolvedPath = path.resolve(p);
      if (process.platform !== 'win32') {
        // Only block these on Unix-like systems, and only if they're actual system directories
        const sensitiveDirectories = ['/etc/', '/usr/bin/', '/usr/sbin/', '/sbin/', '/boot/'];
        if (sensitiveDirectories.some((dir) => resolvedPath.startsWith(dir))) {
          return false;
        }
      }
    } catch (_error) {
      // Invalid path format
      return false;
    }

    return fileSystem.exists(p);
  });

  // Auto-restore last folder functionality for desktop

  /**
   * Attempts to restore the last opened folder if it still exists
   * @returns DirectoryHandle if successful, null if no folder or folder missing
   */
  ipcMain.handle('fs:restoreLastFolder', async () => {
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
      // Debug logging in development only
      const nodeEnv = process.env['NODE_ENV'];
      if (nodeEnv === 'development') {
        console.debug('Auto-restore failed:', error);
      }
      // If there's any error, just return null and let user select manually
      return null;
    }
  });

  /**
   * Saves the folder path for auto-restore on next application launch
   * @param folderPath - The folder path to save for future restoration
   */
  ipcMain.handle('fs:saveLastFolder', async (_e: IpcMainInvokeEvent, folderPath: string) => {
    try {
      await storage.setItem(LAST_FOLDER_STORAGE_KEY, folderPath);
    } catch (error) {
      // Debug logging in development only
      const nodeEnv = process.env['NODE_ENV'];
      if (nodeEnv === 'development') {
        console.debug('Failed to save last folder:', error);
      }
      // Non-critical error, silently fail
      // The worst case is the user needs to select folder again on next launch
    }
  });

  // Layout persistence IPC handlers
  ipcMain.handle('layout:save', async (_e: IpcMainInvokeEvent, state: PanelPersistenceState) => {
    // TypeScript has issues with electron-store method resolution during build
    // Using type assertion to access inherited Conf methods
    (
      store as ElectronStore<DesktopSettingsStoreSchema> & {
        set: (key: string, value: unknown) => void;
      }
    ).set('panelLayout', { v1: state });
  });

  ipcMain.handle('layout:load', async () => {
    // TypeScript has issues with electron-store method resolution during build
    // Using type assertion to access inherited Conf methods
    const layout = (
      store as ElectronStore<DesktopSettingsStoreSchema> & { get: (key: string) => unknown }
    ).get('panelLayout') as DesktopSettingsStoreSchema['panelLayout'] | undefined;
    return layout?.v1;
  });

  // Database IPC handlers
  ipcMain.handle('db:query', async (_evt: IpcMainInvokeEvent, sql: string, params?: unknown[]) => {
    const { getDatabase } = await import('./db-main');
    const db = await getDatabase();
    return await db.query(sql, params);
  });

  ipcMain.handle('db:exec', async (_evt: IpcMainInvokeEvent, sql: string) => {
    const { getDatabase } = await import('./db-main');
    const db = await getDatabase();
    return await db.exec(sql);
  });

  ipcMain.handle(
    'db:live-query:start',
    async (
      event: IpcMainInvokeEvent,
      payload: {
        query: string;
        params?: readonly unknown[];
        key?: string;
        mode?: 'query' | 'incremental';
        offset?: number;
        limit?: number;
      }
    ) => {
      const { getDatabase } = await import('./db-main');
      const db = await getDatabase();
      if (!db.live) {
        throw new Error('Live query extension is not available');
      }

      const mode: 'query' | 'incremental' =
        payload?.mode === 'incremental' ? 'incremental' : 'query';

      let handle: LiveQuery<unknown>;
      if (mode === 'incremental') {
        if (!payload.key) {
          throw new Error('Live incremental queries require a key column');
        }
        handle = await db.live.incrementalQuery({
          query: payload.query,
          params: payload.params ?? null,
          key: payload.key,
          offset: payload.offset,
          limit: payload.limit,
        });
      } else {
        handle = await db.live.query({
          query: payload.query,
          params: payload.params ?? null,
          offset: payload.offset,
          limit: payload.limit,
        });
      }

      const id = nextLiveSubscriptionId++;
      const sender = event.sender;
      const listener = (results: LiveQueryResults<unknown>) => {
        if (sender.isDestroyed()) {
          void cleanupLiveSubscription(id);
          return;
        }
        sender.send('db:live-query:update', { id, results });
      };

      handle.subscribe(listener);
      liveSubscriptions.set(id, {
        id,
        mode,
        handle,
        listener,
        webContentsId: sender.id,
      });
      sender.once('destroyed', () => {
        void cleanupLiveSubscription(id);
      });

      return {
        id,
        initialResults: handle.initialResults,
      };
    }
  );

  ipcMain.handle('db:live-query:stop', async (_event: IpcMainInvokeEvent, id: number) => {
    await cleanupLiveSubscription(Number(id));
    return { success: true };
  });

  ipcMain.handle(
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
        const refreshOptions: { offset?: number; limit?: number } = {};
        if (payload?.offset !== undefined) {
          refreshOptions.offset = payload.offset;
        }
        if (payload?.limit !== undefined) {
          refreshOptions.limit = payload.limit;
        }
        const refreshArgs =
          refreshOptions.offset !== undefined || refreshOptions.limit !== undefined
            ? refreshOptions
            : undefined;
        await record.handle.refresh(refreshArgs);
        return { success: true };
      } catch (error) {
        console.warn('Failed to refresh live query', payload?.id, error);
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  // Database test handler for connection validation
  ipcMain.handle('db:ping', async () => {
    // Lightweight connectivity check; does not initialize DB
    return { success: true, message: 'ping' };
  });

  // Database test handler for full connection validation
  ipcMain.handle('db:test', async () => {
    const { getDatabase } = await import('./db-main');
    try {
      const db = await getDatabase();
      await db.query('SELECT 1');
      return {
        success: true,
        message: 'Database connection successful',
        dbLocation: 'Main Process',
      };
    } catch (error) {
      return {
        success: false,
        message: `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
        dbLocation: 'Main Process',
      };
    }
  });

  // Bulk database cleanup handler - requires confirmation token for security
  ipcMain.handle('db:clearAll', async (_, confirmationToken?: string) => {
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
      return {
        success: false,
        message: `Database clear failed: ${error instanceof Error ? error.message : String(error)}`,
        deletedFiles: 0,
        deletedChunks: 0,
      };
    }
  });

  // Hard reset database on disk (desktop only)
  ipcMain.handle('db:resetLocal', async () => {
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
  ipcMain.handle('db:getUserDataPath', async () => {
    const isProduction = process.env['NODE_ENV'] === 'production';
    const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
    return path.join(app.getPath('documents'), dbDirName, 'pgdata');
  });
}
