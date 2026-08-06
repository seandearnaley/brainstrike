/**
 * The reindex seam every checkpoint-revert caller shares.
 *
 * Extracted from `ipc-domains/assistant-checkpoint-ipc.ts` (BST-1115 W5 T4)
 * because Conversation Rewind's `changes` handlers need the SAME
 * `CheckpointRevertDeps` and must not reach through a module that imports
 * `electron` at module scope — `changes-ipc-handlers.ts` is unit-tested
 * without an Electron runtime. Behaviour is unchanged; only the home moved.
 */
import type { RuntimeData } from '@brainstrike/agent';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import type { CheckpointReindexAction, CheckpointRevertDeps } from './edit-checkpoint-revert';
import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
  triggerRenamedDestinationReindex,
} from './reindex-side-effects';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';

/**
 * Build the revert reindex seam from the SAME non-fatal helpers the write tools
 * use. Revert has no live `runtimeData`, so the current workspace-index embedding
 * set id is resolved from the DB and threaded through a synthetic runtimeData; a
 * missing set means the seams no-op (background sync reconciles) — never a fake.
 */
export async function createCheckpointReindexDeps(
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
