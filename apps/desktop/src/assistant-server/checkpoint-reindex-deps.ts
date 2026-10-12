/**
 * The reindex seam Conversation Rewind's `changes` handlers feed after a
 * restore. It lives outside any module that imports `electron` at module
 * scope because `changes-ipc-handlers.ts` is unit-tested without an Electron
 * runtime.
 */
import type { RuntimeData } from '@brainstrike/agent';
import type { MainQueryHandle } from './main-query-handle';
import { triggerEditedFileReindex, triggerFileDeletionInvalidation } from './reindex-side-effects';

const WORKSPACE_INDEX_SYSTEM_ROLE = 'workspace-index';

/**
 * Reindex actions the snapshot rewind engine (`rewind-snapshot-engine.ts`)
 * emits after mutating the filesystem. Snapshot restores express a rename
 * undo as restore + delete of the two paths, so only those two actions exist.
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
  db: MainQueryHandle
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
