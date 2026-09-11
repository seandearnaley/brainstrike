import { DELEGATION_LIMITS } from '@brainstrike/assistant-contract';
import {
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { z } from 'zod';
import { assertDelegatedConversationAdmission } from './delegated-cancellation-admission';

const budgetSchema = z.object({
  chargedOutputTokens: z.number().int().nonnegative(),
  invocations: z.number().int().nonnegative(),
  maxChildSteps: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxInvocations: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  synthesisOutputTokens: z.number().int().positive(),
});

/** Must run inside the same callback transaction as graph/invocation admission. */
export async function reserveDelegatedInvocation(
  tx: DelegatedConversationDatabase,
  scope: DelegatedConversationScope & { turnMessageId: string },
  hostRunId: string,
  parentThreadId: string,
  duplicate: boolean,
  childThreadId: string,
  configuration: unknown
): Promise<void> {
  await assertDelegationRootRunning(tx, scope, hostRunId);
  await assertDelegatedConversationAdmission(tx, scope, [parentThreadId, childThreadId]);
  const legacy = await tx.query(
    `SELECT 1 FROM brainstrike_delegated_invocations invocation
      JOIN brainstrike_assistant_thread_runs host ON host.id = invocation.host_run_id
      WHERE invocation.root_thread_id = $1 AND host.turn_message_id = $2
      AND NOT EXISTS (SELECT 1 FROM brainstrike_delegation_budgets
        WHERE root_thread_id = $1 AND turn_message_id = $2) LIMIT 1`,
    [scope.rootThreadId, scope.turnMessageId]
  );
  if (legacy.rows.length > 0) {
    throw new Error('This legacy delegation has no durable budget. Start a new parent turn.');
  }
  await tx.query(
    `INSERT INTO brainstrike_delegation_budgets
       (root_thread_id, turn_message_id, owner_resource_id, max_depth, max_invocations,
        max_output_tokens, max_child_steps, max_child_output_tokens, max_step_output_tokens, synthesis_output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [
      scope.rootThreadId,
      scope.turnMessageId,
      scope.ownerResourceId,
      DELEGATION_LIMITS.maxDepth,
      DELEGATION_LIMITS.maxInvocations,
      DELEGATION_LIMITS.maxTreeOutputTokens,
      DELEGATION_LIMITS.maxChildSteps,
      DELEGATION_LIMITS.maxChildOutputTokens,
      DELEGATION_LIMITS.maxStepOutputTokens,
      DELEGATION_LIMITS.synthesisOutputTokens,
    ]
  );
  const result = await tx.query(
    `SELECT charged_output_tokens AS "chargedOutputTokens", invocations AS "invocations", max_child_steps AS "maxChildSteps", max_depth AS "maxDepth", max_invocations AS "maxInvocations", max_output_tokens AS "maxOutputTokens", synthesis_output_tokens AS "synthesisOutputTokens" FROM brainstrike_delegation_budgets
     WHERE root_thread_id = $1 AND turn_message_id = $2 AND owner_resource_id = $3 FOR UPDATE`,
    [scope.rootThreadId, scope.turnMessageId, scope.ownerResourceId]
  );
  if (result.rows.length !== 1) {
    throw new Error('Delegated budget owner scope is unauthorized.');
  }
  const budget = budgetSchema.parse(result.rows[0]);
  if (duplicate) {
    return;
  }
  const ancestry = await tx.query(
    `WITH RECURSIVE parents AS (
       SELECT thread_id, parent_thread_id, 1 AS depth FROM brainstrike_delegated_conversations
       WHERE thread_id = $1 AND root_thread_id = $2 AND owner_resource_id = $3
       UNION ALL
       SELECT node.thread_id, node.parent_thread_id, parents.depth + 1
       FROM brainstrike_delegated_conversations node JOIN parents ON node.thread_id = parents.parent_thread_id
       WHERE node.root_thread_id = $2 AND node.owner_resource_id = $3 AND parents.depth <= $4
     ) SELECT depth FROM parents WHERE thread_id = $2`,
    [parentThreadId, scope.rootThreadId, scope.ownerResourceId, budget.maxDepth]
  );
  const depth = z.object({ depth: z.number().int().positive() }).safeParse(ancestry.rows[0]);
  if (!depth.success || depth.data.depth > budget.maxDepth) {
    throw new Error(`Delegation depth limit reached (${budget.maxDepth} descendant levels).`);
  }
  if (budget.invocations >= budget.maxInvocations) {
    throw new Error(
      `Delegation invocation limit reached (${budget.maxInvocations} per original turn).`
    );
  }
  const existingChild = await tx.query(
    `SELECT child_thread_id FROM brainstrike_delegation_child_budgets
     WHERE root_thread_id = $1 AND turn_message_id = $2 AND child_thread_id = $3`,
    [scope.rootThreadId, scope.turnMessageId, childThreadId]
  );
  const summaryCharge = existingChild.rows.length === 0 ? budget.synthesisOutputTokens : 0;
  if (budget.chargedOutputTokens + summaryCharge > budget.maxOutputTokens) {
    throw new Error('Delegation output budget cannot reserve a child summary.');
  }
  const configurationBudget = z
    .object({ maxSteps: z.number().int().positive() })
    .parse(configuration);
  await tx.query(
    `INSERT INTO brainstrike_delegation_child_budgets
      (root_thread_id, turn_message_id, child_thread_id, max_steps, charged_output_tokens)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [
      scope.rootThreadId,
      scope.turnMessageId,
      childThreadId,
      Math.min(configurationBudget.maxSteps, budget.maxChildSteps),
      budget.synthesisOutputTokens,
    ]
  );
  await tx.query(
    `UPDATE brainstrike_delegation_budgets SET invocations = invocations + 1,
       charged_output_tokens = charged_output_tokens + $4
     WHERE root_thread_id = $1 AND turn_message_id = $2 AND owner_resource_id = $3`,
    [scope.rootThreadId, scope.turnMessageId, scope.ownerResourceId, summaryCharge]
  );
}

export async function assertDelegationRootRunning(
  tx: DelegatedConversationDatabase,
  scope: DelegatedConversationScope & { turnMessageId: string },
  hostRunId: string
): Promise<void> {
  const active = await tx.query(
    `SELECT current.id FROM brainstrike_assistant_thread_runs current
     WHERE current.id = $1 AND current.status = 'running'
       AND current.thread_id = $2 AND current.resource_id = $3 AND current.turn_message_id = $4
       AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_thread_runs stopped
         WHERE stopped.thread_id = current.thread_id AND stopped.resource_id = current.resource_id
           AND stopped.turn_message_id = current.turn_message_id
           AND stopped.status IN ('cancelling', 'cancelled')) FOR UPDATE`,
    [hostRunId, scope.rootThreadId, scope.ownerResourceId, scope.turnMessageId]
  );
  if (active.rows.length !== 1) {
    throw new DelegatedConversationIdentityError('delegation-root-not-running');
  }
}
