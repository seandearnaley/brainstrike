import { randomUUID } from 'node:crypto';
import type {
  DelegatedBudgetPort,
  DelegatedStepReservation,
} from '@brainstrike/assistant-contract';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import {
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { z } from 'zod';
import { assertDelegatedConversationAdmission } from './delegated-cancellation-admission';
import { admitDelegatedInvocation, assertDelegationRootRunning } from './delegated-tree-admission';

const treeSchema = z.object({
  chargedOutputTokens: z.number().int().nonnegative(),
  maxChildOutputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxStepOutputTokens: z.number().int().positive(),
  synthesisOutputTokens: z.number().int().positive(),
});
const childSchema = z.object({
  chargedOutputTokens: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  steps: z.number().int().nonnegative(),
  synthesisUsed: z.boolean(),
});
type Scope = DelegatedConversationScope & { turnMessageId: string };

type ExhaustedCap = Pick<
  Extract<DelegatedStepReservation, { synthesis: true }>,
  'cap' | 'limit' | 'used'
>;

/**
 * The cap that forces the reserved synthesis step, with the numbers behind it
 * (`used` of `limit`), or null while the child may still work. Named so the
 * child's `delegation.budget.exhausted` run event and the parent-facing
 * truncation note can state WHY the child stopped.
 */
function exhaustedCap(
  tree: z.infer<typeof treeSchema>,
  child: z.infer<typeof childSchema>
): ExhaustedCap | null {
  if (child.steps === child.maxSteps - 1) {
    return { cap: 'steps', limit: child.maxSteps, used: child.steps };
  }
  if (tree.maxOutputTokens - tree.chargedOutputTokens <= 0) {
    return { cap: 'tree-output', limit: tree.maxOutputTokens, used: tree.chargedOutputTokens };
  }
  if (tree.maxChildOutputTokens - child.chargedOutputTokens <= 0) {
    return {
      cap: 'child-output',
      limit: tree.maxChildOutputTokens,
      used: child.chargedOutputTokens,
    };
  }
  return null;
}

function readChildBudget(rows: readonly unknown[]): z.infer<typeof childSchema> {
  if (rows.length !== 1) {
    throw new Error('Delegated child has no budget in this original turn.');
  }
  return childSchema.parse(rows[0]);
}

export function createDelegatedStepBudget(
  database: DelegatedConversationDatabase,
  hostRunId: string,
  readScope: () => Promise<Scope>,
  subagentSettings?: RuntimeSubagentSettings
): DelegatedBudgetPort {
  async function transact<T>(
    operation: (tx: DelegatedConversationDatabase, scope: Scope) => Promise<T>
  ): Promise<T> {
    if (!database.transaction) {
      throw new Error('Delegated budget requires database transactions.');
    }
    const scope = await readScope();
    return await database.transaction(async (tx) => {
      await assertDelegationRootRunning(tx, scope, hostRunId);
      return await operation(tx, scope);
    });
  }
  async function lockTree(tx: DelegatedConversationDatabase, scope: Scope) {
    const tree = await tx.query(
      `SELECT charged_output_tokens AS "chargedOutputTokens", max_child_output_tokens AS "maxChildOutputTokens", max_output_tokens AS "maxOutputTokens", max_step_output_tokens AS "maxStepOutputTokens", synthesis_output_tokens AS "synthesisOutputTokens" FROM brainstrike_delegation_budgets WHERE root_thread_id = $1
       AND turn_message_id = $2 AND owner_resource_id = $3 FOR UPDATE`,
      [scope.rootThreadId, scope.turnMessageId, scope.ownerResourceId]
    );
    if (tree.rows.length !== 1) {
      throw new Error('This legacy delegation has no durable budget. Start a new parent turn.');
    }
    return treeSchema.parse(tree.rows[0]);
  }
  return {
    async admitInvocation(parentScope) {
      return await transact(async (tx, scope) => {
        const repository = createDelegatedConversationRepository(tx);
        // The root joins the graph on its first admission question, exactly as
        // it does on its first persisted child.
        await repository.registerRoot(scope);
        const parent = await repository.get(scope, parentScope.parentThreadId);
        if (!parent || parent.resourceId !== parentScope.parentResourceId) {
          throw new DelegatedConversationIdentityError('parent-scope-mismatch');
        }
        return await admitDelegatedInvocation(
          tx,
          scope,
          hostRunId,
          parentScope.parentThreadId,
          subagentSettings
        );
      });
    },
    async reserveStep(childScope) {
      return await transact(async (tx, scope) => {
        await assertDelegatedConversationAdmission(tx, scope, [childScope.threadId]);
        const node = await createDelegatedConversationRepository(tx).get(
          scope,
          childScope.threadId
        );
        if (!node || node.resourceId !== childScope.resourceId || !node.parentThreadId) {
          throw new Error('Delegated budget child scope is unauthorized.');
        }
        const tree = await lockTree(tx, scope);
        const children = await tx.query(
          `SELECT budget.charged_output_tokens AS "chargedOutputTokens", budget.max_steps AS "maxSteps", budget.steps AS "steps", budget.synthesis_used AS "synthesisUsed" FROM brainstrike_delegation_child_budgets budget
           JOIN brainstrike_delegated_conversations node ON node.thread_id = budget.child_thread_id
             AND node.root_thread_id = budget.root_thread_id AND node.owner_resource_id = $4
           JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
           WHERE budget.root_thread_id = $1 AND budget.turn_message_id = $2
             AND budget.child_thread_id = $3 AND node.resource_id = $5 FOR UPDATE OF budget`,
          [
            scope.rootThreadId,
            scope.turnMessageId,
            childScope.threadId,
            scope.ownerResourceId,
            childScope.resourceId,
          ]
        );
        const child = readChildBudget(children.rows);
        if (child.synthesisUsed || child.steps >= child.maxSteps) {
          throw new Error(
            'Delegated step budget exhausted; reserved synthesis is already consumed.'
          );
        }
        const exhausted = exhaustedCap(tree, child);
        const remaining = Math.min(
          tree.maxOutputTokens - tree.chargedOutputTokens,
          tree.maxChildOutputTokens - child.chargedOutputTokens
        );
        const synthesis = exhausted !== null;
        const outputTokens = synthesis
          ? tree.synthesisOutputTokens
          : Math.min(tree.maxStepOutputTokens, remaining);
        const charge = synthesis ? 0 : outputTokens;
        const id = randomUUID();
        await tx.query(
          `UPDATE brainstrike_delegation_child_budgets SET steps = steps + 1,
             synthesis_used = $4::integer = 1, charged_output_tokens = charged_output_tokens + $5
           WHERE root_thread_id = $1 AND turn_message_id = $2 AND child_thread_id = $3`,
          [scope.rootThreadId, scope.turnMessageId, childScope.threadId, synthesis ? 1 : 0, charge]
        );
        await tx.query(
          `UPDATE brainstrike_delegation_budgets SET charged_output_tokens = charged_output_tokens + $3
           WHERE root_thread_id = $1 AND turn_message_id = $2`,
          [scope.rootThreadId, scope.turnMessageId, charge]
        );
        await tx.query(
          `INSERT INTO brainstrike_delegation_step_reservations
            (id, root_thread_id, turn_message_id, child_thread_id, host_run_id, output_tokens)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            scope.rootThreadId,
            scope.turnMessageId,
            childScope.threadId,
            hostRunId,
            outputTokens,
          ]
        );
        return exhausted === null
          ? { id, outputTokens, synthesis: false }
          : { ...exhausted, id, outputTokens, synthesis: true };
      });
    },
    async settleStep(reservationId, outputTokens) {
      if (outputTokens !== undefined) {
        z.number().int().nonnegative().parse(outputTokens);
      }
      const exceeded = await transact(async (tx, scope) => {
        await lockTree(tx, scope);
        const rows = await tx.query(
          `UPDATE brainstrike_delegation_step_reservations SET settled = TRUE
           WHERE id = $1 AND host_run_id = $2 AND root_thread_id = $3 AND turn_message_id = $4 AND NOT settled
           RETURNING child_thread_id AS "childThreadId", output_tokens AS "outputTokens"`,
          [reservationId, hostRunId, scope.rootThreadId, scope.turnMessageId]
        );
        if (rows.rows.length !== 1) {
          throw new Error(
            'Delegated reservation is already settled or does not belong to this host turn.'
          );
        }
        const reservation = z
          .object({ childThreadId: z.string(), outputTokens: z.number().int().positive() })
          .parse(rows.rows[0]);
        const delta = outputTokens === undefined ? 0 : outputTokens - reservation.outputTokens;
        await tx.query(
          `UPDATE brainstrike_delegation_budgets SET charged_output_tokens = charged_output_tokens + $3
           WHERE root_thread_id = $1 AND turn_message_id = $2`,
          [scope.rootThreadId, scope.turnMessageId, delta]
        );
        await tx.query(
          `UPDATE brainstrike_delegation_child_budgets SET charged_output_tokens = charged_output_tokens + $4
           WHERE root_thread_id = $1 AND turn_message_id = $2 AND child_thread_id = $3`,
          [scope.rootThreadId, scope.turnMessageId, reservation.childThreadId, delta]
        );
        return delta > 0;
      });
      // Commit observed overage before rejecting model tool execution; never erase its cost.
      if (exceeded) {
        throw new Error(
          'Provider exceeded the delegated output reservation; tool execution rejected.'
        );
      }
    },
  };
}
