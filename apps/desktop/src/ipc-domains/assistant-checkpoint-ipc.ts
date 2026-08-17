import { ipcMain } from 'electron';
// Shared with the `changes` rewind handlers (BST-1115 W5 T4) — see that module.
import { createCheckpointReindexDeps } from '../assistant-server/checkpoint-reindex-deps';
import {
  listCheckpointUndoAvailability,
  undoCheckpointEntry,
  undoCheckpointRun,
} from '../assistant-server/checkpoint-snapshot-undo';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import { createSnapshotRepository } from '../assistant-server/snapshot-repository';
import type { SnapshotService } from '../assistant-server/snapshot-service';
import { getDatabase } from '../db-main';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { createAssistantCheckpointHandlers } from './assistant-checkpoint-handlers';

export interface AssistantCheckpointIpcOptions {
  /** Lazy: the ONE snapshot service is constructed at app-ready, after IPC
   * registration (same posture as the changes handlers). */
  readonly resolveSnapshotService: () => SnapshotService | null;
}

export function registerAssistantCheckpointIpcHandlers(
  options: AssistantCheckpointIpcOptions
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const handlers = createAssistantCheckpointHandlers({
    availability: listCheckpointUndoAvailability,
    createReindexDeps: createCheckpointReindexDeps,
    createSnapshotRepository,
    resolveDatabase: async () => (await getDatabase()) as unknown as EditCheckpointDatabase,
    resolveSnapshotService: options.resolveSnapshotService,
    undoEntry: undoCheckpointEntry,
    undoRun: undoCheckpointRun,
  });

  registry.registerInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.availability,
    (_event, payload: unknown) => handlers.availability(payload)
  );
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
