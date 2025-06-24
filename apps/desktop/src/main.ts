import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { BrowserWindow, app } from 'electron';
import ElectronStore from 'electron-store';
import { createWindow } from './create-window';
import { closeDatabase, initializeMainDatabase } from './db-main';
import { registerIpcHandlers } from './ipc-handlers';
import { setupSecurity } from './setup-security';

const logger = createLogger('DesktopMain');
const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

interface StoreSchema {
  panelLayout: {
    v1: PanelPersistenceState;
  };
}

const store: ElectronStore<StoreSchema> = new ElectronStore<StoreSchema>();

registerIpcHandlers(fileSystem, storage, store);

app.whenReady().then(async () => {
  try {
    // Initialize database before creating windows
    await initializeMainDatabase();
    logger.info('Main database initialized successfully');

    // Setup security before creating windows
    setupSecurity();

    await createWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  } catch (error) {
    logger.error('Failed to initialize application:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean shutdown
app.on('before-quit', async () => {
  await closeDatabase();
});

export { createWindow, setupSecurity, registerIpcHandlers };
