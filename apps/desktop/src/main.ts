import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';
import ElectronStore from 'electron-store';
import { createWindow } from './create-window';
import { closeDatabase } from './db-main';
import { registerIpcHandlers } from './ipc-handlers';
import { setupSecurity } from './setup-security';

const logger = createLogger('DesktopMain');
const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

// Harden CI/headless environments: disable GPU and sandbox issues that can prevent window creation
// Avoid running during unit tests (Vitest module evaluation)
// biome-ignore lint/complexity/useLiteralKeys: env access via index signature
if (process.env['CI'] === 'true' && process.env['VITEST'] !== 'true') {
  try {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    console.info('⚙️ CI hardening: GPU disabled, no-sandbox enabled');
  } catch (e) {
    console.warn('⚠️ Failed to apply CI hardening switches:', e);
  }
}

// Add global error handlers to catch silent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection:', reason);
  console.error('Unhandled promise rejection at:', promise, 'reason:', reason);
});

interface StoreSchema {
  panelLayout: {
    v1: PanelPersistenceState;
  };
}

const store: ElectronStore<StoreSchema> = new ElectronStore<StoreSchema>({
  name: 'brainstrike-settings',
});

logger.info('Setting up IPC handlers...');
registerIpcHandlers(fileSystem, storage, store);
logger.info('IPC handlers registered successfully');

app.whenReady().then(async () => {
  try {
    logger.info('App ready, starting initialization...');
    console.info('🚀 Electron app ready');

    // Setup security before creating windows
    setupSecurity();
    logger.info('Security setup complete');
    console.info('🔒 Security configured');

    // Database will be lazy-loaded when first accessed via IPC

    logger.info('Creating main window...');
    console.info('🪟 Creating main window');
    await createWindow();
    logger.info('Main window created successfully');
    console.info('✅ Main window created');

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  } catch (error) {
    logger.error('Failed to initialize application:', error);
    console.error('❌ Failed to initialize application:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean shutdown
app.on('before-quit', async () => {
  try {
    await closeDatabase();
  } catch (error) {
    logger.error('Error closing database:', error);
    console.error('Error closing database:', error);
  }
});

// Additional diagnostics to surface window lifecycle in CI logs
app.on('browser-window-created', () => {
  console.info('🪟 Event: browser-window-created');
});
app.on('web-contents-created', () => {
  console.info('🧩 Event: web-contents-created');
});

export { createWindow, setupSecurity, registerIpcHandlers };
