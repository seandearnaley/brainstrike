import {
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { z } from 'zod';

const targetSchema = z.object({
  childRuntimeRunId: z.string().nullable(),
  parentRuntimeRunId: z.string().min(1),
  parentToolCallId: z.string().min(1),
  threadId: z.string().min(1),
});

/** Admission barrier only. The caller must join native owners before acknowledging Stop. */
export async function revokeDelegatedConversationAdmission(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  threadId: string,
  includeDescendants: boolean
): Promise<readonly z.infer<typeof targetSchema>[]> {
  const node = await createDelegatedConversationRepository(database).get(scope, threadId);
  if (!node?.parentThreadId) {
    throw new DelegatedConversationIdentityError('cancellation-child-scope-invalid');
  }
  const result = await database.query(
    `WITH RECURSIVE selected AS (
       SELECT child.thread_id FROM brainstrike_delegated_conversations child
       JOIN mastra_threads root ON root.id = child.root_thread_id AND root."resourceId" = child.owner_resource_id
       WHERE child.owner_resource_id = $1 AND child.root_thread_id = $2 AND child.thread_id = $3
         AND child.parent_thread_id IS NOT NULL
       UNION
       SELECT child.thread_id FROM brainstrike_delegated_conversations child
       JOIN selected parent ON parent.thread_id = child.parent_thread_id
       WHERE child.owner_resource_id = $1 AND child.root_thread_id = $2 AND $4 = 1
     ) UPDATE brainstrike_delegated_invocations invocation
       SET cancellation_requested_at = COALESCE(invocation.cancellation_requested_at, NOW())
       FROM selected WHERE invocation.thread_id = selected.thread_id
         AND invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
       RETURNING invocation.thread_id AS "threadId", invocation.parent_runtime_run_id AS "parentRuntimeRunId",
         invocation.parent_tool_call_id AS "parentToolCallId", invocation.child_runtime_run_id AS "childRuntimeRunId"`,
    [scope.ownerResourceId, scope.rootThreadId, threadId, includeDescendants ? 1 : 0]
  );
  const targets = z.array(targetSchema).parse(result.rows);
  if (targets.length === 0) {
    throw new DelegatedConversationIdentityError('cancellation-invocation-unavailable');
  }
  return targets;
}

/** Call inside the transaction that admits a model step or another invocation. */
export async function assertDelegatedConversationAdmission(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope & { readonly turnMessageId: string },
  threadIds: readonly string[]
): Promise<void> {
  const stopped = await database.query(
    `WITH RECURSIVE ancestors AS (
       SELECT node.thread_id, node.parent_thread_id FROM brainstrike_delegated_conversations node
       JOIN jsonb_array_elements_text($4::jsonb) target(thread_id) ON target.thread_id = node.thread_id
       WHERE node.owner_resource_id = $1 AND node.root_thread_id = $2
       UNION
       SELECT node.thread_id, node.parent_thread_id FROM brainstrike_delegated_conversations node
       JOIN ancestors child ON child.parent_thread_id = node.thread_id
       WHERE node.owner_resource_id = $1 AND node.root_thread_id = $2
     ) SELECT 1 FROM brainstrike_delegated_invocations invocation
       JOIN ancestors ON ancestors.thread_id = invocation.thread_id
       WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
         AND invocation.turn_message_id = $3 AND invocation.cancellation_requested_at IS NOT NULL LIMIT 1`,
    [scope.ownerResourceId, scope.rootThreadId, scope.turnMessageId, JSON.stringify(threadIds)]
  );
  if (stopped.rows.length > 0) {
    throw new DelegatedConversationIdentityError('delegated-conversation-cancelled');
  }
}

/** Finalize existing host projections only after all selected native owners have joined. */
export async function completeDelegatedConversationCancellation(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  targets: readonly z.infer<typeof targetSchema>[]
): Promise<void> {
  await database.query(
    `WITH selected AS (
       SELECT invocation.*, child.resource_id
       FROM jsonb_to_recordset($3::jsonb) AS target("parentRuntimeRunId" text, "parentToolCallId" text)
       JOIN brainstrike_delegated_invocations invocation
         ON invocation.parent_runtime_run_id = target."parentRuntimeRunId"
         AND invocation.parent_tool_call_id = target."parentToolCallId"
       JOIN brainstrike_delegated_conversations child ON child.thread_id = invocation.thread_id
         AND child.owner_resource_id = invocation.owner_resource_id AND child.root_thread_id = invocation.root_thread_id
       JOIN mastra_threads root ON root.id = child.root_thread_id AND root."resourceId" = child.owner_resource_id
       WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
         AND invocation.cancellation_requested_at IS NOT NULL
     ), pending AS (
       SELECT DISTINCT run.id, run.resource_id, run.thread_id, identity.metadata
       FROM selected
       JOIN brainstrike_assistant_thread_runs run ON run.thread_id = selected.thread_id AND run.resource_id = selected.resource_id
       JOIN LATERAL (
         SELECT event.metadata FROM brainstrike_assistant_run_events event
         WHERE event.run_id = run.id
           AND event.metadata->>'parentRuntimeRunId' = selected.parent_runtime_run_id
           AND event.metadata->>'parentToolCallId' = selected.parent_tool_call_id
           AND event.metadata->>'childRuntimeRunId' = selected.child_runtime_run_id
         ORDER BY event.sequence DESC LIMIT 1
       ) identity ON true
       WHERE run.status IN ('running', 'cancelling')
     ), settled AS (
       UPDATE brainstrike_assistant_thread_runs run
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
       FROM pending WHERE run.id = pending.id
       RETURNING run.id, run.resource_id, run.thread_id, run.completed_at
     ) INSERT INTO brainstrike_assistant_run_events
       (id, run_id, resource_id, thread_id, sequence, kind, status, label, metadata, occurred_at, created_at, updated_at)
       SELECT settled.id || ':selected-cancelled', settled.id, settled.resource_id, settled.thread_id,
         (SELECT COALESCE(MAX(event.sequence), -1) + 1 FROM brainstrike_assistant_run_events event WHERE event.run_id = settled.id),
         'run.cancelled', 'cancelled', 'Stopped', pending.metadata, settled.completed_at, NOW(), NOW()
       FROM settled JOIN pending ON pending.id = settled.id`,
    [scope.ownerResourceId, scope.rootThreadId, JSON.stringify(targets)]
  );
}
