import type { RediscoveredToolApproval } from '@brainstrike/assistant-contract/tool-approval';
import type { SuspendedRunDiscovery } from '@brainstrike/assistant-data';
import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';
import { resolveDelegatedWorkspaceIdentity } from './resolve-delegated-workspace-identity';

/** Decisions are owned by the root; the child only displays its matching path. */
export function createDelegatedWorkspaceDiscovery(
  repository: Pick<DelegatedConversationRepository, 'getInvocation'>,
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
      pause: Pick<RediscoveredToolApproval, 'delegation'>
    ): Promise<boolean> => {
      if (!pause.delegation) {
        return false;
      }
      try {
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
    const error =
      result.error ?? (invalidBinding ? { reason: 'invalid-response' as const } : undefined);
    return {
      approvals: result.approvals.filter((_pause, index) => approvals[index]),
      suspends: result.suspends.filter((_pause, index) => suspends[index]),
      ...(error ? { error } : {}),
    };
  };
}
