import path from 'node:path';
import type {
  DirectoryHandle,
  ElectronFileSystemAdapter,
  FileHandle,
} from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import type { IpcMainInvokeEvent } from 'electron';
import { app, ipcMain } from 'electron';
import type ElectronStore from 'electron-store';

// import { getDatabase } from './db-main'; // Disabled - using renderer process database

interface StoreSchema {
  panelLayout: {
    v1: PanelPersistenceState;
  };
}

/**
 * Register all IPC handlers used by the desktop application.
 */
export function registerIpcHandlers(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
  store: ElectronStore<StoreSchema>
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
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
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
    // Basic path validation - reject obviously malicious paths
    if (
      p.includes('..') ||
      p.startsWith('/etc/') ||
      p.startsWith('/usr/') ||
      p.startsWith('/var/')
    ) {
      return false;
    }
    return fileSystem.exists(p);
  });

  // Auto-restore last folder functionality for desktop
  ipcMain.handle('fs:restoreLastFolder', async () => {
    console.log('[IPC] fs:restoreLastFolder called');
    try {
      const lastFolderPath = await storage.getItem('lastFolderPath');
      console.log('[IPC] Last folder path from storage:', lastFolderPath);
      
      if (!lastFolderPath) {
        console.log('[IPC] No last folder path found');
        return null;
      }

      // Verify the folder still exists and is accessible
      const exists = await fileSystem.exists(lastFolderPath);
      console.log('[IPC] Folder exists check:', exists, 'for path:', lastFolderPath);
      
      if (!exists) {
        // Clean up invalid path
        console.log('[IPC] Folder no longer exists, cleaning up');
        await storage.removeItem('lastFolderPath');
        return null;
      }

      // Return a DirectoryHandle for the last folder
      const handle = {
        path: lastFolderPath,
        name: path.basename(lastFolderPath),
        kind: 'directory',
        platform: 'electron',
      };
      console.log('[IPC] Returning restored handle:', handle);
      return handle;
    } catch (error) {
      // If there's any error, just return null and let user select manually
      console.error('[IPC] Error in restoreLastFolder:', error);
      return null;
    }
  });

  ipcMain.handle('fs:saveLastFolder', async (_e: IpcMainInvokeEvent, folderPath: string) => {
    console.log('[IPC] fs:saveLastFolder called with path:', folderPath);
    try {
      await storage.setItem('lastFolderPath', folderPath);
      console.log('[IPC] Successfully saved last folder path');
    } catch (error) {
      // Non-critical error, just log it
      console.warn('[IPC] Failed to save last folder path:', error);
    }
  });

  // Layout persistence IPC handlers
  ipcMain.handle('layout:save', async (_e: IpcMainInvokeEvent, state: PanelPersistenceState) => {
    // TypeScript has issues with electron-store method resolution during build
    // Using type assertion to access inherited Conf methods
    (store as ElectronStore<StoreSchema> & { set: (key: string, value: unknown) => void }).set(
      'panelLayout',
      { v1: state }
    );
  });

  ipcMain.handle('layout:load', async () => {
    // TypeScript has issues with electron-store method resolution during build
    // Using type assertion to access inherited Conf methods
    const layout = (store as ElectronStore<StoreSchema> & { get: (key: string) => unknown }).get(
      'panelLayout'
    ) as StoreSchema['panelLayout'] | undefined;
    return layout?.v1;
  });

  // Database IPC handlers
  ipcMain.handle('db:query', async (_evt: IpcMainInvokeEvent, sql: string, params?: unknown[]) => {
    const { getDatabase } = await import('./db-main');
    const db = getDatabase();
    return await db.query(sql, params);
  });

  ipcMain.handle('db:exec', async (_evt: IpcMainInvokeEvent, sql: string) => {
    const { getDatabase } = await import('./db-main');
    const db = getDatabase();
    return await db.exec(sql);
  });

  // Database test handler for connection validation
  ipcMain.handle('db:test', async () => {
    try {
      const { getDatabase } = await import('./db-main');
      const db = getDatabase();
      await db.query('SELECT 1');
      return {
        success: true,
        message: 'Database connection successful',
        dbLocation: 'Main Process',
      };
    } catch (error) {
      return {
        success: false,
        message: `Database connection failed: ${error}`,
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
      const db = getDatabase();

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

  // Database path IPC handler for PGlite directory
  ipcMain.handle('db:getUserDataPath', async () => {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for env vars
    const isProduction = process.env['NODE_ENV'] === 'production';
    const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
    return path.join(app.getPath('documents'), dbDirName, 'pgdata');
  });
}
