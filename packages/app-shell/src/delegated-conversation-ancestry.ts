import type { DelegatedConversationNode, DelegatedConversationRepository } from '@brainstrike/db';
import type { ChildNode } from './delegated-workspace-node';

/** Walk native parent bindings; never derive ancestry from a persona or tab label. */
export async function loadDelegatedConversationAncestry(
  repository: Pick<DelegatedConversationRepository, 'get'>,
  selected: DelegatedConversationNode
): Promise<{ readonly root: DelegatedConversationNode; readonly children: readonly ChildNode[] }> {
  const scope = { ownerResourceId: selected.ownerResourceId, rootThreadId: selected.rootThreadId };
  const visited = new Set<string>();
  const path: ChildNode[] = [];
  let node: DelegatedConversationNode | null = selected;
  let expectedId = selected.threadId;
  while (node) {
    if (
      node.threadId !== expectedId ||
      node.ownerResourceId !== scope.ownerResourceId ||
      node.rootThreadId !== scope.rootThreadId ||
      visited.has(node.threadId)
    ) {
      throw new Error('Conversation ancestry conflicts with its owning root.');
    }
    visited.add(node.threadId);
    if (node.threadId === scope.rootThreadId) {
      if (node.parentThreadId !== null || node.resourceId !== scope.ownerResourceId) {
        throw new Error('Conversation ancestry has an invalid root boundary.');
      }
      return { children: path.reverse(), root: node };
    }
    if (!(node.parentThreadId && node.displayName && node.color)) {
      throw new Error('Conversation ancestry has a missing parent.');
    }
    path.push({ ...node, color: node.color, displayName: node.displayName });
    expectedId = node.parentThreadId;
    // Each lookup depends on the preceding native parent identity.
    node = await repository.get(scope, expectedId);
  }
  throw new Error('Conversation ancestry is no longer available.');
}
