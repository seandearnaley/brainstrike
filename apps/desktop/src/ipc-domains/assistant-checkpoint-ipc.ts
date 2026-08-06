import { ipcMain } from 'electron';
// Shared with the `changes` rewind handlers (BST-1115 W5 T4) — see that module.
import { createCheckpointReindexDeps } from '../assistant-server/checkpoint-reindex-deps';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import {
  revertCheckpointEntry,
  revertCheckpointRun,
} from '../assistant-server/edit-checkpoint-revert';
import { getDatabase } from '../db-main';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { createAssistantCheckpointHandlers } from './assistant-checkpoint-handlers';

export function registerAssistantCheckpointIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createAssistantCheckpointHandlers({
    createReindexDeps: createCheckpointReindexDeps,
    resolveDatabase: async () => (await getDatabase()) as unknown as EditCheckpointDatabase,
    revertEntry: revertCheckpointEntry,
    revertRun: revertCheckpointRun,
  });

  registry.registerInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertEntry,
    (_event, payload: unknown) => handlers.revertEntry(payload)
  );
  registry.registerInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertRun,
    (_event, payload: unknown) => handlers.revertRun(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
