import path from 'node:path';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import {
  ParcelWatchRetirementError,
  startJoinedParcelWatch,
} from '@brainstrike/file-system/native-watch';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { ContentClearResult } from '@brainstrike/types';
import type ElectronStore from 'electron-store';
import type { ChunkingHostManager } from './chunking-host-manager';
import type { EmbeddingHostManager } from './embedding-host-manager';
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
import {
  registerContentClearIpcHandlers,
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from './ipc-factory-reset';
import type { DesktopSettingsStoreSchema } from './store-schema';

interface RegisterIpcHandlerOptions {
  readonly chunkingHostManager?: ChunkingHostManager;
  readonly embeddingHostManager?: EmbeddingHostManager;
  readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  readonly getUserDataPath?: () => string;
  /** Explicit test-harness seam for synthetic filesystem adapters. */
  readonly isSyntheticFileSystemPath?: (rootPath: string) => boolean;
  readonly managedWorktreeAuthorizer?: ManagedWorktreeAuthorizer;
  readonly onClearContent?: () => Promise<ContentClearResult>;
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
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
  options: RegisterIpcHandlerOptions
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
  options: RegisterIpcHandlerOptions
): ApplicationIpcDomain {
  const unregisterProfilePath = options.getUserDataPath
    ? registerProfilePathIpcHandlers(options.getUserDataPath)
    : undefined;
  const unregisterContentClear = options.onClearContent
    ? registerContentClearIpcHandlers(options.onClearContent)
    : undefined;
  const unregisterFactoryReset = options.onResetLocal
    ? registerFactoryResetIpcHandlers(options.onResetLocal)
    : undefined;
  const unregisterStoragePreferencesIpcHandlers = registerStoragePreferencesIpcHandlers({
    getStore,
    storage,
    ...(options?.onStorageChanged ? { onStorageChanged: options.onStorageChanged } : {}),
  });
  const fileSystemDomain = createFileSystemIpcDomain({
    fileSystem,
    ...(options?.onDeleteRootData ? { onDeleteRootData: options.onDeleteRootData } : {}),
    getRootsCatalog: options.getRootsCatalog,
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

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      const retirements = [
        ...(unregisterProfilePath ? [unregisterProfilePath] : []),
        ...(unregisterContentClear ? [unregisterContentClear] : []),
        ...(unregisterFactoryReset ? [unregisterFactoryReset] : []),
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
