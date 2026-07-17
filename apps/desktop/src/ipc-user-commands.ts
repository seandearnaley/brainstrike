import { ipcMain } from 'electron';
import { createUserCommandsListHandler } from './ipc-user-commands-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Registers the user-defined slash command discovery IPC (desktop-only). The
 * renderer's composer calls `list` to populate the "/" menu with commands
 * scanned from `.brainstrike/commands` + `.claude/commands` across the mounted
 * roots and the home directory.
 */
export function registerUserCommandsIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const listUserCommands = createUserCommandsListHandler();

  registry.registerInvoke('userCommands', DESKTOP_IPC_CHANNELS.userCommands.list, () =>
    listUserCommands()
  );

  return () => {
    registry.unregisterAll();
  };
}
