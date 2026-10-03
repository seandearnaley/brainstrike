import path from 'node:path';
import type { DimensionIndexMaintenanceStrategy } from '@brainstrike/db';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import {
  ParcelWatchRetirementError,
  startJoinedParcelWatch,
} from '@brainstrike/file-system/native-watch';
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
import { createFileSystemIpcDomain } from './ipc-domains/file-system-ipc';
import { registerFileSystemWatchIpcHandlers } from './ipc-domains/file-system-watch-ipc';
import { registerStoragePreferencesIpcHandlers } from './ipc-domains/storage-preferences-ipc';
import type { ManagedWorktreeAuthorizer } from './ipc-domains/workspace-recent-roots';
import type { WorkspaceRootRegistry } from './ipc-domains/workspace-root-registry';
import type { MountedWorkspaceRoot } from './ipc-domains/workspace-root-types';
import {
  createWorkspaceRootWatchOwner,
  type WorkspaceRootWatchOwner,
} from './ipc-domains/workspace-root-watch-owner';
import { getDesktopDatabaseWorkScheduler } from './platform/desktop-database-work';
import type { DesktopSettingsStoreSchema } from './store-schema';

export {
  getDesktopDatabaseWorkScheduler,
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
  /** Explicit test-harness seam for synthetic filesystem adapters. */
  readonly isSyntheticFileSystemPath?: (rootPath: string) => boolean;
  readonly managedWorktreeAuthorizer?: ManagedWorktreeAuthorizer;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
  readonly onStorageChanged?: (key: string) => void;
  readonly onWorkspaceRootGranted?: (grantedPath: string) => void;
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
): () => Promise<void> {
  return createApplicationIpcDomain(fileSystem, storage, getStore, options).close;
}

export interface ApplicationIpcDomain {
  close(): Promise<void>;
  readonly roots: WorkspaceRootRegistry;
  readonly watches: WorkspaceRootWatchOwner;
}

export function createApplicationIpcDomain(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
  getStore: () => ElectronStore<DesktopSettingsStoreSchema> | null,
  options?: RegisterIpcHandlerOptions
): ApplicationIpcDomain {
  const unregisterStoragePreferencesIpcHandlers = registerStoragePreferencesIpcHandlers({
    getStore,
    storage,
    ...(options?.onStorageChanged ? { onStorageChanged: options.onStorageChanged } : {}),
  });
  const fileSystemDomain = createFileSystemIpcDomain({
    fileSystem,
    // Dynamic import (matches db-ipc): keep db-main — and its native
    // secure-fs-native dependency — OUT of this module's eager graph, so
    // importing ipc-handlers (e.g. the main-boot tests) never eagerly loads
    // the native addon. Resolved lazily, only when fs:removeRoot actually runs.
    getRootsDatabase: async () => (await import('./db-main')).getDatabase(),
    ...(options?.isSyntheticFileSystemPath
      ? { isSyntheticFileSystemPath: options.isSyntheticFileSystemPath }
      : {}),
    ...(options?.managedWorktreeAuthorizer
      ? { managedWorktreeAuthorizer: options.managedWorktreeAuthorizer }
      : {}),
    ...(options?.onWorkspaceRootGranted
      ? { onWorkspaceRootGranted: options.onWorkspaceRootGranted }
      : {}),
    storage,
  });
  const watches = createWorkspaceRootWatchOwner({
    startWatch: (mounted, onChanges, onHealth) =>
      startJoinedParcelWatch(
        {
          kind: 'directory',
          name: path.basename(mounted.canonicalPath),
          path: mounted.canonicalPath,
          platform: 'electron',
        },
        onChanges,
        { onHealth, reportDefaultFilteredChanges: true }
      ),
  });
  const unregisterFileSystemWatchIpcHandlers = registerFileSystemWatchIpcHandlers({
    // Recursive Explorer watcher (batched, ignoreInitial, path-filtered). This
    // concrete MAIN-owned closure is the sole production opt-in to bounded
    // default-filter boundary reporting; the renderer/wire cannot request it.
    // Notes Vault and git metadata retain their separate legacy policies.
    // Health transitions flow back over fs:watch-health (BST-568 slice 3).
    startWatch: async (directoryPath, onChanges, onHealth) => {
      let mounted: MountedWorkspaceRoot | undefined;
      const lease = await fileSystemDomain.roots.borrowSourceRootForPath(
        directoryPath,
        (root, ...callbacks) => {
          mounted = root;
          return watches.subscribe(root, ...callbacks);
        }
      );
      try {
        await lease.subscribe(
          (changes, metadata) => onChanges([...changes], metadata),
          () => undefined,
          onHealth,
          { requestId: 'visible-root-watch', signal: new AbortController().signal }
        );
        const captured = mounted;
        if (!captured) {
          throw new Error('Visible root watch did not acquire the mounted capability.');
        }
        return { close: () => lease.retire(), retry: () => watches.retry(captured) };
      } catch (error) {
        try {
          await lease.retire();
        } catch (retirementError) {
          throw new ParcelWatchRetirementError([error, retirementError], () => lease.retire());
        }
        throw error;
      }
    },
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

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      const retirements = [
        unregisterEmbeddingBackfillIpcHandlers,
        unregisterDatabaseIpcHandlers,
        unregisterStoragePreferencesIpcHandlers,
        unregisterFileSystemWatchIpcHandlers,
        () => watches.close(),
        () => fileSystemDomain.close(),
      ];
      const results = await Promise.allSettled(retirements.map(async (retire) => retire()));
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Application filesystem owners did not retire.');
      }
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  return { close, roots: fileSystemDomain.roots, watches };
}
