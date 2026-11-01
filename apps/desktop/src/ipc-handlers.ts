import path from 'node:path';
import type { ManagedWorktreeAuthorizer } from '@brainstrike/assistant-service/node-workspace-services';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { startJoinedRootWatch } from '@brainstrike/file-system/native-watch';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { ContentClearResult } from '@brainstrike/types';
import { createFileSystemIpcDomain } from './ipc-domains/file-system-ipc';
import { registerWorkspaceLedgersE2eHandlers } from './ipc-domains/workspace-ledgers-e2e-ipc';
import type { WorkspaceRootRegistry } from './ipc-domains/workspace-root-registry';
import {
  createWorkspaceRootWatchOwner,
  type WorkspaceRootWatchOwner,
} from './ipc-domains/workspace-root-watch-owner';
import {
  registerContentClearIpcHandlers,
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from './ipc-factory-reset';
import { lifecycleDelaySeam } from './lifecycle-delay-seam';

interface RegisterIpcHandlerOptions {
  readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  readonly getUserDataPath?: () => string;
  readonly managedWorktreeAuthorizer?: ManagedWorktreeAuthorizer;
  readonly onClearContent?: () => Promise<ContentClearResult>;
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
  readonly onWorkspaceRootGranted?: (grantedPath: string) => void;
  readonly onWorkspaceRootsChanged?: () => void;
  /** Resolves once the roots catalog's profile is open (a factory reset holds it). */
  readonly whenRootsCatalogOpen?: () => Promise<void>;
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
  options: RegisterIpcHandlerOptions
): () => Promise<void> {
  return createApplicationIpcDomain(fileSystem, storage, options).close;
}

export interface ApplicationIpcDomain {
  close(): Promise<void>;
  readonly roots: WorkspaceRootRegistry;
  readonly watches: WorkspaceRootWatchOwner;
}

export function createApplicationIpcDomain(
  fileSystem: ElectronFileSystemAdapter,
  storage: ElectronStorageAdapter,
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
  const unregisterWorkspaceLedgersE2eHandlers = registerWorkspaceLedgersE2eHandlers({ storage });
  const fileSystemDomain = createFileSystemIpcDomain({
    fileSystem,
    ...(options?.onDeleteRootData ? { onDeleteRootData: options.onDeleteRootData } : {}),
    getRootsCatalog: options.getRootsCatalog,
    ...(options.whenRootsCatalogOpen ? { whenRootsCatalogOpen: options.whenRootsCatalogOpen } : {}),
    ...(options?.managedWorktreeAuthorizer
      ? { managedWorktreeAuthorizer: options.managedWorktreeAuthorizer }
      : {}),
    ...(options?.onWorkspaceRootGranted
      ? { onWorkspaceRootGranted: options.onWorkspaceRootGranted }
      : {}),
    ...(options?.onWorkspaceRootsChanged
      ? { onWorkspaceRootsChanged: options.onWorkspaceRootsChanged }
      : {}),
    storage,
  });
  const watches = createWorkspaceRootWatchOwner({
    startWatch: (mounted, onChanges, onHealth) =>
      startJoinedRootWatch(
        {
          kind: 'directory',
          name: path.basename(mounted.canonicalPath),
          path: mounted.canonicalPath,
          platform: 'electron',
        },
        onChanges,
        {
          beforeSubscribe: () => lifecycleDelaySeam().delay('root-watch-subscribe'),
          onHealth,
          reportDefaultFilteredChanges: true,
        }
      ),
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      const retirements = [
        ...(unregisterProfilePath ? [unregisterProfilePath] : []),
        ...(unregisterContentClear ? [unregisterContentClear] : []),
        ...(unregisterFactoryReset ? [unregisterFactoryReset] : []),
        unregisterWorkspaceLedgersE2eHandlers,
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
