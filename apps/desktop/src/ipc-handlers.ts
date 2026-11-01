import path from 'node:path';
import { startJoinedRootWatch } from '@brainstrike/file-system/native-watch';
import type { ContentClearResult } from '@brainstrike/types';
import { registerFileSystemIpcHandlers } from './ipc-domains/file-system-ipc';
import { type HostMountedRoot, IndexSourceRoots } from './ipc-domains/index-source-roots';
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
  readonly getUserDataPath?: () => string;
  readonly onClearContent?: () => Promise<ContentClearResult>;
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
  /** The host's mounted folders, which Main's native index reads (ADR-0029 stage 4). */
  readonly readMountedRoots: () => Promise<readonly HostMountedRoot[]>;
}

/**
 * Register all IPC handlers used by the desktop application.
 *
 * This file is intentionally a thin composition root. Domain ownership lives in
 * `ipc-domains/*` so adding a channel requires one domain contract, one handler,
 * and focused tests without growing a monolithic Electron main-process file.
 */
export function registerIpcHandlers(options: RegisterIpcHandlerOptions): () => Promise<void> {
  return createApplicationIpcDomain(options).close;
}

export interface ApplicationIpcDomain {
  close(): Promise<void>;
  /** The native index's read handles on the folders the agent host keeps live. */
  readonly roots: IndexSourceRoots;
  readonly watches: WorkspaceRootWatchOwner;
}

export function createApplicationIpcDomain(
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
  const unregisterFileSystem = registerFileSystemIpcHandlers({
    ...(options.onDeleteRootData ? { onDeleteRootData: options.onDeleteRootData } : {}),
  });
  const roots = new IndexSourceRoots({
    readMountedRoots: options.readMountedRoots,
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
        unregisterFileSystem,
        () => roots.close(),
        () => watches.close(),
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
  return { close, roots, watches };
}
