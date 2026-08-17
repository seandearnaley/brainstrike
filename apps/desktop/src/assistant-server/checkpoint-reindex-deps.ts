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
import { triggerEditedFileReindex, triggerFileDeletionInvalidation } from './reindex-side-effects';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';

/**
 * Reindex actions the snapshot restore engines emit after mutating the
 * filesystem (rewind in `rewind-snapshot-engine.ts`, checkpoint undo in
 * `checkpoint-snapshot-undo.ts`). Originally defined by the retired journal
 * revert executor (`edit-checkpoint-revert.ts`, deleted in BST-1164 T4); the
 * types moved HERE with the seam. The former `rename` action died with that
 * executor: snapshot restores express a rename undo as restore + delete of
 * the two paths, so only those two actions remain.
 */
export type CheckpointReindexAction =
  | {
      readonly kind: 'restore';
      readonly rootId: string;
      readonly workspacePath: string;
      readonly absolutePath: string;
      readonly content: string;
      readonly size: number;
    }
  | { readonly kind: 'delete'; readonly rootId: string; readonly workspacePath: string };

export interface CheckpointRevertDeps {
  readonly reindex: (action: CheckpointReindexAction) => Promise<void>;
}

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
      await triggerFileDeletionInvalidation({
        rootId: action.rootId,
        runtimeData,
        workspacePath: action.workspacePath,
      });
    },
  };
}
