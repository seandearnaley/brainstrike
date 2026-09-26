import type { DelegatedConversationDatabase } from '@brainstrike/db';

/** A parent terminal is durable while the child task has already ended, but
 * native startup failures can leave every child host leg without a run terminal.
 * Settle only the matching invocation's still-running rows. The task's own
 * terminal state supplies the verdict; a parent failure alone is insufficient. */
export async function settleFailedDelegationChildRuns(
  database: DelegatedConversationDatabase,
  hostRunId: string,
  eventId: string,
  eventHostRunId = hostRunId
): Promise<void> {
  await database.query(
    `WITH RECURSIVE reported AS (
       SELECT event.metadata, event.status, root.thread_id AS root_thread_id,
         root.resource_id AS owner_resource_id, root.turn_message_id,
         parent_host.thread_id AS parent_thread_id, parent_host.resource_id AS parent_resource_id
       FROM brainstrike_assistant_run_events event
       JOIN brainstrike_assistant_thread_runs root ON root.id = $1
       JOIN brainstrike_assistant_thread_runs parent_host ON parent_host.id = event.run_id
         AND parent_host.thread_id = event.thread_id AND parent_host.resource_id = event.resource_id
       JOIN brainstrike_delegated_conversations parent_node
         ON parent_node.thread_id = parent_host.thread_id AND parent_node.resource_id = parent_host.resource_id
         AND parent_node.root_thread_id = root.thread_id AND parent_node.owner_resource_id = root.resource_id
       WHERE event.id = $2 AND event.run_id = $3 AND event.kind = 'subagent.failed'
         AND event.status IN ('failed', 'cancelled')
     ), owned_nodes AS (
       SELECT node.* FROM brainstrike_delegated_conversations node
       JOIN reported root ON root.root_thread_id = node.thread_id
         AND root.owner_resource_id = node.owner_resource_id
       JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
       WHERE node.parent_thread_id IS NULL AND node.root_thread_id = node.thread_id
       UNION ALL
       SELECT child.* FROM brainstrike_delegated_conversations child
       JOIN owned_nodes parent ON child.parent_thread_id = parent.thread_id
         AND child.root_thread_id = parent.root_thread_id AND child.owner_resource_id = parent.owner_resource_id
       JOIN mastra_threads native ON native.id = child.thread_id AND native."resourceId" = child.resource_id
     ), matched AS (
       SELECT DISTINCT run.id, identity.metadata, reported.status,
         NULLIF(btrim(task.error->>'message'), '') AS error
       FROM reported
       JOIN brainstrike_delegated_invocations invocation
         ON invocation.root_thread_id = reported.root_thread_id
         AND invocation.owner_resource_id = reported.owner_resource_id
         AND invocation.turn_message_id = reported.turn_message_id
         AND invocation.parent_runtime_run_id = reported.metadata->>'parentRuntimeRunId'
         AND (reported.metadata->>'continuationNativeRunId' IS NULL
           OR invocation.parent_runtime_run_id = reported.metadata->>'continuationNativeRunId')
         AND invocation.parent_tool_call_id = reported.metadata->>'parentToolCallId'
         AND invocation.persona_id = reported.metadata->>'personaId'
       JOIN owned_nodes child ON child.thread_id = invocation.thread_id
       JOIN owned_nodes parent ON parent.thread_id = child.parent_thread_id
         AND parent.thread_id = reported.parent_thread_id AND parent.resource_id = reported.parent_resource_id
       JOIN mastra_background_tasks task ON task.run_id = invocation.parent_runtime_run_id
         AND task.tool_call_id = invocation.parent_tool_call_id
         AND task.thread_id = parent.thread_id AND task.resource_id = parent.resource_id
         AND ((reported.status = 'failed' AND task.status IN ('failed', 'timed_out'))
           OR (reported.status = 'cancelled' AND task.status = 'cancelled'))
       JOIN brainstrike_assistant_thread_runs run ON run.thread_id = child.thread_id
         AND run.resource_id = child.resource_id AND run.status = 'running'
       JOIN LATERAL (
         SELECT event.metadata FROM brainstrike_assistant_run_events event
         WHERE event.run_id = run.id AND event.thread_id = child.thread_id AND event.resource_id = child.resource_id
           AND event.metadata->>'parentRuntimeRunId' = invocation.parent_runtime_run_id
           AND event.metadata->>'parentToolCallId' = invocation.parent_tool_call_id
           AND event.metadata->>'childRuntimeRunId' = invocation.child_runtime_run_id
           AND event.metadata->>'personaId' = invocation.persona_id
         ORDER BY event.sequence DESC LIMIT 1
       ) identity ON true
     ), settled AS (
       UPDATE brainstrike_assistant_thread_runs run
       SET status = matched.status,
         error = CASE WHEN matched.status = 'failed' THEN matched.error ELSE run.error END,
         completed_at = NOW(), updated_at = NOW()
       FROM matched WHERE run.id = matched.id AND run.status = 'running'
       RETURNING run.id, run.resource_id, run.thread_id, run.completed_at,
         run.error, matched.metadata, matched.status
     ) INSERT INTO brainstrike_assistant_run_events
       (id, run_id, resource_id, thread_id, sequence, kind, status, label, detail, metadata, occurred_at, created_at, updated_at)
       SELECT settled.id || ':background-task-terminal', settled.id, settled.resource_id, settled.thread_id,
         (SELECT COALESCE(MAX(event.sequence), -1) + 1 FROM brainstrike_assistant_run_events event WHERE event.run_id = settled.id),
         CASE WHEN settled.status = 'cancelled' THEN 'run.cancelled' ELSE 'run.failed' END,
         settled.status,
         CASE WHEN settled.status = 'cancelled' THEN 'Background child cancelled' ELSE 'Background child failed' END,
         COALESCE(settled.error, 'Native background task ended before its child stream emitted a terminal event.'),
         settled.metadata, settled.completed_at, NOW(), NOW()
       FROM settled`,
    [hostRunId, eventId, eventHostRunId]
  );
}

