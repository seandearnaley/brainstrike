import {
  type AssistantRunEvent,
  type DelegatedToolActionIdentity,
  hasValidDelegatedToolActionTarget,
  normalizeAssistantChildInput,
  sanitizeAssistantRunEventMetadata,
  serializeAssistantChildInput,
} from '@brainstrike/assistant-contract';
import {
  type AssistantChildFollowupAction,
  type ChildBranchSelection,
  childBranchSelectionSchema,
} from '@brainstrike/assistant-contract/child-followup';
import {
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from './delegated-conversation-boundary.js';
import { AUTHORIZED_DELEGATED_GRAPH } from './delegated-graph-sql.js';

export type DelegatedContinuationState =
  | 'claimed'
  | 'running'
  | 'awaiting-approval'
  | 'awaiting-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface DelegatedContinuationDecision {
  readonly delegation?: DelegatedToolActionIdentity;
  readonly id: string;
  readonly kind: 'tool-approval' | 'tool-resume';
  readonly nativeRunId: string;
  readonly toolCallId: string;
}
function decisionTarget(input: Omit<DelegatedContinuationDecision, 'kind'>): {
  runtimeRunId: string;
  toolCallId: string;
} {
  if (!input.delegation) {
    return { runtimeRunId: nonblank(input.nativeRunId), toolCallId: nonblank(input.toolCallId) };
  }
  if (
    !hasValidDelegatedToolActionTarget({
      delegation: input.delegation,
      runId: input.nativeRunId,
      toolCallId: input.toolCallId,
    })
  ) {
    throw new DelegatedConversationIdentityError('continuation-decision-path-invalid');
  }
  const leaf = input.delegation.path.at(-1);
  if (!leaf) {
    throw new DelegatedConversationIdentityError('continuation-decision-path-invalid');
  }
  return { runtimeRunId: leaf.childRuntimeRunId, toolCallId: input.delegation.toolCallId };
}
function nonblank(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DelegatedConversationIdentityError('continuation-invalid-value');
  }
  return value;
}
function nonNegativeInteger(value: number, field: 'token-count' | 'depth'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DelegatedConversationIdentityError(`continuation-invalid-${field}`);
  }
  return value;
}
const STATES: readonly string[] = [
  'claimed',
  'running',
  'awaiting-approval',
  'awaiting-input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];
export interface DelegatedContinuation {
  readonly branch?: ChildBranchSelection;
  readonly configuration: unknown;
  readonly depth: number;
  readonly id: string;
  readonly nativeRunId: string | null;
  readonly parentThreadId: string;
  readonly resourceId: string;
  readonly state: DelegatedContinuationState;
  readonly threadId: string;
  readonly turnMessageId: string;
}
function parse(result: { rows: unknown[] }): DelegatedContinuation {
  if (result.rows.length !== 1) {
    throw new DelegatedConversationIdentityError('continuation-unavailable-or-already-admitted');
  }
  const value = result.rows[0];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DelegatedConversationIdentityError('continuation-invalid-row');
  }
  const row = value as Record<string, unknown>;
  const state = nonblank(row['state']);
  if (
    !(STATES.includes(state) && row['configuration']) ||
    typeof row['configuration'] !== 'object' ||
    Array.isArray(row['configuration'])
  ) {
    throw new DelegatedConversationIdentityError('continuation-invalid-row');
  }
  return {
    ...(row['input_payload'] &&
    typeof row['input_payload'] === 'object' &&
    Object.hasOwn(row['input_payload'], 'branch')
      ? { branch: childBranchSelectionSchema.parse(Reflect.get(row['input_payload'], 'branch')) }
      : {}),
    configuration: row['configuration'],
    depth: nonNegativeInteger(Number(row['delegation_depth']), 'depth'),
    id: nonblank(row['id']),
    nativeRunId: row['native_run_id'] === null ? null : nonblank(row['native_run_id']),
    parentThreadId: nonblank(row['parent_thread_id']),
    resourceId: nonblank(row['resource_id']),
    state: state as DelegatedContinuationState,
    threadId: nonblank(row['thread_id']),
    turnMessageId: nonblank(row['turn_message_id']),
  };
}
const AUTHORIZED = `${AUTHORIZED_DELEGATED_GRAPH}, authorized AS (
 SELECT continuation.*, child.resource_id, child.parent_thread_id, COALESCE(continuation.execution_configuration, child.configuration) AS configuration, child.delegation_depth,
   original.provider, original.model, original.runtime_kind
 FROM brainstrike_delegated_continuations continuation
 JOIN owned_nodes child ON child.thread_id = continuation.thread_id AND child.parent_thread_id IS NOT NULL
 JOIN brainstrike_assistant_thread_runs original ON original.id = continuation.host_run_id
   AND original.thread_id = $2 AND original.resource_id = $1 AND original.turn_message_id = continuation.turn_message_id
 JOIN brainstrike_assistant_thread_runs current_host ON current_host.id = $3
   AND current_host.thread_id = $2 AND current_host.resource_id = $1
 WHERE continuation.id = $4 AND continuation.owner_resource_id = $1 AND continuation.root_thread_id = $2
)`;

