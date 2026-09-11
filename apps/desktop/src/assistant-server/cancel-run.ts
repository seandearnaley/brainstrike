import { listSuspendedMastraRuns } from '@brainstrike/agent';
import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { requestRunCancel } from '@brainstrike/assistant-service/steering';
import { z } from 'zod';
import { getDatabase } from '../db-main';
import { getDesktopMastraMemory } from './mastra-memory';
import type { TurnBoundaryController } from './snapshot-turn-boundaries';

const runScope = z.object({
  resourceId: z.string().min(1),
  status: z.string(),
  threadId: z.string().min(1),
  turnMessageId: z.string().nullable(),
});

/** Cancel host authority durably before aborting any registered execution leg. */
export async function cancelDesktopAssistantRun(
  runId: string,
  boundaries?: Pick<TurnBoundaryController, 'completeCancelledTurn'>
): Promise<boolean> {
  const database = await getDatabase();
  const result = await database.query(
    `SELECT runs.resource_id AS "resourceId", runs.thread_id AS "threadId",
       runs.turn_message_id AS "turnMessageId", runs.status
     FROM brainstrike_assistant_thread_runs runs
     JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
     WHERE runs.id = $1`,
    [runId]
  );
  if (result.rows.length === 0) {
    // Non-persisted runs still have the original live-only cancellation contract.
    return requestRunCancel(runId);
  }
  const scope = runScope.parse(result.rows[0]);
  if (scope.status !== 'running' && scope.status !== 'cancelling' && scope.status !== 'cancelled') {
    if (!scope.turnMessageId) {
      return false;
    }
    const invocations = await database.query(
      `SELECT DISTINCT invocation.parent_runtime_run_id AS "runId"
       FROM brainstrike_delegated_invocations invocation
       JOIN brainstrike_delegated_conversations child ON child.thread_id = invocation.thread_id
         AND child.owner_resource_id = invocation.owner_resource_id AND child.root_thread_id = invocation.root_thread_id
       WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
         AND child.parent_thread_id = $2 AND invocation.turn_message_id = $3`,
      [scope.resourceId, scope.threadId, scope.turnMessageId]
    );
    const ids = z.array(z.object({ runId: z.string().min(1) })).parse(invocations.rows);
    if (ids.length === 0) {
      return false;
    }
    const backing = await getDesktopMastraMemory(
      CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS
    );
    if (!backing.storage) {
      throw new Error('Workflow storage is unavailable; waiting work cannot be cancelled.');
    }
    const discovery = await listSuspendedMastraRuns(
      { resourceId: scope.resourceId, threadId: scope.threadId },
      {
        memory: backing.memory,
        runtime: {
          memory: { resourceId: scope.resourceId, threadId: scope.threadId },
          provider: 'ollama',
        },
        storage: backing.storage,
      }
    );
    const nativeIds = new Set(ids.map(({ runId: nativeRunId }) => nativeRunId));
    const waiting = [...discovery.approvals, ...discovery.suspends].some((pause) =>
      nativeIds.has(pause.runId)
    );
    if (!waiting) {
      return false;
    }
  }
  // One statement serializes cancellation with durable decision admission in
  // the owning PGlite host. A later resume leg still sees this turn's barrier.
  const cancelled = await database.query(
    `UPDATE brainstrike_assistant_thread_runs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'cancelling' END,
       updated_at = NOW()
     WHERE resource_id = $1 AND thread_id = $2
       AND (id = $3 OR (turn_message_id = $4 AND $4 IS NOT NULL))
     RETURNING id`,
    [scope.resourceId, scope.threadId, runId, scope.turnMessageId]
  );
  const ids = z
    .array(z.object({ id: z.string() }))
    .parse(cancelled.rows)
    .map((row) => row.id);
  const active = ids.map((id) => requestRunCancel(id)).some(Boolean);
  // Active execution owns its end capture. Waiting work has no stream left to
  // close the bracket, so close only the exact authoritative turn here.
  if (!active) {
    await boundaries?.completeCancelledTurn({ runId, threadId: scope.threadId, turnRunIds: ids });
    await database.query(
      `UPDATE brainstrike_assistant_thread_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::text[]) AND status = 'cancelling'`,
      [ids]
    );
  }
  return ids.length > 0;
}
