import type { DimensionIndexMaintenanceStrategy } from '@brainstrike/db';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type ElectronStore from 'electron-store';
import type { ChunkingHostManager } from './chunking-host-manager';
import type { EmbeddingHostManager } from './embedding-host-manager';
import {
  cleanupDesktopLiveSubscriptionsForShutdown,
  flushPendingLiveUpdates,
  isDesktopDatabaseBackgrounded,
  registerDatabaseIpcHandlers,
  setBackgrounded,
} from './ipc-domains/db-ipc';
import { registerEmbeddingBackfillIpcHandlers } from './ipc-domains/embedding-backfill-ipc';
import { registerFileSystemIpcHandlers } from './ipc-domains/file-system-ipc';
import { registerStoragePreferencesIpcHandlers } from './ipc-domains/storage-preferences-ipc';
import { getDesktopDatabaseWorkScheduler } from './platform/desktop-database-work';
import type { DesktopSettingsStoreSchema } from './store-schema';

export {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resetDesktopDatabaseWorkSchedulerForTests,
  runDesktopScheduledDatabaseWork,
  runWithDesktopDatabaseResetBarrier,
  waitForDesktopDatabaseWorkSchedulerIdle,
} from './platform/desktop-database-work';
export { cleanupDesktopLiveSubscriptionsForShutdown, flushPendingLiveUpdates, setBackgrounded };

interface RegisterIpcHandlerOptions {
  readonly chunkingHostManager?: ChunkingHostManager;
  readonly embeddingHostManager?: EmbeddingHostManager;
  readonly getDimensionIndexMaintenanceStrategy?: () => DimensionIndexMaintenanceStrategy | null;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
}

/**
 * Register all IPC handlers used by the desktop application.
 *
 * This file is intentionally a thin composition root. Domain ownership lives in
 * `ipc-domains/*` so adding a channel requires one domain contract, one handler,
 * and focused tests without growing a monolithic Electron main-process file.
 */
export function registerIpcHandlers(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
  getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null,
  options?: RegisterIpcHandlerOptions
): () => void {
  const unregisterStoragePreferencesIpcHandlers = registerStoragePreferencesIpcHandlers({
    getStore,
    storage,
  });
  const unregisterFileSystemIpcHandlers = registerFileSystemIpcHandlers({
    fileSystem,
    storage,
  });
  const unregisterDatabaseIpcHandlers = registerDatabaseIpcHandlers(options);
  const unregisterEmbeddingBackfillIpcHandlers = registerEmbeddingBackfillIpcHandlers({
    embeddingHostManager: options?.embeddingHostManager,
    flushPendingLiveUpdates,
    getDatabaseWorkScheduler: getDesktopDatabaseWorkScheduler,
    ...(options?.getDimensionIndexMaintenanceStrategy
      ? { getDimensionIndexMaintenanceStrategy: options.getDimensionIndexMaintenanceStrategy }
      : {}),
    isBackgrounded: isDesktopDatabaseBackgrounded,
  });

  return () => {
    unregisterEmbeddingBackfillIpcHandlers();
    unregisterDatabaseIpcHandlers();
    unregisterFileSystemIpcHandlers();
    unregisterStoragePreferencesIpcHandlers();
  };
}
