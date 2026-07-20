import path from 'node:path';
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
import { registerFileSystemWatchIpcHandlers } from './ipc-domains/file-system-watch-ipc';
import type { RuntimeDatabaseCorruptionHandler } from './ipc-domains/runtime-database-corruption';
import { registerStoragePreferencesIpcHandlers } from './ipc-domains/storage-preferences-ipc';
import { getDesktopDatabaseWorkScheduler } from './platform/desktop-database-work';
import type { DesktopSettingsStoreSchema } from './store-schema';

export {
  getDesktopDatabaseWorkSchedulerSnapshot,
  quiesceDesktopDatabaseWorkForRecovery,
  resetDesktopDatabaseWorkSchedulerForTests,
  resumeDesktopDatabaseWorkAfterRecoveryReload,
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
  readonly onRuntimeCorruption?: RuntimeDatabaseCorruptionHandler;
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
    // Dynamic import (matches db-ipc): keep db-main — and its native
    // secure-fs-native dependency — OUT of this module's eager graph, so
    // importing ipc-handlers (e.g. the main-boot tests) never eagerly loads
    // the native addon. Resolved lazily, only when fs:removeRoot actually runs.
    getRootsDatabase: async () => (await import('./db-main')).getDatabase(),
    storage,
  });
  const unregisterFileSystemWatchIpcHandlers = registerFileSystemWatchIpcHandlers({
    // Recursive watcher (batched, ignoreInitial, path-filtered) — the same
    // engine the notes-vault watch channel uses. Health transitions flow back
    // over fs:watch-health (BST-568 slice 3).
    startWatch: (directoryPath, onChanges, onHealth) =>
      fileSystem.watchDirectory(
        {
          kind: 'directory',
          name: path.basename(directoryPath),
          path: directoryPath,
          platform: 'electron',
        },
        onChanges,
        // The shared onSignal channel is derived FROM onHealth inside the
        // adapter; IPC consumers use the richer health protocol directly.
        undefined,
        { onHealth }
      ),
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
    ...(options?.onRuntimeCorruption ? { onRuntimeCorruption: options.onRuntimeCorruption } : {}),
  });

  return () => {
    unregisterEmbeddingBackfillIpcHandlers();
    unregisterDatabaseIpcHandlers();
    unregisterFileSystemWatchIpcHandlers();
    unregisterFileSystemIpcHandlers();
    unregisterStoragePreferencesIpcHandlers();
  };
}
