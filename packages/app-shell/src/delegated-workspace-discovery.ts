import type { RediscoveredToolApproval } from '@brainstrike/assistant-contract/tool-approval';
import type { SuspendedRunDiscovery } from '@brainstrike/assistant-data';
import type { DelegatedConversationNode } from '@brainstrike/db';
import {
  resolveChildContinuationIdentity,
  resolveDelegatedWorkspaceIdentity,
  type WorkspaceDecisionRepository,
} from './resolve-delegated-workspace-identity';

/** Decisions are owned by the root; the child only displays its matching path. */
export function createDelegatedWorkspaceDiscovery(
  repository: WorkspaceDecisionRepository,
  node: DelegatedConversationNode,
  discoverRoot: SuspendedRunDiscovery
): SuspendedRunDiscovery {
  return async (threadId, resourceId) => {
    if (threadId !== node.threadId || resourceId !== node.resourceId) {
      throw new Error('Child discovery received a different conversation identity.');
    }
    const result = await discoverRoot(node.rootThreadId, node.ownerResourceId);
    let invalidBinding = false;
    const belongs = async (
      pause: Pick<RediscoveredToolApproval, 'delegation' | 'continuationId' | 'runId'>
    ): Promise<boolean> => {
      try {
        if (pause.continuationId) {
          return (
            (await resolveChildContinuationIdentity(repository, node, {
              continuationId: pause.continuationId,
              runId: pause.runId,
              ...(pause.delegation ? { path: pause.delegation.path } : {}),
            })) !== undefined
          );
        }
        if (!pause.delegation) {
          return false;
        }
        return (
          (await resolveDelegatedWorkspaceIdentity(repository, node, pause.delegation.path)) !==
          undefined
        );
      } catch {
        invalidBinding = true;
        return false;
      }
    };
    const [approvals, suspends] = await Promise.all([
      Promise.all(result.approvals.map(belongs)),
      Promise.all(result.suspends.map(belongs)),
    ]);
    const error = invalidBinding ? { reason: 'invalid-response' as const } : result.error;
    return {
      approvals: result.approvals.filter((_pause, index) => approvals[index]),
      suspends: result.suspends.filter((_pause, index) => suspends[index]),
      ...(error ? { error } : {}),
    };
  };
}
