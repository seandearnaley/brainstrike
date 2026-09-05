import { ipcMain } from 'electron';
import { createUserCommandsListHandler } from './ipc-user-commands-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

/**
 * Registers the user-defined slash command discovery IPC (desktop-only). The
 * renderer's composer calls `list` to populate the "/" menu with commands
 * scanned from `.brainstrike/commands` + `.claude/commands` across the mounted
 * roots and the home directory.
 */
export function registerUserCommandsIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const listUserCommands = createUserCommandsListHandler();

  registry.registerUnauthenticatedInvoke(
    'userCommands',
    DESKTOP_IPC_CHANNELS.userCommands.list,
    UNAUTHENTICATED_SENDER_POLICY,
    () => listUserCommands()
  );

  return () => {
    registry.unregisterAll();
  };
}
