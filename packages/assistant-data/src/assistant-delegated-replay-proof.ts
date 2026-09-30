import {
  type DelegatedToolActionIdentity,
  hasValidDelegatedToolActionTarget,
} from '@brainstrike/assistant-contract';
import {
  createDelegatedConversationRepository,
  readAssistantHistoryRunEvents,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';

export interface DelegatedReplayProofInput {
  readonly delegation: DelegatedToolActionIdentity;
  readonly hostRunId: string;
  readonly nativeRunId: string;
  readonly pauseKind: 'approval' | 'suspend';
  readonly resourceId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

/** Replay preparation only; public native snapshots and durable claims still admit execution. */
export async function hasPendingDelegatedReplayCall(
  database: DbHandle,
  input: DelegatedReplayProofInput
): Promise<boolean> {
  if (
    !hasValidDelegatedToolActionTarget({
      delegation: input.delegation,
      runId: input.nativeRunId,
      toolCallId: input.toolCallId,
    })
  ) {
    return false;
  }
  const scope = { ownerResourceId: input.resourceId, rootThreadId: input.threadId };
  const graph = createDelegatedConversationRepository(database);
  let parentThreadId = input.threadId;
  let leafThreadId: string | undefined;
  let leafResourceId: string | undefined;
  for (const edge of input.delegation.path) {
    const invocation = await graph.getInvocation(scope, edge);
    if (
      !invocation ||
      invocation.childRuntimeRunId !== edge.childRuntimeRunId ||
      invocation.personaId !== edge.personaId ||
      invocation.parentThreadId !== parentThreadId
    ) {
      return false;
    }
    const ownership = await database.query<{ owned: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM brainstrike_assistant_thread_runs host
         JOIN brainstrike_assistant_thread_runs original ON original.id = $4
         WHERE host.id = $1 AND host.resource_id = $2 AND host.thread_id = $3
           AND host.turn_message_id = $5 AND original.turn_message_id = $5
           AND original.resource_id = host.resource_id AND original.thread_id = host.thread_id
           AND NOT EXISTS (SELECT 1 FROM brainstrike_delegated_invocations stopped
             WHERE stopped.owner_resource_id = $2 AND stopped.root_thread_id = $3
               AND stopped.turn_message_id = $5 AND stopped.thread_id = $6
               AND stopped.cancellation_requested_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs cancelled
             WHERE cancelled.resource_id = $2 AND cancelled.thread_id = $3
               AND cancelled.turn_message_id = $5 AND cancelled.status IN ('cancelling', 'cancelled'))
           AND (original.id = host.id OR (host.generation_run_id IS NOT NULL
             AND original.generation_run_id = host.generation_run_id))
       ) AS owned`,
      [
        input.hostRunId,
        input.resourceId,
        input.threadId,
        invocation.hostRunId,
        invocation.turnMessageId,
        invocation.threadId,
      ]
    );
    if (ownership.rows[0]?.owned !== true) {
      return false;
    }
    const child = await graph.get(scope, invocation.threadId);
    if (!child || child.parentThreadId !== parentThreadId) {
      return false;
    }
    leafThreadId = child.threadId;
    leafResourceId = child.resourceId;
    parentThreadId = child.threadId;
  }
  const leaf = input.delegation.path.at(-1);
  if (!(leaf && leafThreadId && leafResourceId)) {
    return false;
  }
  const [events, decisions] = await Promise.all([
    readAssistantHistoryRunEvents(database, leafThreadId, leafResourceId),
    database.query<{ consumed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM brainstrike_delegated_tool_decisions
       WHERE owner_resource_id = $1 AND root_thread_id = $2 AND child_thread_id = $3
         AND child_runtime_run_id = $4 AND tool_call_id = $5) AS consumed`,
      [
        input.resourceId,
        input.threadId,
        leafThreadId,
        leaf.childRuntimeRunId,
        input.delegation.toolCallId,
      ]
    ),
  ]);
  if (decisions.rows[0]?.consumed !== false) {
    return false;
  }
  const nativeEvents = events.filter(
    (event) => event.metadata?.['childRuntimeRunId'] === leaf.childRuntimeRunId
  );
  if (
    nativeEvents.some(
      (event) =>
        event.metadata?.['parentRuntimeRunId'] !== leaf.parentRuntimeRunId ||
        event.metadata?.['parentToolCallId'] !== leaf.parentToolCallId ||
        event.metadata?.['personaId'] !== leaf.personaId ||
        event.kind === 'run.finished' ||
        event.kind === 'run.failed' ||
        event.kind === 'run.cancelled' ||
        (event.metadata?.['toolCallId'] === input.delegation.toolCallId &&
          (event.kind === 'tool.completed' || event.kind === 'tool.failed'))
    )
  ) {
    return false;
  }
  const pauseKind = input.pauseKind === 'approval' ? 'tool.approval.requested' : 'tool.started';
  return (
    nativeEvents.filter(
      (event) =>
        event.kind === pauseKind && event.metadata?.['toolCallId'] === input.delegation.toolCallId
    ).length === 1
  );
}
