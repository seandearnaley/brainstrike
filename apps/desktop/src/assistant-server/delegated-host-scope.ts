import {
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { z } from 'zod';

const identityString = z.string().refine((value) => value.trim().length > 0);
const hostScopeSchema = z.object({
  ownerResourceId: identityString,
  rootThreadId: identityString,
  turnMessageId: identityString,
});

export type DelegatedHostScope = DelegatedConversationScope & { turnMessageId: string };

/**
 * A host leg's root scope, from its own run row. A host leg runs on the ROOT
 * thread (a follow-up to an idle child is a fresh managed root leg), so a run
 * row on this owner's delegated child thread is refused rather than read as a
 * root. `undefined` only while the leg has no run row or no turn anchor (a
 * thread with no user message); every other identity failure throws. The root
 * thread row cannot be missing under an existing run row (`thread_id`
 * REFERENCES `mastra_threads` ON DELETE CASCADE), so `rootOwned` false means
 * the thread belongs to another resource.
 */
export async function resolveDelegatedHostScope(
  database: DelegatedConversationDatabase,
  hostRunId: string
): Promise<DelegatedHostScope | undefined> {
  const result = await database.query(
    `SELECT runs.resource_id AS "ownerResourceId", runs.thread_id AS "rootThreadId",
      runs.turn_message_id AS "turnMessageId", root.id IS NOT NULL AS "rootOwned",
      EXISTS (SELECT 1 FROM brainstrike_delegated_conversations child
        WHERE child.thread_id = runs.thread_id AND child.resource_id = runs.resource_id
          AND child.parent_thread_id IS NOT NULL) AS "childThread"
     FROM brainstrike_assistant_thread_runs runs
     LEFT JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
     WHERE runs.id = $1`,
    [hostRunId]
  );
  const row = result.rows[0] as
    | { childThread?: unknown; rootOwned?: unknown; turnMessageId?: unknown }
    | undefined;
  if (row === undefined) {
    return;
  }
  if (row.childThread === true) {
    throw new DelegatedConversationIdentityError('host-leg-on-child-thread');
  }
  if (row.rootOwned !== true) {
    throw new DelegatedConversationIdentityError('host-scope-invalid');
  }
  if (row.turnMessageId === null) {
    return;
  }
  const parsed = hostScopeSchema.safeParse(row);
  if (!parsed.success) {
    throw new DelegatedConversationIdentityError('host-scope-invalid');
  }
  return parsed.data;
}
