import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
import { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
import type { DelegatedConversationRuntimeOptions } from '@brainstrike/assistant-ui';
import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';

/** Bind a rediscovered decision to its selected child, never to a persona label. */
export async function resolveDelegatedWorkspaceIdentity(
  repository: Pick<DelegatedConversationRepository, 'getInvocation'>,
  node: DelegatedConversationNode,
  path: readonly DelegatedRunIdentity[]
): Promise<DelegatedRunIdentity | undefined> {
  const scope = { ownerResourceId: node.ownerResourceId, rootThreadId: node.rootThreadId };
  for (const edge of path) {
    const stored = await repository.getInvocation(scope, {
      parentRuntimeRunId: edge.parentRuntimeRunId,
      parentToolCallId: edge.parentToolCallId,
    });
    if (
      !(
        stored &&
        stored.ownerResourceId === scope.ownerResourceId &&
        stored.rootThreadId === scope.rootThreadId &&
        stored.parentRuntimeRunId === edge.parentRuntimeRunId &&
        stored.parentToolCallId === edge.parentToolCallId &&
        stored.childRuntimeRunId === edge.childRuntimeRunId &&
        stored.personaId === edge.personaId
      )
    ) {
      throw new Error('The restored decision conflicts with its durable invocation binding.');
    }
    if (stored.threadId === node.threadId) {
      return edge;
    }
  }
  return undefined;
}

export async function resolveDelegatedWorkspaceDecision(
  repository: Pick<DelegatedConversationRepository, 'getInvocation'>,
  node: DelegatedConversationNode,
  message: Parameters<DelegatedConversationRuntimeOptions['onNew']>[0]
): Promise<DelegatedRunIdentity> {
  const approval = readToolApprovalRunConfigAction(message.runConfig);
  const resume = readToolResumeRunConfigAction(message.runConfig);
  const result = approval ?? resume;
  if ((approval && resume) || !result || !('action' in result) || !result.action.delegation) {
    throw new Error('This child view accepts an unambiguous delegated decision only.');
  }
  const identity = await resolveDelegatedWorkspaceIdentity(
    repository,
    node,
    result.action.delegation.path
  );
  if (!identity) {
    throw new Error('The restored decision does not belong to this child conversation.');
  }
  return identity;
}
