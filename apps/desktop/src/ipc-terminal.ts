import { ipcMain } from 'electron';
import { hostCommandSessions } from './agent-host-platform/host-command-session-client';
import {
  type CommandSessionInventoryHandlers,
  type CommandSessionIpcHandlers,
  createCommandSessionIpcHandlers,
  withHostCommandSessions,
} from './command-session-ipc-handlers';
import { getDatabase } from './db-main';
import { createDatabaseRootResolver } from './git-ipc-handlers';
import { commandSessionsContract } from './ipc-domains/command-sessions.contract';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';
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
  commandSessionHandlers:
    | CommandSessionInventoryHandlers
    | CommandSessionIpcHandlers = withHostCommandSessions(
    createCommandSessionIpcHandlers(),
    hostCommandSessions
  )
): () => void {
  const unregisterTerminal = registerTerminalIpcHandlers(handlers);
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'commandSessions', commandSessionsContract, commandSessionHandlers);

  return () => {
    registry.unregisterAll();
    unregisterTerminal();
  };
}
