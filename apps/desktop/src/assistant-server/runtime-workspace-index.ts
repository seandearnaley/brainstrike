/**
 * Workspace Index runtime-metadata normalization (BST-743): the strict-trim
 * summary of the renderer-supplied Workspace Index hints, shared by BOTH the
 * `listEmbeddingSpaces` tool (to flag the recommended workspace-search space)
 * and the workspace-context tools (to report index state).
 *
 * Leaf module: depends only on the RuntimeData type — never on
 * `assistant-tools.ts`, so no import cycle is possible.
 */
import type { RuntimeData } from '@brainstrike/agent';

export interface WorkspaceIndexSummary {
  embeddingSetId: string | null;
  enabled: boolean;
  mode: string | null;
  paused: boolean;
}

export function normalizeRuntimeWorkspaceIndex(
  runtimeData: RuntimeData | undefined
): WorkspaceIndexSummary {
  const rawEmbeddingSetId = runtimeData?.workspaceIndexEmbeddingSetId;
  const embeddingSetId =
    typeof rawEmbeddingSetId === 'string' && rawEmbeddingSetId.trim().length > 0
      ? rawEmbeddingSetId.trim()
      : null;
  return {
    embeddingSetId,
    enabled: runtimeData?.workspaceIndexingEnabled === true,
    mode:
      typeof runtimeData?.workspaceIndexingMode === 'string' &&
      runtimeData.workspaceIndexingMode.trim().length > 0
        ? runtimeData.workspaceIndexingMode.trim()
        : null,
    paused: runtimeData?.workspaceIndexingPaused === true,
  };
}
