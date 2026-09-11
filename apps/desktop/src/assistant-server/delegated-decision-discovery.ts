import {
  type DelegatedToolActionIdentity,
  type DelegatedToolDecisionState,
  getToolActionIdentityKey,
  isDelegatedToolDecisionState,
} from '@brainstrike/assistant-contract';
import type { DelegatedConversationDatabase } from '@brainstrike/db';
import { z } from 'zod';

interface DiscoveredDecision {
  readonly delegation?: DelegatedToolActionIdentity;
  readonly runId: string;
  readonly toolCallId: string;
}

const decisionRow = z.object({
  childRuntimeRunId: z.string().min(1),
  leafToolCallId: z.string().min(1),
  runId: z.string().min(1),
  state: z.custom<DelegatedToolDecisionState>(isDelegatedToolDecisionState),
  toolCallId: z.string().min(1),
});

/** Admission records annotate native discovery; they never fabricate a resumable pause. */
export async function readDelegatedDecisionStates(
  database: DelegatedConversationDatabase,
  scope: { readonly ownerResourceId: string; readonly rootThreadId: string },
  requests: readonly DiscoveredDecision[]
): Promise<ReadonlyMap<string, DelegatedToolDecisionState>> {
  const requested = new Map<
    string,
    { key: string; tuple: readonly [string, string, string, string] }
  >();
  for (const request of requests) {
    const leaf = request.delegation?.path.at(-1);
    if (!(leaf && request.delegation)) {
      continue;
    }
    const tuple = [
      request.runId,
      request.toolCallId,
      leaf.childRuntimeRunId,
      request.delegation.toolCallId,
    ] as const;
    requested.set(JSON.stringify(tuple), { key: getToolActionIdentityKey(request), tuple });
  }
  const states = new Map<string, DelegatedToolDecisionState>();
  if (requested.size === 0) {
    return states;
  }
  const result = await database.query(
    `SELECT decision.parent_runtime_run_id AS "runId", decision.parent_tool_call_id AS "toolCallId",
       decision.child_runtime_run_id AS "childRuntimeRunId", decision.tool_call_id AS "leafToolCallId", decision.state
     FROM brainstrike_delegated_tool_decisions AS decision
     JOIN jsonb_array_elements($3::jsonb) AS requested(target)
       ON decision.parent_runtime_run_id = requested.target->>0
       AND decision.parent_tool_call_id = requested.target->>1
       AND decision.child_runtime_run_id = requested.target->>2
       AND decision.tool_call_id = requested.target->>3
     WHERE decision.owner_resource_id = $1 AND decision.root_thread_id = $2
     UNION ALL
     SELECT requested.target->>0, requested.target->>1, requested.target->>2, requested.target->>3, 'cancelled'
     FROM jsonb_array_elements($3::jsonb) AS requested(target)
     JOIN brainstrike_delegated_invocations invocation
       ON invocation.parent_runtime_run_id = requested.target->>0
       AND invocation.parent_tool_call_id = requested.target->>1
       AND invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
     WHERE EXISTS (
       SELECT 1 FROM brainstrike_assistant_thread_runs cancelled
       WHERE cancelled.resource_id = $1 AND cancelled.thread_id = $2
         AND cancelled.turn_message_id = invocation.turn_message_id AND cancelled.status IN ('cancelling', 'cancelled')
     ) AND NOT EXISTS (
       SELECT 1 FROM brainstrike_delegated_tool_decisions decision
       WHERE decision.owner_resource_id = $1 AND decision.root_thread_id = $2
         AND decision.parent_runtime_run_id = requested.target->>0 AND decision.parent_tool_call_id = requested.target->>1
         AND decision.child_runtime_run_id = requested.target->>2 AND decision.tool_call_id = requested.target->>3
     )`,
    [
      scope.ownerResourceId,
      scope.rootThreadId,
      JSON.stringify([...requested.values()].map(({ tuple }) => tuple)),
    ]
  );
  for (const row of z.array(decisionRow).parse(result.rows)) {
    const key = requested.get(
      JSON.stringify([row.runId, row.toolCallId, row.childRuntimeRunId, row.leafToolCallId])
    )?.key;
    if (key !== undefined) {
      states.set(key, row.state);
    }
  }
  return states;
}