/** The stream has joined native cleanup before the host records its failure.
 * Project only cancellations that actually reached the native task store. */
export async function completeFailedRootRun(
  database: DelegatedConversationDatabase,
  runId: string,
  error: string | null
): Promise<void> {
  await database.query(
    `WITH RECURSIVE failed_host AS (
       UPDATE brainstrike_assistant_thread_runs
       SET status = 'failed', error = $2, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('cancelling', 'cancelled')
       RETURNING *
     ), owned_nodes AS (
       SELECT node.* FROM brainstrike_delegated_conversations node
       JOIN failed_host host ON host.thread_id = node.thread_id
         AND host.resource_id = node.owner_resource_id
       JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
       WHERE node.parent_thread_id IS NULL AND node.root_thread_id = node.thread_id
       UNION ALL
       SELECT child.* FROM brainstrike_delegated_conversations child
       JOIN owned_nodes parent ON child.parent_thread_id = parent.thread_id
         AND child.root_thread_id = parent.root_thread_id AND child.owner_resource_id = parent.owner_resource_id
       JOIN mastra_threads native ON native.id = child.thread_id AND native."resourceId" = child.resource_id
     ), cancelled AS (
       SELECT invocation.* FROM brainstrike_delegated_invocations invocation
       JOIN failed_host host ON host.thread_id = invocation.root_thread_id
         AND host.resource_id = invocation.owner_resource_id AND host.turn_message_id = invocation.turn_message_id
       JOIN owned_nodes child ON child.thread_id = invocation.thread_id
       JOIN owned_nodes parent ON parent.thread_id = child.parent_thread_id
       JOIN mastra_background_tasks task ON task.run_id = invocation.parent_runtime_run_id
         AND task.tool_call_id = invocation.parent_tool_call_id
         AND task.thread_id = parent.thread_id AND task.resource_id = parent.resource_id
       WHERE task.status = 'cancelled'
       UNION
       SELECT invocation.* FROM brainstrike_delegated_invocations invocation
       JOIN cancelled parent ON invocation.parent_runtime_run_id = parent.child_runtime_run_id
         AND invocation.root_thread_id = parent.root_thread_id AND invocation.owner_resource_id = parent.owner_resource_id
         AND invocation.turn_message_id = parent.turn_message_id
       JOIN owned_nodes child ON child.thread_id = invocation.thread_id AND child.parent_thread_id = parent.thread_id
       JOIN owned_nodes parent_node ON parent_node.thread_id = parent.thread_id
       WHERE NOT EXISTS (
         SELECT 1 FROM mastra_background_tasks task
         WHERE task.run_id = invocation.parent_runtime_run_id AND task.tool_call_id = invocation.parent_tool_call_id
           AND task.thread_id = parent_node.thread_id AND task.resource_id = parent_node.resource_id
           AND task.status <> 'cancelled'
       )
     ), pending AS (
       SELECT DISTINCT run.id, identity.metadata FROM cancelled
       JOIN owned_nodes child ON child.thread_id = cancelled.thread_id
       JOIN brainstrike_assistant_thread_runs run ON run.thread_id = child.thread_id AND run.resource_id = child.resource_id
       JOIN LATERAL (
         SELECT event.metadata FROM brainstrike_assistant_run_events event
         WHERE event.run_id = run.id AND event.thread_id = child.thread_id AND event.resource_id = child.resource_id
           AND event.metadata->>'parentRuntimeRunId' = cancelled.parent_runtime_run_id
           AND event.metadata->>'parentToolCallId' = cancelled.parent_tool_call_id
           AND event.metadata->>'childRuntimeRunId' = cancelled.child_runtime_run_id
           AND event.metadata->>'personaId' = cancelled.persona_id
         ORDER BY event.sequence DESC LIMIT 1
       ) identity ON true
       WHERE run.status IN ('running', 'cancelling')
     ), settled AS (
       UPDATE brainstrike_assistant_thread_runs run
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
       FROM pending WHERE run.id = pending.id AND run.status IN ('running', 'cancelling')
       RETURNING run.id, run.resource_id, run.thread_id, run.completed_at
     ) INSERT INTO brainstrike_assistant_run_events
       (id, run_id, resource_id, thread_id, sequence, kind, status, label, detail, metadata, occurred_at, created_at, updated_at)
       SELECT settled.id || ':root-stream-failed', settled.id, settled.resource_id, settled.thread_id,
         (SELECT COALESCE(MAX(event.sequence), -1) + 1 FROM brainstrike_assistant_run_events event WHERE event.run_id = settled.id),
         'run.cancelled', 'cancelled', 'Cancelled after root stream failure',
         'Native execution stopped while the root stream was closing after a failure.',
         pending.metadata, settled.completed_at, NOW(), NOW()
       FROM settled JOIN pending ON pending.id = settled.id`,
    [runId, error]
  );
}
