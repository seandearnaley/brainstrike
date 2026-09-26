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

async function assertNoActiveAgentWork(
  tx: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  descendants: readonly DelegatedConversationNode[]
): Promise<void> {
  const addresses = JSON.stringify(
    descendants.map((node) => ({ resourceId: node.resourceId, threadId: node.threadId }))
  );
  const active = await tx.query(
    `WITH addresses AS (
       SELECT $1::text AS thread_id, $2::text AS resource_id
       UNION ALL
       SELECT node."threadId", node."resourceId"
       FROM jsonb_to_recordset($3::jsonb) AS node("threadId" text, "resourceId" text)
     )
     SELECT 1 FROM brainstrike_assistant_thread_runs run
     JOIN addresses address ON address.thread_id = run.thread_id
       AND address.resource_id = run.resource_id
     WHERE run.status IN ('running', 'cancelling', 'awaiting-approval', 'awaiting-input')
     UNION ALL
     SELECT 1 FROM brainstrike_delegated_continuations continuation
     JOIN addresses address ON address.thread_id = continuation.thread_id
     WHERE continuation.root_thread_id = $1 AND continuation.owner_resource_id = $2
       AND continuation.state IN ('claimed', 'running', 'awaiting-approval', 'awaiting-input')
     LIMIT 1`,
    [scope.rootThreadId, scope.ownerResourceId, addresses]
  );
  if (active.rows.length > 0) {
    throw new DelegatedConversationIdentityError(
      'agent-colors-active-run',
      'Finish or stop the active agent run before refreshing saved colors.'
    );
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
    const repository = createDelegatedConversationRepository(tx);
    const descendants = await repository.listDescendants(scope);
    await assertNoActiveAgentWork(tx, scope, descendants);
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
