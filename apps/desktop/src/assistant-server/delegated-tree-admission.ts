import {
  DELEGATION_LIMITS,
  type DelegatedInvocationAdmission,
} from '@brainstrike/assistant-contract';
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

type BudgetScope = DelegatedConversationScope & { turnMessageId: string };
type Budget = z.infer<typeof budgetSchema>;

/**
 * A deliberate refusal of the original turn's budget, as opposed to a database
 * or schema fault: only these become a model-visible rejection at delegation
 * start; everything else propagates as the failure it is.
 */
class DelegationBudgetRefusal extends Error {}

/** Open (idempotently) and lock the original turn's budget row. */
async function lockBudget(tx: DelegatedConversationDatabase, scope: BudgetScope): Promise<Budget> {
  const legacy = await tx.query(
    `SELECT 1 FROM brainstrike_delegated_invocations invocation
      JOIN brainstrike_assistant_thread_runs host ON host.id = invocation.host_run_id
      WHERE invocation.root_thread_id = $1 AND host.turn_message_id = $2
      AND NOT EXISTS (SELECT 1 FROM brainstrike_delegation_budgets
        WHERE root_thread_id = $1 AND turn_message_id = $2) LIMIT 1`,
    [scope.rootThreadId, scope.turnMessageId]
  );
  if (legacy.rows.length > 0) {
    throw new DelegationBudgetRefusal(
      'This legacy delegation has no durable budget. Start a new parent turn.'
    );
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
    throw new DelegationBudgetRefusal('Delegated budget owner scope is unauthorized.');
  }
  return budgetSchema.parse(result.rows[0]);
}

/**
 * Why one more invocation under `parentThreadId` cannot be admitted, or
 * undefined when it can. `summaryCharge` is the child summary this invocation
 * must still reserve: the full synthesis reservation for a new child, none for
 * a child already budgeted (a replayed admission).
 */
async function describeCapacityRefusal(
  tx: DelegatedConversationDatabase,
  scope: BudgetScope,
  budget: Budget,
  parentThreadId: string,
  summaryCharge: number
): Promise<string | undefined> {
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
    return `Delegation depth limit reached (${budget.maxDepth} descendant levels).`;
  }
  if (budget.invocations >= budget.maxInvocations) {
    return `Delegation invocation limit reached (${budget.maxInvocations} per original turn).`;
  }
  if (budget.chargedOutputTokens + summaryCharge > budget.maxOutputTokens) {
    return 'Delegation output budget cannot reserve a child summary.';
  }
  return;
}

/**
 * The host's answer at delegation START (BST-1751): the same depth, invocation
 * and output rules `reserveDelegatedInvocation` enforces, evaluated before any
 * native child exists so a refusal reaches the model as a rejected delegation
 * instead of failing the root once the child binds. It RESERVES nothing, but
 * it is not free of side effects: it opens the original turn's budget row
 * idempotently and takes its row lock, so a turn whose very first delegation
 * is refused still leaves an empty budget row behind. The reservation at
 * persist time remains the authority. Identity failures (root not running,
 * parent under a stopped ancestor) and database faults still throw.
 */
export async function admitDelegatedInvocation(
  tx: DelegatedConversationDatabase,
  scope: BudgetScope,
  hostRunId: string,
  parentThreadId: string
): Promise<DelegatedInvocationAdmission> {
  await assertDelegationRootRunning(tx, scope, hostRunId);
  await assertDelegatedConversationAdmission(tx, scope, [parentThreadId]);
  let budget: Budget;
  try {
    budget = await lockBudget(tx, scope);
  } catch (error) {
    if (!(error instanceof DelegationBudgetRefusal)) {
      throw error;
    }
    return { admitted: false, reason: error.message };
  }
  const reason = await describeCapacityRefusal(
    tx,
    scope,
    budget,
    parentThreadId,
    budget.synthesisOutputTokens
  );
  return reason === undefined ? { admitted: true } : { admitted: false, reason };
}

/** Must run inside the same callback transaction as graph/invocation admission. */
export async function reserveDelegatedInvocation(
  tx: DelegatedConversationDatabase,
  scope: BudgetScope,
  hostRunId: string,
  parentThreadId: string,
  duplicate: boolean,
  childThreadId: string,
  configuration: unknown
): Promise<void> {
  await assertDelegationRootRunning(tx, scope, hostRunId);
  await assertDelegatedConversationAdmission(tx, scope, [parentThreadId, childThreadId]);
  const budget = await lockBudget(tx, scope);
  if (duplicate) {
    return;
  }
  const existingChild = await tx.query(
    `SELECT child_thread_id FROM brainstrike_delegation_child_budgets
     WHERE root_thread_id = $1 AND turn_message_id = $2 AND child_thread_id = $3`,
    [scope.rootThreadId, scope.turnMessageId, childThreadId]
  );
  const summaryCharge = existingChild.rows.length === 0 ? budget.synthesisOutputTokens : 0;
  const refusal = await describeCapacityRefusal(tx, scope, budget, parentThreadId, summaryCharge);
  if (refusal !== undefined) {
    throw new Error(refusal);
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
