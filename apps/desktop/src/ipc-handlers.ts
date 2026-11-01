import { registerFileSystemIpcHandlers } from './ipc-domains/file-system-ipc';
import {
  registerContentClearIpcHandlers,
  registerFactoryResetIpcHandlers,
  registerProfilePathIpcHandlers,
} from './ipc-factory-reset';

interface RegisterIpcHandlerOptions {
  readonly getUserDataPath?: () => string;
  readonly onClearContent?: () => Promise<void>;
  readonly onDeleteRootData?: (rootId: string) => Promise<void>;
  readonly onResetLocal?: () => Promise<{ success: boolean; message?: string }>;
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
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      const retirements = [
        ...(unregisterProfilePath ? [unregisterProfilePath] : []),
        ...(unregisterContentClear ? [unregisterContentClear] : []),
        ...(unregisterFactoryReset ? [unregisterFactoryReset] : []),
        unregisterFileSystem,
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
  return { close };
}
