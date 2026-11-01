import { refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.ts';
import type {
  HostClientOrigin,
  HostFileWatches,
  HostFileWatchMethod,
  HostFileWatchSession,
  HostFileWatchSessionMethods,
} from './ports.ts';
import { WORKSPACE_FILES_EVENT } from './protocol.ts';

const logger = createLogger('AgentHostFileWatches');

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
  const service = (): HostFileWatches => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.files-desktop-only',
        "Workspace file watching is available only to the desktop's private client"
      );
    }
    if (!fileWatches) {
      throw refusalError(
        'configuration',
        'workspace.files-unavailable',
        'Workspace file watching is unavailable on this host'
      );
    }
    return fileWatches;
  };
  const serve = <M extends HostFileWatchMethod>(method: M): void => {
    handle(method, (params) => {
      session ??= service().open((event) => {
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
