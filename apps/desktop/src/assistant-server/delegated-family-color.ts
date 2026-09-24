import {
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationNode,
  type DelegatedConversationRepository,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import {
  type AgentColor,
  createAgentFamilyColor,
  isAgentColor,
} from '@brainstrike/types/agent-color';
import { createDelegatedDisplayIdentity } from './delegated-display-identity';

async function readRootColor(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope
): Promise<AgentColor> {
  const result = await database.query(
    'SELECT metadata FROM mastra_threads WHERE id = $1 AND "resourceId" = $2',
    [scope.rootThreadId, scope.ownerResourceId]
  );
  if (result.rows.length !== 1) {
    throw new DelegatedConversationIdentityError('root-scope-mismatch');
  }
  const metadata = (result.rows[0] as Record<string, unknown>)['metadata'];
  if (metadata === null || metadata === undefined) {
    return 'blue';
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DelegatedConversationIdentityError('root-display-metadata-invalid');
  }
  const color = (metadata as Record<string, unknown>)['color'];
  if (color === undefined || color === null) {
    return 'blue';
  }
  if (!isAgentColor(color)) {
    throw new DelegatedConversationIdentityError('root-display-color-invalid');
  }
  return color;
}

/** Reuse saved display identity before consulting root metadata or siblings. */
export async function resolveDelegatedFamilyIdentity(
  database: DelegatedConversationDatabase,
  repository: DelegatedConversationRepository,
  scope: DelegatedConversationScope,
  parent: DelegatedConversationNode,
  childThreadId: string
): Promise<ReturnType<typeof createDelegatedDisplayIdentity>> {
  const existing = await repository.get(scope, childThreadId);
  if (existing) {
    if (!(existing.color && existing.displayName)) {
      throw new DelegatedConversationIdentityError('child-display-identity-missing');
    }
    return { color: existing.color, displayName: existing.displayName };
  }
  const parentColor =
    parent.parentThreadId === null ? await readRootColor(database, scope) : parent.color;
  if (!parentColor) {
    throw new DelegatedConversationIdentityError('parent-display-identity-missing');
  }
  const descendants = await repository.listDescendants(scope);
  const occupiedColors = descendants.map((descendant) => {
    if (!descendant.color) {
      throw new DelegatedConversationIdentityError('descendant-display-identity-missing');
    }
    return descendant.color;
  });
  const siblingColors = descendants
    .filter((descendant) => descendant.parentThreadId === parent.threadId)
    .map((sibling) => {
      if (!sibling.color) {
        throw new DelegatedConversationIdentityError('sibling-display-identity-missing');
      }
      return sibling.color;
    });
  return {
    ...createDelegatedDisplayIdentity(childThreadId),
    color: createAgentFamilyColor(parentColor, childThreadId, siblingColors, occupiedColors),
  };
}
