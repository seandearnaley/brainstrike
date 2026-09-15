import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract';
import { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
import { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
import type {
  ChildContinuationIdentity,
  DelegatedConversationRuntimeOptions,
} from '@brainstrike/assistant-ui';
import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';

export type WorkspaceDecisionRepository = Pick<DelegatedConversationRepository, 'getInvocation'> &
  Partial<Pick<DelegatedConversationRepository, 'getContinuation'>>;

export async function resolveChildContinuationIdentity(
  repository: WorkspaceDecisionRepository,
  node: DelegatedConversationNode,
  action: {
    readonly continuationId: string;
    readonly runId: string;
    readonly path?: readonly DelegatedRunIdentity[];
  }
): Promise<
  | ChildContinuationIdentity
  | (DelegatedRunIdentity & { readonly continuationId: string })
  | undefined
> {
  if (!repository.getContinuation) {
    throw new Error('Child continuation lookup is unavailable.');
  }
  const stored = await repository.getContinuation(
    { ownerResourceId: node.ownerResourceId, rootThreadId: node.rootThreadId },
    action.continuationId
  );
  if (!stored || stored.id !== action.continuationId || stored.nativeRunId !== action.runId) {
    throw new Error('The restored decision conflicts with its durable continuation binding.');
  }
  if (stored.state !== 'awaiting-approval' && stored.state !== 'awaiting-input') {
    throw new Error('The child continuation no longer has a pending decision.');
  }
  if (action.path) {
    if (action.path[0]?.parentRuntimeRunId !== stored.nativeRunId) {
      throw new Error('The delegated path does not begin at its continuation run.');
    }
    const descendant = await resolveDelegatedWorkspaceIdentity(repository, node, action.path);
    return descendant ? { ...descendant, continuationId: stored.id } : undefined;
  }
  if (stored.threadId !== node.threadId) {
    return undefined;
  }
  if (stored.resourceId !== node.resourceId) {
    throw new Error('Child continuation resource changed.');
  }
  return { continuationId: stored.id, nativeRunId: action.runId, threadId: stored.threadId };
}

/** Bind a rediscovered decision to its selected child, never to a persona label. */
export async function resolveDelegatedWorkspaceIdentity(
  repository: WorkspaceDecisionRepository,
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
  repository: WorkspaceDecisionRepository,
  node: DelegatedConversationNode,
  message: Parameters<DelegatedConversationRuntimeOptions['onNew']>[0]
): Promise<DelegatedRunIdentity | ChildContinuationIdentity> {
  const approval = readToolApprovalRunConfigAction(message.runConfig);
  const resume = readToolResumeRunConfigAction(message.runConfig);
  const result = approval ?? resume;
  if ((approval && resume) || !result || !('action' in result)) {
    throw new Error('This child view accepts an unambiguous delegated decision only.');
  }
  const identity = result.action.continuationId
    ? await resolveChildContinuationIdentity(repository, node, {
        continuationId: result.action.continuationId,
        runId: result.action.runId,
        ...(result.action.delegation ? { path: result.action.delegation.path } : {}),
      })
    : result.action.delegation
      ? await resolveDelegatedWorkspaceIdentity(repository, node, result.action.delegation.path)
      : undefined;
  if (!identity) {
    throw new Error('The restored decision does not belong to this child conversation.');
  }
  return identity;
}
