import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';
import type { DelegatedWorkspaceTab } from './delegated-workspace-tab';

export type ChildNode = DelegatedConversationNode & {
  readonly displayName: string;
  readonly color: NonNullable<DelegatedConversationNode['color']>;
};

export async function loadDelegatedWorkspaceNode(
  repository: Pick<DelegatedConversationRepository, 'get'>,
  address: DelegatedWorkspaceTab
): Promise<ChildNode> {
  const node = await repository.get(address, address.threadId);
  if (
    !(
      node &&
      node.threadId === address.threadId &&
      node.rootThreadId === address.rootThreadId &&
      node.ownerResourceId === address.ownerResourceId &&
      node.threadId !== node.rootThreadId &&
      node.parentThreadId &&
      node.displayName &&
      node.color
    )
  ) {
    throw new Error('The child conversation is missing or does not belong to this workspace.');
  }
  return { ...node, color: node.color, displayName: node.displayName };
}
