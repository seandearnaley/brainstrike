import { refusalError } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import type { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.ts';
import type {
  HostClientOrigin,
  HostWorkspaceFileMethod,
  HostWorkspaceFileMethods,
  HostWorkspaceFiles,
  HostWorkspaceWatchMethod,
  HostWorkspaceWatchSession,
  HostWorkspaceWatchSessionMethods,
} from './ports.ts';
import { WORKSPACE_FILES_EVENT, WORKSPACE_FILES_RESULT_SCHEMAS } from './protocol.ts';

const logger = createLogger('AgentHostWorkspaceFiles');

/**
 * ADR-0029 stage 4: the desktop's folders, Explorer reads and watchers on one
 * authenticated connection. Only the desktop's private clients reach them. A
 * connection's watchers push only to it, and stop when it closes, as a closed
 * window's did.
 */
export function bindHostWorkspaceFileMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  files: HostWorkspaceFiles | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let session: HostWorkspaceWatchSession | undefined;
  const service = (): HostWorkspaceFiles => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.files-desktop-only',
        "Workspace folders are available only to the desktop's private client"
      );
    }
    if (!files) {
      throw refusalError(
        'configuration',
        'workspace.files-unavailable',
        'Workspace folders are unavailable on this host'
      );
    }
    return files;
  };
  // The registry's folders and nodes are wider than the wire's; each result leaves in its wire
  // shape, since the client refuses an unknown key.
  const wireResult = async (
    method: HostWorkspaceWatchMethod | HostWorkspaceFileMethod,
    result: Promise<unknown>
  ): Promise<unknown> => {
    // Widened once: indexing the result map by a generic method is too deep for tsc.
    const schema: Schema.ConstraintDecoder<unknown> = WORKSPACE_FILES_RESULT_SCHEMAS[method];
    return wireDecoder(schema, { errors: 'all' })(await result);
  };
  const serveSession = <M extends HostWorkspaceWatchMethod>(method: M): void => {
    handle(method, (params) => {
      session ??= service().open((event) => {
        connection.sendNotification(WORKSPACE_FILES_EVENT, event).catch(() => connection.dispose());
      });
      const methods: HostWorkspaceWatchSessionMethods = session;
      return wireResult(method, methods[method](params));
    });
  };
  const serve = <M extends HostWorkspaceFileMethod>(method: M): void => {
    handle(method, (params) => {
      const methods: HostWorkspaceFileMethods = service();
      return wireResult(method, methods[method](params));
    });
  };
  serve('files/add-root-by-path');
  serve('files/delete-root-data');
  serve('files/e2e/seed-roots');
  serve('files/exists');
  serve('files/read-directory');
  serve('files/read-file');
  serve('files/read-file-by-absolute-path');
  serve('files/read-file-by-path');
  serve('files/recent-roots');
  serve('files/remove-root');
  serve('files/restore-last-folder');
  serve('files/restore-roots');
  serve('files/save-last-folder');
  serve('files/watch-telemetry');
  serveSession('files/unwatch');
  serveSession('files/watch');
  serveSession('files/watch-retry');
  return {
    dispose: () => {
      const closing = session;
      session = undefined;
      closing?.close().catch((cause: unknown) => {
        logger.warn("Could not stop a closed client's watchers", { cause });
      });
    },
  };
}
