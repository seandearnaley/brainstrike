import {
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationNode,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { type AgentColor, createAgentFamilyColor } from '@brainstrike/types/agent-color';
import { readRootColor } from './delegated-family-color';

function allocateColors(
  descendants: readonly DelegatedConversationNode[],
  rootThreadId: string,
  rootColor: AgentColor
): Map<string, AgentColor> {
  const pending = new Map(descendants.map((node) => [node.threadId, node]));
  const occupied: AgentColor[] = [rootColor];
  const nextColors = new Map<string, AgentColor>([[rootThreadId, rootColor]]);
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((node) => node.parentThreadId && nextColors.has(node.parentThreadId))
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.threadId.localeCompare(right.threadId)
      );
    if (ready.length === 0) {
      throw new DelegatedConversationIdentityError('descendant-ancestry-mismatch');
    }
    for (const node of ready) {
      const parentColor = nextColors.get(node.parentThreadId ?? '');
      if (!parentColor) {
        throw new DelegatedConversationIdentityError('parent-display-identity-missing');
      }
      const siblingColors = descendants
        .filter((sibling) => sibling.parentThreadId === node.parentThreadId)
        .flatMap((sibling) => {
          const assigned = nextColors.get(sibling.threadId);
          return assigned ? [assigned] : [];
        });
      const next = createAgentFamilyColor(parentColor, node.threadId, siblingColors, occupied);
      nextColors.set(node.threadId, next);
      occupied.push(next);
      pending.delete(node.threadId);
    }
  }
  return nextColors;
}

async function updateColor(
  tx: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  node: DelegatedConversationNode,
  color: AgentColor
): Promise<void> {
  const result = await tx.query(
    `UPDATE brainstrike_delegated_conversations
     SET color = $4
     WHERE thread_id = $3 AND root_thread_id = $1 AND owner_resource_id = $2
       AND parent_thread_id = $5 AND resource_id = $6
     RETURNING thread_id`,
    [
      scope.rootThreadId,
      scope.ownerResourceId,
      node.threadId,
      color,
      node.parentThreadId,
      node.resourceId,
    ]
  );
  if (result.rows.length !== 1) {
    throw new DelegatedConversationIdentityError('descendant-color-update-conflict');
  }
}

/** Reassign only saved colors; native identities, names, runs, and permissions stay intact. */
export async function refreshDelegatedFamilyColors(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope
): Promise<number> {
  if (!database.transaction) {
    throw new Error('Refreshing agent colors requires a database transaction.');
  }
  return await database.transaction(async (tx) => {
    const color = await readRootColor(tx, scope);
    const active = await tx.query(
      `SELECT 1 FROM brainstrike_assistant_thread_runs
       WHERE thread_id = $1 AND resource_id = $2
         AND status IN ('running', 'cancelling', 'awaiting-approval', 'awaiting-input')
       LIMIT 1`,
      [scope.rootThreadId, scope.ownerResourceId]
    );
    if (active.rows.length > 0) {
      throw new DelegatedConversationIdentityError(
        'agent-colors-active-run',
        'Finish or stop the active agent run before refreshing saved colors.'
      );
    }
    const repository = createDelegatedConversationRepository(tx);
    const descendants = await repository.listDescendants(scope);
    if (descendants.length === 0) {
      return 0;
    }
    const root = await repository.get(scope, scope.rootThreadId);
    if (!root || root.parentThreadId !== null) {
      throw new DelegatedConversationIdentityError('root-graph-mismatch');
    }
    const nextColors = allocateColors(descendants, scope.rootThreadId, color);
    let changed = 0;
    for (const node of descendants) {
      const next = nextColors.get(node.threadId);
      if (!next) {
        throw new DelegatedConversationIdentityError('descendant-color-missing');
      }
      if (node.color === next) {
        continue;
      }
      await updateColor(tx, scope, node, next);
      changed += 1;
    }
    return changed;
  });
}
