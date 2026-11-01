import { refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.ts';
import type {
  HostClientOrigin,
  HostFileReads,
  HostFileSearch,
  HostFileWatches,
  HostFileWatchMethod,
  HostFileWatchSession,
  HostFileWatchSessionMethods,
  HostRootRegistry,
} from './ports.ts';
import { FILE_SEARCH_BATCH, type FileSearchBatch, WORKSPACE_FILES_EVENT } from './protocol.ts';

const logger = createLogger('AgentHostFileWatches');

/** The desktop's private client reaches the Explorer's file services; nothing else does. */
function desktopOnly<S>(service: S | undefined, origin: HostClientOrigin, subject: string): S {
  if (origin !== 'desktop-ui') {
    throw refusalError(
      'authorization',
      'workspace.files-desktop-only',
      `Workspace file ${subject} is available only to the desktop's private client`
    );
  }
  if (!service) {
    throw refusalError(
      'configuration',
      'workspace.files-unavailable',
      `Workspace file ${subject} is unavailable on this host`
    );
  }
  return service;
}

/** ADR-0029 stage 4: the Explorer's reads of live roots, for the desktop's private clients. */
export function bindHostFileReadMethods(
  handle: HostMethodHandler,
  fileReads: HostFileReads | undefined,
  origin: HostClientOrigin
): void {
  handle('workspace/files/exists', (params) =>
    desktopOnly(fileReads, origin, 'reading')['workspace/files/exists'](params)
  );
  handle('workspace/files/list', (params) =>
    desktopOnly(fileReads, origin, 'reading')['workspace/files/list'](params)
  );
  handle('workspace/files/read', (params) =>
    desktopOnly(fileReads, origin, 'reading')['workspace/files/read'](params)
  );
}

/**
 * ADR-0035: the Explorer's Search tab, for the desktop's private clients. A
 * search's batches go only to the connection that started it, and none is
 * sent once the client cancels the request or the connection closes.
 */
export function bindHostFileSearchMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  fileSearch: HostFileSearch | undefined,
  origin: HostClientOrigin
): void {
  handle('workspace/files/search', async (params, signal) => {
    const service = desktopOnly(fileSearch, origin, 'search');
    return await service.search(params, signal, (matches) => {
      if (signal.aborted) {
        return;
      }
      const batch: FileSearchBatch = { matches, searchId: params.searchId };
      connection.sendNotification(FILE_SEARCH_BATCH, batch).catch(() => connection.dispose());
    });
  });
}

/** ADR-0029 stage 4: the workspace's open folders, for the desktop's private clients. */
export function bindHostRootRegistryMethods(
  handle: HostMethodHandler,
  rootRegistry: HostRootRegistry | undefined,
  origin: HostClientOrigin
): void {
  const serve = <M extends keyof HostRootRegistry>(method: M): void => {
    handle(method, (params) => {
      const registry: HostRootRegistry = desktopOnly(rootRegistry, origin, 'folders');
      return registry[method](params);
    });
  };
  serve('workspace/roots/add');
  serve('workspace/roots/delete-data');
  serve('workspace/roots/mounted');
  serve('workspace/roots/open');
  serve('workspace/roots/pick');
  serve('workspace/roots/recent');
  serve('workspace/roots/release-data-deletion');
  serve('workspace/roots/remove');
  serve('workspace/roots/reserve-data-deletion');
  serve('workspace/roots/restore');
  serve('workspace/roots/seed-for-e2e');
}

/**
 * ADR-0029 stage 4: the Explorer's root watches on one authenticated
 * connection. Only the desktop's private clients reach them. A connection's
 * watches push only to it, and end when it closes, as a closed window's did.
 */
export function bindHostFileWatchMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  fileWatches: HostFileWatches | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let session: HostFileWatchSession | undefined;
  const serve = <M extends HostFileWatchMethod>(method: M): void => {
    handle(method, (params) => {
      session ??= desktopOnly(fileWatches, origin, 'watching').open((event) => {
        connection.sendNotification(WORKSPACE_FILES_EVENT, event).catch(() => connection.dispose());
      });
      const methods: HostFileWatchSessionMethods = session;
      return methods[method](params);
    });
  };
  serve('workspace/files/unwatch');
  serve('workspace/files/watch');
  serve('workspace/files/watch-retry');
  return {
    dispose: () => {
      const closing = session;
      session = undefined;
      closing?.close().catch((cause: unknown) => {
        logger.warn("Could not stop a closed client's file watches", { cause });
      });
    },
  };
}
