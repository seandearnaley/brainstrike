import { refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.ts';
import type {
  HostClientOrigin,
  HostCommandSessionMethod,
  HostCommandSessionMethods,
  HostTerminalMethod,
  HostTerminalSession,
  HostTerminalSessionMethods,
  HostTerminals,
} from './ports.ts';
import { TERMINAL_EVENT } from './protocol.ts';

const logger = createLogger('AgentHostTerminals');

/**
 * ADR-0029 stage 3: the Terminal panel on one authenticated connection. Only
 * the desktop's private clients reach it. A connection's terminals push only
 * to it, and end when it closes, as a closed window's did.
 */
export function bindHostTerminalMethods(
  handle: HostMethodHandler,
  connection: MessageConnection,
  terminals: HostTerminals | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let session: HostTerminalSession | undefined;
  const service = (): HostTerminals => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.terminal-desktop-only',
        "Terminals are available only to the desktop's private client"
      );
    }
    if (!terminals) {
      throw refusalError(
        'configuration',
        'workspace.terminal-unavailable',
        'Terminals are unavailable on this host'
      );
    }
    return terminals;
  };
  const serveSession = <M extends HostTerminalMethod>(method: M): void => {
    handle(method, (params) => {
      session ??= service().open((event) => {
        connection.sendNotification(TERMINAL_EVENT, event).catch(() => connection.dispose());
      });
      const methods: HostTerminalSessionMethods = session;
      return methods[method](params);
    });
  };
  const serveSessions = <M extends HostCommandSessionMethod>(method: M): void => {
    handle(method, (params) => {
      const methods: HostCommandSessionMethods = service();
      return methods[method](params);
    });
  };
  serveSessions('command-sessions/list');
  serveSessions('command-sessions/read');
  serveSessions('command-sessions/remove');
  serveSessions('command-sessions/stop');
  serveSessions('command-sessions/write');
  serveSession('terminal/create');
  serveSession('terminal/destroy');
  serveSession('terminal/resize');
  serveSession('terminal/write');
  return {
    dispose: () => {
      const closing = session;
      session = undefined;
      closing?.close().catch((cause: unknown) => {
        logger.warn("Could not end a closed client's terminals", { cause });
      });
    },
  };
}
