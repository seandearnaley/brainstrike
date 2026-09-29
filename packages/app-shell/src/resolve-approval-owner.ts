import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import type { DelegatedConversationRepository } from '@brainstrike/db';
import { loadDelegatedWorkspaceNode } from './delegated-workspace-node';

type ApprovalOwnerRepository = Pick<DelegatedConversationRepository, 'get' | 'getInvocation'>;
export interface ApprovalOwner {
  readonly colorId: string;
  readonly displayName: string;
}
interface ApprovalScope {
  readonly ownerResourceId: string;
  readonly rootThreadId: string;
}

/** Resolve the approval's owning child from the persisted graph, in path order. */
export async function resolveApprovalOwner(
  repository: ApprovalOwnerRepository,
  scope: ApprovalScope,
  currentThreadId: string,
  approval: AssistantToolApprovalRequest
): Promise<ApprovalOwner | undefined> {
  const path = approval.delegation?.path;
  if (!path) {
    return undefined;
  }
  if (path.length === 0) {
    return undefined;
  }

  let parentThreadId = scope.rootThreadId;
  let finalParentThreadId = scope.rootThreadId;
  let parentRunId: string | undefined;
  let currentIsAncestor = currentThreadId === scope.rootThreadId;
  for (const edge of path) {
    if (parentRunId && edge.parentRuntimeRunId !== parentRunId) {
      return undefined;
    }
    const stored = await repository.getInvocation(scope, {
      parentRuntimeRunId: edge.parentRuntimeRunId,
      parentToolCallId: edge.parentToolCallId,
    });
    if (
      !stored ||
      stored.ownerResourceId !== scope.ownerResourceId ||
      stored.rootThreadId !== scope.rootThreadId ||
      stored.parentThreadId !== parentThreadId ||
      stored.parentRuntimeRunId !== edge.parentRuntimeRunId ||
      stored.parentToolCallId !== edge.parentToolCallId ||
      stored.childRuntimeRunId !== edge.childRuntimeRunId ||
      stored.personaId !== edge.personaId
    ) {
      return undefined;
    }
    finalParentThreadId = parentThreadId;
    parentThreadId = stored.threadId;
    parentRunId = edge.childRuntimeRunId;
    currentIsAncestor ||= currentThreadId === stored.threadId;
  }
  if (!currentIsAncestor) {
    return undefined;
  }
  const node = await loadDelegatedWorkspaceNode(repository, { ...scope, threadId: parentThreadId });
  return node.parentThreadId === finalParentThreadId
    ? { colorId: node.color, displayName: node.displayName }
    : undefined;
}
