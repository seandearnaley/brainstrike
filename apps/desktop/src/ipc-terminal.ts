import { ipcMain } from 'electron';
import {
  type CommandSessionIdentityParams,
  type CommandSessionIpcHandlers,
  type CommandSessionListParams,
  type CommandSessionReadParams,
  type CommandSessionWriteParams,
  createCommandSessionIpcHandlers,
} from './command-session-ipc-handlers';
import { getDatabase } from './db-main';
import { createDatabaseRootResolver } from './git-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import {
  createTerminalIpcHandlers,
  registerTerminalIpcHandlers,
  type TerminalIpcHandlers,
} from './terminal-ipc-handlers';

/**
 * Register the desktop `terminal` IPC domain (a PTY backend).
 *
 * `terminal:create` resolves + containment-checks the renderer-supplied `rootId`
 * against the DB-backed workspace roots (the SAME resolver the git domain uses),
 * pins the pty cwd to that canonical root, and spawns the platform shell via
 * node-pty. pty output/exit are pushed one-way to the OWNING renderer over
 * `terminal:data` / `terminal:exit`. The returned disposer unregisters the
 * channels AND reaps every live pty (no orphans on host re-init / shutdown).
 */
export function registerTerminalIpc(
  handlers: TerminalIpcHandlers = createTerminalIpcHandlers({
    resolver: createDatabaseRootResolver(getDatabase),
  }),
  commandSessionHandlers: CommandSessionIpcHandlers = createCommandSessionIpcHandlers()
): () => void {
  const unregisterTerminal = registerTerminalIpcHandlers(handlers);
  const registry = createDesktopIpcRegistry({ ipcMain });
  registry.registerInvoke(
    'commandSessions',
    DESKTOP_IPC_CHANNELS.commandSessions.list,
    (_event, params: CommandSessionListParams) => commandSessionHandlers.list(params)
  );
  registry.registerInvoke(
    'commandSessions',
    DESKTOP_IPC_CHANNELS.commandSessions.read,
    (_event, params: CommandSessionReadParams) => commandSessionHandlers.read(params)
  );
  registry.registerInvoke(
    'commandSessions',
    DESKTOP_IPC_CHANNELS.commandSessions.write,
    (_event, params: CommandSessionWriteParams) => commandSessionHandlers.write(params)
  );
  registry.registerInvoke(
    'commandSessions',
    DESKTOP_IPC_CHANNELS.commandSessions.stop,
    (_event, params: CommandSessionIdentityParams) => commandSessionHandlers.stop(params)
  );
  registry.registerInvoke(
    'commandSessions',
    DESKTOP_IPC_CHANNELS.commandSessions.remove,
    (_event, params: CommandSessionIdentityParams) => commandSessionHandlers.remove(params)
  );

  return () => {
    registry.unregisterAll();
    unregisterTerminal();
  };
}
