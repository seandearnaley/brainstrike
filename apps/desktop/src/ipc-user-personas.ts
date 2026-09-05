import { ipcMain } from 'electron';
import { createUserPersonasListHandler } from './ipc-user-personas-handlers';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

/**
 * Registers the subagent persona discovery IPC (desktop-only). The Settings →
 * Subagents panel calls `list` to show built-in + user-defined personas
 * (including invalid persona files with their error) scanned from
 * `.brainstrike/agents` across the mounted roots and the home directory.
 */
export function registerUserPersonasIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const listPersonas = createUserPersonasListHandler();

  registry.registerUnauthenticatedInvoke(
    'userPersonas',
    DESKTOP_IPC_CHANNELS.userPersonas.list,
    UNAUTHENTICATED_SENDER_POLICY,
    () => listPersonas()
  );

  return () => {
    registry.unregisterAll();
  };
}