/** Read-only discovery needs no execution capability or invented host run. */
export async function readDelegatedContinuation(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  id: string
): Promise<DelegatedContinuation | null> {
  const result = await database.query(
    `${AUTHORIZED_DELEGATED_GRAPH}
    SELECT continuation.*, child.resource_id, child.parent_thread_id, COALESCE(continuation.execution_configuration, child.configuration) AS configuration, child.delegation_depth
    FROM brainstrike_delegated_continuations continuation
    JOIN owned_nodes child ON child.thread_id = continuation.thread_id AND child.parent_thread_id IS NOT NULL
    JOIN brainstrike_assistant_thread_runs original ON original.id = continuation.host_run_id
      AND original.thread_id = $2 AND original.resource_id = $1 AND original.turn_message_id = continuation.turn_message_id
    WHERE continuation.owner_resource_id = $1 AND continuation.root_thread_id = $2 AND continuation.id = $3`,
    [nonblank(scope.ownerResourceId), nonblank(scope.rootThreadId), nonblank(id)]
  );
  return result.rows.length === 0 ? null : parse(result);
}

/** Admissions/attribution only. Native Mastra snapshots own resumable execution. */
export function createDelegatedContinuationRepository(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  hostRunId: string
) {
  const args = (id: string): string[] =>
    [scope.ownerResourceId, scope.rootThreadId, hostRunId, id].map((value) => nonblank(value));
  const changed = async (sql: string, params: (string | number | null)[]): Promise<void> => {
    if (!database.transaction) {
      throw new Error('Continuation mutations require a database transaction.');
    }
    await database.transaction(async (tx) => {
      if ((await tx.query(sql, params)).rows.length !== 1) {
        throw new DelegatedConversationIdentityError('continuation-transition-conflict');
      }
    });
  };
  return {
    async assertDecisionClaim(input: Omit<DelegatedContinuationDecision, 'kind'>): Promise<void> {
      const target = decisionTarget(input);
      const result = await database.query(
        `${AUTHORIZED} SELECT decision.continuation_id FROM authorized
        JOIN brainstrike_delegated_continuation_decisions decision ON decision.continuation_id=authorized.id
        WHERE authorized.native_run_id=$5 AND authorized.active_host_run_id=$3 AND authorized.state='running'
          AND authorized.cancellation_requested_at IS NULL AND decision.host_run_id=$3 AND decision.state='claimed'
          AND decision.native_run_id=$5 AND decision.target_runtime_run_id=$6 AND decision.tool_call_id=$7`,
        [...args(input.id), input.nativeRunId, target.runtimeRunId, target.toolCallId]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('continuation-decision-claim-lost');
      }
    },
    async bind(id: string, nativeRunId: string): Promise<DelegatedContinuation> {
      return parse(
        await database.query(
          `${AUTHORIZED}, bound AS (
        UPDATE brainstrike_delegated_continuations target SET native_run_id = $5, state = 'running', updated_at = NOW()
        FROM authorized WHERE target.id = authorized.id AND target.active_host_run_id = $3
          AND target.cancellation_requested_at IS NULL
          AND EXISTS(SELECT 1 FROM brainstrike_assistant_thread_runs current_host WHERE current_host.id = $3 AND current_host.status = 'running' AND current_host.turn_message_id = authorized.turn_message_id)
          AND (target.state = 'claimed' OR (target.state = 'running' AND target.native_run_id = $5))
          AND (target.native_run_id IS NULL OR target.native_run_id = $5)
          AND NOT EXISTS (SELECT 1 FROM brainstrike_delegated_invocations original
            WHERE original.root_thread_id = $2 AND original.child_runtime_run_id = $5)
        RETURNING target.*)
        SELECT bound.*, authorized.resource_id, authorized.parent_thread_id, authorized.configuration, authorized.delegation_depth
        FROM bound JOIN authorized ON authorized.id = bound.id`,
          [...args(id), nonblank(nativeRunId)]
        )
      );
    },
    async claimDecision(input: DelegatedContinuationDecision): Promise<void> {
      await changed(
        `${AUTHORIZED}, claim AS (
        INSERT INTO brainstrike_delegated_continuation_decisions
          (continuation_id, native_run_id, tool_call_id, kind, host_run_id, previous_host_run_id, state, target_runtime_run_id)
        SELECT id, native_run_id, $7, $8, $3, active_host_run_id, 'claimed', $9 FROM authorized
        WHERE native_run_id = $5 AND state = $6 AND cancellation_requested_at IS NULL
          AND EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs current_host WHERE current_host.id = $3 AND current_host.status = 'running' AND current_host.turn_message_id = authorized.turn_message_id)
          AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs other
            WHERE other.id <> $3 AND other.thread_id = $2 AND other.resource_id = $1
              AND other.status IN ('running','cancelling'))
        ON CONFLICT DO NOTHING RETURNING *)
        , resumed AS (
          UPDATE brainstrike_delegated_continuations target SET active_host_run_id = $3, state = 'running', updated_at = NOW()
          FROM claim WHERE target.id = claim.continuation_id AND target.state = $6 RETURNING target.id
        ), previous_legs AS (
          UPDATE brainstrike_assistant_thread_runs run SET status='completed', completed_at=NOW(), updated_at=NOW()
          FROM authorized JOIN resumed ON resumed.id=authorized.id JOIN claim ON claim.continuation_id=authorized.id
          WHERE run.thread_id=authorized.thread_id AND run.resource_id=authorized.resource_id
            AND run.status IN ('running','awaiting-approval','awaiting-input')
            AND EXISTS (SELECT 1 FROM brainstrike_assistant_run_events event WHERE event.run_id=run.id
              AND event.metadata->>'continuationId'=authorized.id
              AND event.metadata->>'continuationHostRunId'=claim.previous_host_run_id)
          RETURNING run.id
        ) SELECT id FROM resumed`,
        [
          ...args(input.id),
          nonblank(input.nativeRunId),
          input.kind === 'tool-approval' ? 'awaiting-approval' : 'awaiting-input',
          decisionTarget(input).toolCallId,
          input.kind,
          decisionTarget(input).runtimeRunId,
        ]
      );
    },
    async finish(
      id: string,
      state: Exclude<DelegatedContinuationState, 'claimed' | 'running'>,
      error?: string,
      projectionRunId?: string
    ): Promise<void> {
      await changed(
        `${AUTHORIZED}, settled AS (UPDATE brainstrike_delegated_continuations target
        SET state = $5, error = $6, updated_at = NOW() FROM authorized
        WHERE target.id = authorized.id AND target.active_host_run_id = $3
          AND (target.state IN ('claimed', 'running') OR (target.state = $5 AND target.error IS NOT DISTINCT FROM $6))
          AND ($5 NOT IN ('awaiting-approval', 'awaiting-input') OR target.native_run_id IS NOT NULL)
        RETURNING target.id), projection AS (
          UPDATE brainstrike_assistant_thread_runs run SET status=$5,
            completed_at=CASE WHEN $5 IN ('awaiting-approval','awaiting-input') THEN NULL ELSE COALESCE(run.completed_at,NOW()) END,
            updated_at=NOW()
          FROM authorized JOIN settled ON settled.id=authorized.id
          WHERE run.id=$7 AND run.thread_id=authorized.thread_id AND run.resource_id=authorized.resource_id
            AND run.status IN ('running','awaiting-approval','awaiting-input') RETURNING run.id
        ) SELECT id FROM settled`,
        [...args(id), state, error ?? null, projectionRunId ?? null]
      );
    },
    async finishDecision(input: DelegatedContinuationDecision): Promise<void> {
      await changed(
        `${AUTHORIZED} UPDATE brainstrike_delegated_continuation_decisions target SET state = 'consumed'
        FROM authorized WHERE target.continuation_id = authorized.id AND target.native_run_id = $5
          AND target.tool_call_id = $6 AND target.host_run_id = $3 AND target.kind = $7 AND target.state = 'claimed' AND target.target_runtime_run_id = $8
        RETURNING target.continuation_id`,
        [
          ...args(input.id),
          input.nativeRunId,
          decisionTarget(input).toolCallId,
          input.kind,
          decisionTarget(input).runtimeRunId,
        ]
      );
    },
    async prepare(
      input: AssistantChildFollowupAction,
      executionConfiguration?: unknown
    ): Promise<DelegatedContinuation> {
      const normalized = normalizeAssistantChildInput({
        id: input.id,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.nextRun ? { nextRun: input.nextRun } : {}),
      });
      const payload = input.branch
        ? JSON.stringify({
            attachments: normalized.attachments ?? [],
            branch: childBranchSelectionSchema.parse(input.branch),
            text: normalized.text,
          })
        : serializeAssistantChildInput(normalized);
      const result = await database.query(
        `${AUTHORIZED_DELEGATED_GRAPH}, claimed AS (
        INSERT INTO brainstrike_delegated_continuations
          (id, owner_resource_id, root_thread_id, thread_id, host_run_id, active_host_run_id, turn_message_id, input_text, input_payload, execution_configuration, state)
        SELECT $4, $1, $2, child.thread_id, host.id, host.id, host.turn_message_id, $6, $7::jsonb, $8::jsonb, 'claimed'
        FROM owned_nodes child
        JOIN brainstrike_assistant_thread_runs host ON host.id = $3 AND host.thread_id = $2
          AND host.resource_id = $1 AND host.status = 'running'
        WHERE child.thread_id = $5 AND child.parent_thread_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs other
            WHERE other.id <> $3 AND other.thread_id = $2 AND other.resource_id = $1 AND other.status IN ('running', 'cancelling'))
          AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs active
            WHERE active.thread_id = child.thread_id AND active.resource_id = child.resource_id
              AND active.status IN ('running', 'cancelling', 'awaiting-approval', 'awaiting-input'))
          AND NOT EXISTS (SELECT 1 FROM brainstrike_delegated_tool_decisions pending
            WHERE pending.root_thread_id = $2 AND pending.state = 'claimed')
          AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_run_events pause
            JOIN brainstrike_assistant_thread_runs paused_run ON paused_run.id = pause.run_id
              AND paused_run.status NOT IN ('cancelled', 'failed')
            WHERE pause.thread_id = child.thread_id AND pause.resource_id = child.resource_id
              AND pause.kind = 'tool.approval.requested' AND NOT EXISTS (
                SELECT 1 FROM brainstrike_assistant_run_events answer
                WHERE answer.thread_id = pause.thread_id AND answer.resource_id = pause.resource_id
                  AND answer.metadata->>'toolCallId' = pause.metadata->>'toolCallId'
                  AND answer.kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported')
                  AND answer.occurred_at >= pause.occurred_at))
        ON CONFLICT DO NOTHING RETURNING *)
        SELECT claimed.*, child.resource_id, child.parent_thread_id, COALESCE(claimed.execution_configuration, child.configuration) AS configuration, child.delegation_depth
        FROM claimed JOIN owned_nodes child ON child.thread_id = claimed.thread_id`,
        [
          ...args(input.id),
          nonblank(input.threadId),
          normalized.text,
          payload,
          executionConfiguration === undefined ? null : JSON.stringify(executionConfiguration),
        ]
      );
      if (result.rows.length !== 0) {
        return parse(result);
      }
      // An existing receipt can already have executed despite a lost acknowledgement.
      // Classify that refusal explicitly; it must never be advertised as undelivered.
      const existing = await database.query(
        `${AUTHORIZED} SELECT thread_id, (input_payload = $5::jsonb OR (input_payload IS NULL AND input_text = $6 AND $7::boolean)) AS same_input FROM authorized`,
        [
          ...args(input.id),
          payload,
          normalized.text,
          normalized.attachments?.length || normalized.nextRun || input.branch ? 'false' : 'true',
        ]
      );
      const receipt = existing.rows[0] as { same_input: unknown; thread_id: unknown } | undefined;
      if (receipt) {
        throw new DelegatedConversationIdentityError(
          receipt.same_input === true && receipt.thread_id === input.threadId
            ? 'continuation-input-already-admitted'
            : 'continuation-input-id-conflict'
        );
      }
      throw new DelegatedConversationIdentityError('continuation-input-not-admitted');
    },
    async read(id: string): Promise<DelegatedContinuation> {
      return parse(await database.query(`${AUTHORIZED} SELECT * FROM authorized`, args(id)));
    },
    async recordEvent(
      id: string,
      event: AssistantRunEvent & { runId: string; sequence: number }
    ): Promise<void> {
      const terminal =
        event.kind === 'run.finished'
          ? 'completed'
          : event.kind === 'run.failed'
            ? 'failed'
            : event.kind === 'run.cancelled'
              ? 'cancelled'
              : null;
      await changed(
        `${AUTHORIZED}, child_run AS (
        INSERT INTO brainstrike_assistant_thread_runs AS target
          (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, completed_at, created_at, updated_at)
        SELECT $5, resource_id, thread_id, COALESCE(configuration #>> '{persona,model,provider}', provider),
          COALESCE(configuration #>> '{persona,model,modelId}', model), runtime_kind, COALESCE($15, 'running'), $13::timestamptz,
          CASE WHEN $15::text IS NOT NULL THEN $13::timestamptz END, NOW(), NOW()
        FROM authorized WHERE native_run_id IS NOT NULL AND active_host_run_id = $3
        ON CONFLICT(id) DO UPDATE SET status = COALESCE($15, target.status),
          completed_at = CASE WHEN $15::text IS NOT NULL THEN $13::timestamptz ELSE target.completed_at END, updated_at = NOW()
        WHERE target.thread_id = EXCLUDED.thread_id AND target.resource_id = EXCLUDED.resource_id
          AND target.provider = EXCLUDED.provider AND target.model = EXCLUDED.model
          AND (target.status = 'running' OR target.status = COALESCE($15, target.status)) RETURNING *)
        INSERT INTO brainstrike_assistant_run_events AS target
          (id,run_id,resource_id,thread_id,sequence,kind,status,label,detail,metadata,occurred_at,duration_ms,created_at,updated_at)
        SELECT $6,id,resource_id,thread_id,$7::integer,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$14::integer,NOW(),NOW() FROM child_run
        ON CONFLICT(id) DO UPDATE SET id = EXCLUDED.id
        WHERE ROW(target.run_id,target.resource_id,target.thread_id,target.sequence,target.kind,target.status,target.label,target.detail,target.metadata,target.occurred_at,target.duration_ms)
          IS NOT DISTINCT FROM ROW(EXCLUDED.run_id,EXCLUDED.resource_id,EXCLUDED.thread_id,EXCLUDED.sequence,EXCLUDED.kind,EXCLUDED.status,EXCLUDED.label,EXCLUDED.detail,EXCLUDED.metadata,EXCLUDED.occurred_at,EXCLUDED.duration_ms)
        RETURNING id`,
        [
          ...args(id),
          event.runId,
          event.id,
          event.sequence,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          JSON.stringify(sanitizeAssistantRunEventMetadata(event.metadata) ?? {}),
          event.timestamp,
          event.durationMs ?? null,
          terminal,
        ]
      );
    },
    async recordUsage(
      id: string,
      input: { inputTokens: number; outputTokens: number; model?: string; provider?: string }
    ): Promise<void> {
      const inputTokens = nonNegativeInteger(input.inputTokens, 'token-count');
      const outputTokens = nonNegativeInteger(input.outputTokens, 'token-count');
      await changed(
        `${AUTHORIZED} INSERT INTO brainstrike_assistant_run_usage AS target
        (id,thread_id,run_id,resource_id,model,provider,input_tokens,output_tokens,run_kind,continuation_id)
        SELECT 'continuation-usage:' || jsonb_build_array(id,$3::text)::text,root_thread_id,$3,owner_resource_id,
          COALESCE($5, configuration #>> '{persona,model,modelId}', model), COALESCE($6, configuration #>> '{persona,model,provider}', provider),
          $7::integer,$8::integer,'subagent',id FROM authorized WHERE native_run_id IS NOT NULL AND active_host_run_id = $3
        ON CONFLICT(continuation_id,run_id) DO UPDATE SET input_tokens = GREATEST(target.input_tokens, EXCLUDED.input_tokens),
          output_tokens = GREATEST(target.output_tokens, EXCLUDED.output_tokens)
        WHERE target.thread_id = EXCLUDED.thread_id AND target.run_id = EXCLUDED.run_id AND target.resource_id = EXCLUDED.resource_id
          AND target.model = EXCLUDED.model AND target.provider = EXCLUDED.provider RETURNING id`,
        [...args(id), input.model ?? null, input.provider ?? null, inputTokens, outputTokens]
      );
    },
    async releaseDecision(input: DelegatedContinuationDecision): Promise<void> {
      await changed(
        `${AUTHORIZED}, released AS (
        DELETE FROM brainstrike_delegated_continuation_decisions target USING authorized
        WHERE target.continuation_id = authorized.id AND target.native_run_id = $5
          AND target.tool_call_id = $6 AND target.host_run_id = $3 AND target.kind = $7 AND target.state = 'claimed' AND target.target_runtime_run_id = $9
        RETURNING target.*)
        , restored AS (
          UPDATE brainstrike_delegated_continuations target SET state = $8, active_host_run_id = released.previous_host_run_id, updated_at = NOW()
          FROM released WHERE target.id = released.continuation_id AND target.active_host_run_id = $3 AND target.state = 'running'
          RETURNING target.id
        ), previous_legs AS (
          UPDATE brainstrike_assistant_thread_runs run SET status=$8, completed_at=NULL, updated_at=NOW()
          FROM authorized JOIN restored ON restored.id=authorized.id JOIN released ON released.continuation_id=authorized.id
          WHERE run.thread_id=authorized.thread_id AND run.resource_id=authorized.resource_id AND run.status='completed'
            AND EXISTS (SELECT 1 FROM brainstrike_assistant_run_events event WHERE event.run_id=run.id
              AND event.metadata->>'continuationId'=authorized.id
              AND event.metadata->>'continuationHostRunId'=released.previous_host_run_id)
          RETURNING run.id
        ) SELECT id FROM restored`,
        [
          ...args(input.id),
          input.nativeRunId,
          decisionTarget(input).toolCallId,
          input.kind,
          input.kind === 'tool-approval' ? 'awaiting-approval' : 'awaiting-input',
          decisionTarget(input).runtimeRunId,
        ]
      );
    },
    async resolveDecision(input: DelegatedContinuationDecision): Promise<DelegatedContinuation> {
      return parse(
        await database.query(
          `${AUTHORIZED} SELECT * FROM authorized
        WHERE native_run_id = $5 AND state = $6 AND cancellation_requested_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM brainstrike_delegated_continuation_decisions decision
          WHERE decision.continuation_id = $4 AND decision.native_run_id = $5 AND decision.tool_call_id = $7 AND decision.target_runtime_run_id = $8)`,
          [
            ...args(input.id),
            nonblank(input.nativeRunId),
            input.kind === 'tool-approval' ? 'awaiting-approval' : 'awaiting-input',
            decisionTarget(input).toolCallId,
            decisionTarget(input).runtimeRunId,
          ]
        )
      );
    },
  };
}
