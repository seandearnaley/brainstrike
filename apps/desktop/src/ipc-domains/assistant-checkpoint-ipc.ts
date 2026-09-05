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

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

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

  registry.registerUnauthenticatedInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.availability,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, payload: unknown) => handlers.availability(payload)
  );
  registry.registerUnauthenticatedInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertEntry,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, payload: unknown) => handlers.revertEntry(payload)
  );
  registry.registerUnauthenticatedInvoke(
    'assistantCheckpoint',
    DESKTOP_IPC_CHANNELS.assistantCheckpoint.revertRun,
    UNAUTHENTICATED_SENDER_POLICY,
    (_event, payload: unknown) => handlers.revertRun(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
