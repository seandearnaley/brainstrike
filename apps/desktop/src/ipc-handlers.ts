import path from 'node:path';
import type {
  DirectoryHandle,
  ElectronFileSystemAdapter,
  FileHandle,
} from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type ElectronStore from 'electron-store';
import { getDatabase } from './db-main';

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
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for process.env
    const electronTestEnv = process.env['ELECTRON_IS_E2E_TEST'];
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for process.env
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
      console.warn('Rejected potentially unsafe path access:', p);
      return false;
    }
    return fileSystem.exists(p);
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
    try {
      const db = getDatabase();
      return await db.query(sql, params);
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  });

  ipcMain.handle('db:exec', async (_evt: IpcMainInvokeEvent, sql: string) => {
    try {
      const db = getDatabase();
      return await db.exec(sql);
    } catch (error) {
      console.error('Database exec error:', error);
      throw error;
    }
  });

  // Database test handler for connection validation
  ipcMain.handle('db:test', async () => {
    try {
      const db = getDatabase();
      const result = await db.query('SELECT 1 as test, current_timestamp as timestamp');
      const dbPath = path.join(
        app.getPath('documents'),
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for process.env
        process.env['NODE_ENV'] === 'production' ? 'BrainStrike' : 'BrainStrike-dev',
        'pgdata'
      );
      return {
        success: true,
        message: `Database connected successfully. Test query returned: ${JSON.stringify(result.rows[0])}`,
        dbLocation: `NodeFS: ${dbPath}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Database test failed: ${error}`,
        dbLocation: 'Unknown',
      };
    }
  });

  // Database path IPC handler (legacy - kept for compatibility)
  ipcMain.handle('db:getUserDataPath', async () => {
    return path.join(app.getPath('userData'), 'brainstrike.db');
  });
}
