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
  const requested = new Map<string, string>();
  const childRunIds = new Set<string>();
  for (const request of requests) {
    const leaf = request.delegation?.path.at(-1);
    if (!(leaf && request.delegation)) {
      continue;
    }
    requested.set(
      JSON.stringify([
        request.runId,
        request.toolCallId,
        leaf.childRuntimeRunId,
        request.delegation.toolCallId,
      ]),
      getToolActionIdentityKey(request)
    );
    childRunIds.add(leaf.childRuntimeRunId);
  }
  const states = new Map<string, DelegatedToolDecisionState>();
  if (requested.size === 0) {
    return states;
  }
  const result = await database.query(
    `SELECT parent_runtime_run_id AS "runId", parent_tool_call_id AS "toolCallId",
       child_runtime_run_id AS "childRuntimeRunId", tool_call_id AS "leafToolCallId", state
     FROM brainstrike_delegated_tool_decisions
     WHERE owner_resource_id = $1 AND root_thread_id = $2
       AND child_runtime_run_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [scope.ownerResourceId, scope.rootThreadId, JSON.stringify([...childRunIds])]
  );
  for (const row of z.array(decisionRow).parse(result.rows)) {
    const key = requested.get(
      JSON.stringify([row.runId, row.toolCallId, row.childRuntimeRunId, row.leafToolCallId])
    );
    if (key !== undefined) {
      states.set(key, row.state);
    }
  }
  return states;
}
