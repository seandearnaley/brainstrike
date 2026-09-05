import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { userCommandsContract } from './ipc-domains/user-commands.contract';
import { createUserCommandsListHandler } from './ipc-user-commands-handlers';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/**
 * Registers the user-defined slash command discovery IPC (desktop-only). The
 * renderer's composer calls `list` to populate the "/" menu with commands
 * scanned from `.brainstrike/commands` + `.claude/commands` across the mounted
 * roots and the home directory.
 */
export function registerUserCommandsIpcHandlers(
  listUserCommands: () => Promise<UserSlashCommandsListResult> = createUserCommandsListHandler()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'userCommands', userCommandsContract, {
    list: () =>
      settleIpcResult({ category: 'userCommands', code: 'list_failed' }, listUserCommands),
  });
  return () => {
    registry.unregisterAll();
  };
}
