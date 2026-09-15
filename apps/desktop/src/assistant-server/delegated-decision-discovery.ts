import {
  type DelegatedToolActionIdentity,
  type DelegatedToolDecisionState,
  getToolActionIdentityKey,
  isDelegatedToolDecisionState,
} from '@brainstrike/assistant-contract';
import {
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
} from '@brainstrike/db';
import { z } from 'zod';

interface DiscoveredDecision {
  readonly continuationId?: string;
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
    { key: string; tuple: readonly [string, string, string, string]; path: readonly string[] }
  >();
  for (const request of requests) {
    if (request.continuationId) {
      continue;
    }
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
    requested.set(JSON.stringify(tuple), {
      key: getToolActionIdentityKey(request),
      path: request.delegation.path.map((edge) => edge.childRuntimeRunId),
      tuple,
    });
  }
  const states = await readContinuationDecisionStates(database, scope, requests);
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
     WHERE (EXISTS (
       SELECT 1 FROM brainstrike_delegated_invocations stopped
       JOIN jsonb_array_elements_text(requested.target->4) target(run_id)
         ON target.run_id = stopped.child_runtime_run_id
       WHERE stopped.owner_resource_id = $1 AND stopped.root_thread_id = $2
         AND stopped.turn_message_id = invocation.turn_message_id
         AND stopped.cancellation_requested_at IS NOT NULL
     ) OR EXISTS (
       SELECT 1 FROM brainstrike_assistant_thread_runs cancelled
       WHERE cancelled.resource_id = $1 AND cancelled.thread_id = $2
         AND cancelled.turn_message_id = invocation.turn_message_id AND cancelled.status IN ('cancelling', 'cancelled')
     )) AND NOT EXISTS (
       SELECT 1 FROM brainstrike_delegated_tool_decisions decision
       WHERE decision.owner_resource_id = $1 AND decision.root_thread_id = $2
         AND decision.parent_runtime_run_id = requested.target->>0 AND decision.parent_tool_call_id = requested.target->>1
         AND decision.child_runtime_run_id = requested.target->>2 AND decision.tool_call_id = requested.target->>3
     )`,
    [
      scope.ownerResourceId,
      scope.rootThreadId,
      JSON.stringify([...requested.values()].map(({ tuple, path }) => [...tuple, path])),
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

interface PendingChildContinuation {
  readonly continuationId: string;
  readonly nativeRunId: string;
  readonly personaId: string;
  readonly resourceId: string;
  readonly threadId: string;
}

/** Durable candidate enumeration only; the native reader must verify the actual pending pause. */
export async function readPendingChildContinuations(
  database: DelegatedConversationDatabase,
  scope: { ownerResourceId: string; rootThreadId: string }
): Promise<PendingChildContinuation[]> {
  const rows = await database.query(
    "SELECT id FROM brainstrike_delegated_continuations WHERE owner_resource_id=$1 AND root_thread_id=$2 AND state IN ('awaiting-approval','awaiting-input')",
    [scope.ownerResourceId, scope.rootThreadId]
  );
  const graph = createDelegatedConversationRepository(database);
  const candidates = await Promise.all(
    z
      .array(z.object({ id: z.string().min(1) }))
      .parse(rows.rows)
      .map(async ({ id }): Promise<PendingChildContinuation | null> => {
        const receipt = await graph.getContinuation(scope, id);
        if (!receipt) {
          throw new Error('Pending child continuation no longer has authorized native ancestry.');
        }
        if (receipt.state !== 'awaiting-approval' && receipt.state !== 'awaiting-input') {
          return null;
        }
        if (!receipt.nativeRunId) {
          throw new Error('Pending child continuation is missing its native run.');
        }
        const persona = z
          .object({ persona: z.object({ id: z.string().trim().min(1) }) })
          .parse(receipt.configuration).persona;
        return {
          continuationId: receipt.id,
          nativeRunId: receipt.nativeRunId,
          personaId: persona.id,
          resourceId: receipt.resourceId,
          threadId: receipt.threadId,
        };
      })
  );
  return candidates.filter(
    (candidate): candidate is PendingChildContinuation => candidate !== null
  );
}

async function readContinuationDecisionStates(
  database: DelegatedConversationDatabase,
  scope: { ownerResourceId: string; rootThreadId: string },
  requests: readonly DiscoveredDecision[]
): Promise<Map<string, DelegatedToolDecisionState>> {
  const states = new Map<string, DelegatedToolDecisionState>();
  for (const request of requests) {
    if (!request.continuationId) {
      continue;
    }
    const receipt = await createDelegatedConversationRepository(database).getContinuation(
      scope,
      request.continuationId
    );
    if (!receipt || receipt.nativeRunId !== request.runId) {
      throw new Error('Discovered child continuation identity is unauthorized.');
    }
    const targetRunId = request.delegation?.path.at(-1)?.childRuntimeRunId ?? request.runId;
    const toolCallId = request.delegation?.toolCallId ?? request.toolCallId;
    const result = await database.query(
      `SELECT decision.state FROM brainstrike_delegated_continuation_decisions decision
      WHERE decision.continuation_id=$1 AND decision.native_run_id=$2 AND decision.target_runtime_run_id=$3 AND decision.tool_call_id=$4
      UNION ALL SELECT 'cancelled' WHERE EXISTS (
        SELECT 1 FROM brainstrike_delegated_continuations receipt WHERE receipt.id=$1 AND receipt.cancellation_requested_at IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM brainstrike_delegated_invocations stopped
        JOIN jsonb_array_elements_text($5::jsonb) path(run_id) ON path.run_id=stopped.child_runtime_run_id
        WHERE stopped.owner_resource_id=$6 AND stopped.root_thread_id=$7 AND stopped.turn_message_id=$8 AND stopped.cancellation_requested_at IS NOT NULL
      )`,
      [
        receipt.id,
        request.runId,
        targetRunId,
        toolCallId,
        JSON.stringify(request.delegation?.path.map((edge) => edge.childRuntimeRunId) ?? []),
        scope.ownerResourceId,
        scope.rootThreadId,
        receipt.turnMessageId,
      ]
    );
    for (const row of z
      .array(
        z.object({ state: z.custom<DelegatedToolDecisionState>(isDelegatedToolDecisionState) })
      )
      .parse(result.rows)) {
      const key = getToolActionIdentityKey(request);
      // UNION ALL has no row ordering guarantee. A cancellation fence always
      // wins over an earlier decision claim, regardless of the query plan.
      if (states.get(key) !== 'cancelled') {
        states.set(key, row.state);
      }
    }
  }
  return states;
}
