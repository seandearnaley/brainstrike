import { startEmbeddingWorker } from '@brainstrike/embeddings';
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';
import { ElectronStorageAdapter } from '@brainstrike/storage';
import type { PanelPersistenceState } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { app, BrowserWindow } from 'electron';
import ElectronStore from 'electron-store';
import { createWindow } from './create-window';
import { closeDatabase, getDatabase } from './db-main';
import { registerIpcHandlers } from './ipc-handlers';
import { setupSecurity } from './setup-security';

const logger = createLogger('DesktopMain');
const fileSystem = new ElectronFileSystemAdapter();
const storage = new ElectronStorageAdapter();

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

let stopEmbeddingWorker: null | (() => Promise<void>) = null;

app.whenReady().then(async () => {
  try {
    logger.info('App ready, starting initialization...');

    // Setup security before creating windows
    setupSecurity();
    logger.info('Security setup complete');

    // Optionally start local embedding worker if queue is enabled
    try {
      // Lazy-init DB for worker only when enabled
      const queueEnabled =
        String(process.env['EMBED_QUEUE_ENABLED'] ?? 'true').toLowerCase() === 'true';
      if (queueEnabled) {
        const db = await getDatabase();
        const controller = await startEmbeddingWorker({
          // Cast db to IDatabase (query shape)
          db: db as import('@brainstrike/db').IDatabase,
          concurrency: Number(process.env['EMBED_CONCURRENCY'] ?? 1) || 1,
          leaseMs: Number(process.env['EMBED_LEASE_MS'] ?? 60000) || 60000,
          modelKey: process.env['EMBED_MODEL_KEY'] || undefined,
          log: (msg: string) => logger.info(`[EmbeddingWorker] ${msg}`),
        });
        stopEmbeddingWorker = controller.stop;
        logger.info('Embedding worker started');
      }
    } catch (err) {
      logger.error('Failed to start embedding worker:', err);
    }

    logger.info('Creating main window...');
    await createWindow();
    logger.info('Main window created successfully');

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
  try {
    if (stopEmbeddingWorker) {
      await stopEmbeddingWorker();
      stopEmbeddingWorker = null;
    }
    await closeDatabase();
  } catch (error) {
    logger.error('Error closing database:', error);
  }
});

export { createWindow, setupSecurity, registerIpcHandlers };
