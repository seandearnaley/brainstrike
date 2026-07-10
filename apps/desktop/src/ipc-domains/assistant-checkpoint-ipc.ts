import type { RuntimeData } from '@brainstrike/agent';
import { ipcMain } from 'electron';
import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
  triggerRenamedDestinationReindex,
} from '../assistant-server/assistant-tools';
import type { EditCheckpointDatabase } from '../assistant-server/edit-checkpoint-journal';
import {
  type CheckpointReindexAction,
  type CheckpointRevertDeps,
  revertCheckpointEntry,
  revertCheckpointRun,
} from '../assistant-server/edit-checkpoint-revert';
import { getDatabase } from '../db-main';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { createAssistantCheckpointHandlers } from './assistant-checkpoint-handlers';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';

/**
 * Build the revert reindex seam from the SAME non-fatal helpers the write tools
 * use. Revert has no live `runtimeData`, so the current workspace-index embedding
 * set id is resolved from the DB and threaded through a synthetic runtimeData; a
 * missing set means the seams no-op (background sync reconciles) — never a fake.
 */
async function createCheckpointReindexDeps(
  db: EditCheckpointDatabase
): Promise<CheckpointRevertDeps> {
  let workspaceIndexEmbeddingSetId: string | undefined;
  try {
    const result = await db.query<{ id: string }>(
      'SELECT id FROM embedding_sets WHERE system_role = $1 LIMIT 1',
      [WORKSPACE_INDEX_SYSTEM_ROLE]
    );
    workspaceIndexEmbeddingSetId = result.rows[0]?.id;
  } catch {
    workspaceIndexEmbeddingSetId = undefined;
  }
  const runtimeData = { workspaceIndexEmbeddingSetId } as unknown as RuntimeData;

  return {
    reindex: async (action: CheckpointReindexAction): Promise<void> => {
      if (action.kind === 'restore') {
        await triggerEditedFileReindex({
          absolutePath: action.absolutePath,
          content: action.content,
          rootId: action.rootId,
          runtimeData,
          size: action.size,
          workspacePath: action.workspacePath,
        });
        return;
      }
      if (action.kind === 'delete') {
        await triggerFileDeletionInvalidation({
          rootId: action.rootId,
          runtimeData,
          workspacePath: action.workspacePath,
        });
        return;
      }
      // rename-back: the pre-revert location is now empty (invalidate it) and the
      // restored original path is re-indexed.
      await triggerFileDeletionInvalidation({
        rootId: action.rootId,
        runtimeData,
        workspacePath: action.toWorkspacePath,
      });
      await triggerRenamedDestinationReindex({
        absolutePath: action.toAbsolutePath,
        rootId: action.rootId,
        rootPath: action.rootPath,
        runtimeData,
        workspacePath: action.fromWorkspacePath,
      });
    },
  };
}

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
