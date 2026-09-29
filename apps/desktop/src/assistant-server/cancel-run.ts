import { cancelStoredBackgroundTasks, listSuspendedMastraRuns } from '@brainstrike/agent';
import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import {
  cancelSteerableRunAndWait,
  requestRunCancel,
} from '@brainstrike/assistant-service/steering';
import { z } from 'zod';
import { getDatabase } from '../db-main';
import { cancelDelegatedContinuations } from './delegated-continuation-cancellation';
import { createDesktopDelegatedSuspensionResolver } from './delegated-conversation-host';
import { getDesktopMastraMemory } from './mastra-memory';
import type { TurnBoundaryController } from './snapshot-turn-boundaries';

const runScope = z.object({
  resourceId: z.string().min(1),
  status: z.string(),
  threadId: z.string().min(1),
  turnMessageId: z.string().nullable(),
});

type CancellationDatabase = Awaited<ReturnType<typeof getDatabase>>;
type CancellationScope = z.infer<typeof runScope>;

async function hasWaitingTurnWork(
  database: CancellationDatabase,
  scope: CancellationScope
): Promise<boolean> {
  if (!scope.turnMessageId) {
    return false;
  }
  const continuations = await database.query(
    `SELECT continuation.id FROM brainstrike_delegated_continuations continuation
    JOIN brainstrike_assistant_thread_runs active ON active.id = continuation.active_host_run_id
    WHERE continuation.owner_resource_id = $1 AND continuation.root_thread_id = $2
      AND active.turn_message_id = $3 AND active.resource_id = $1 AND active.thread_id = $2
      AND continuation.state IN ('claimed','running','awaiting-approval','awaiting-input') LIMIT 1`,
    [scope.resourceId, scope.threadId, scope.turnMessageId]
  );
  if (continuations.rows.length > 0) {
    return true;
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
  const backing = await getDesktopMastraMemory(CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS);
  if (!backing.storage) {
    throw new Error('Workflow storage is unavailable; waiting work cannot be cancelled.');
  }
  const nativeIds = new Set(ids.map(({ runId: nativeRunId }) => nativeRunId));
  const tasks = await backing.storage.getStore('backgroundTasks');
  if (!tasks) {
    throw new Error('Native task storage is unavailable; waiting work cannot be cancelled.');
  }
  const background = await tasks.listTasks({
    resourceId: scope.resourceId,
    status: ['pending', 'running', 'suspended'],
    threadId: scope.threadId,
  });
  let waiting = background.tasks.some((task) => nativeIds.has(task.runId));
  if (!waiting) {
    // Teardown needs root ownership, not a resumable leaf decision. Background
    // rows above are authoritative even if their decision snapshot is damaged.
    const discovery = await listSuspendedMastraRuns(
      { resourceId: scope.resourceId, threadId: scope.threadId },
      {
        delegatedSuspensionDiscovery: createDesktopDelegatedSuspensionResolver(database, {
          ownerResourceId: scope.resourceId,
          rootThreadId: scope.threadId,
        }),
        memory: backing.memory,
        runtime: {
          memory: { resourceId: scope.resourceId, threadId: scope.threadId },
          provider: 'ollama',
        },
        storage: backing.storage,
      }
    );
    waiting = [...discovery.approvals, ...discovery.suspends].some((pause) =>
      nativeIds.has(pause.runId)
    );
  }
  if (!waiting) {
    return false;
  }
  return true;
}

async function cancelWaitingTurnTasks(
  database: CancellationDatabase,
  scope: CancellationScope
): Promise<void> {
  if (scope.turnMessageId) {
    const invocations = await database.query(
      `SELECT DISTINCT invocation.parent_runtime_run_id AS "runId"
       FROM brainstrike_delegated_invocations invocation
       JOIN brainstrike_delegated_conversations child ON child.thread_id = invocation.thread_id
         AND child.owner_resource_id = invocation.owner_resource_id AND child.root_thread_id = invocation.root_thread_id
       WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
         AND child.parent_thread_id = $2 AND invocation.turn_message_id = $3`,
      [scope.resourceId, scope.threadId, scope.turnMessageId]
    );
    const nativeIds = z
      .array(z.object({ runId: z.string().min(1) }))
      .parse(invocations.rows)
      .map((row) => row.runId);
    if (nativeIds.length > 0) {
      const backing = await getDesktopMastraMemory(
        CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS
      );
      if (!backing.storage) {
        throw new Error('Background storage is unavailable; cancellation is incomplete.');
      }
      await cancelStoredBackgroundTasks(
        backing.storage,
        { resourceId: scope.resourceId, threadId: scope.threadId },
        nativeIds
      );
    }
  }
}

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
  if (
    scope.status !== 'running' &&
    scope.status !== 'cancelling' &&
    scope.status !== 'cancelled' &&
    !(await hasWaitingTurnWork(database, scope))
  ) {
    return false;
  }
  // One statement serializes cancellation with durable decision admission in
  // the owning PGlite host. A later resume leg still sees this turn's barrier.
  // TURN-SCOPED, and the renderer's Stop gate depends on that: this takes the
  // run plus every run sharing its `turn_message_id`, and
  // `undecided-pause-notices.ts` narrows its re-read to the same turn. Widening
  // this past the turn without widening that gate leaves an earlier turn's
  // cancelled card reading "Pending" with live buttons until the thread is
  // reloaded (docs/agents/assistant-runtime.md, the root-Stop re-read section).
  const cancelled = await database.query(
    `WITH owned AS (
       SELECT id FROM brainstrike_assistant_thread_runs WHERE resource_id = $1 AND thread_id = $2
         AND (id = $3 OR (turn_message_id = $4 AND $4 IS NOT NULL))
     ), updated AS (UPDATE brainstrike_assistant_thread_runs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'cancelling' END,
       updated_at = NOW()
     WHERE resource_id = $1 AND thread_id = $2
       AND (id = $3 OR (turn_message_id = $4 AND $4 IS NOT NULL))
       AND (id = $3 OR status IN ('running', 'cancelling'))
     RETURNING id) SELECT id FROM owned`,
    [scope.resourceId, scope.threadId, runId, scope.turnMessageId]
  );
  const ids = z
    .array(z.object({ id: z.string() }))
    .parse(cancelled.rows)
    .map((row) => row.id);
  const continuations = await database.query(
    `SELECT DISTINCT thread_id AS "threadId" FROM brainstrike_delegated_continuations
    WHERE owner_resource_id = $1 AND root_thread_id = $2
      AND active_host_run_id IN (SELECT jsonb_array_elements_text($3::jsonb))
      AND state IN ('claimed','running','awaiting-approval','awaiting-input')`,
    [scope.resourceId, scope.threadId, JSON.stringify(ids)]
  );
  const continuationThreads = z
    .array(z.object({ threadId: z.string().min(1) }))
    .parse(continuations.rows);
  await Promise.all(
    continuationThreads.map(({ threadId }) =>
      cancelDelegatedContinuations(
        database,
        { ownerResourceId: scope.resourceId, rootThreadId: scope.threadId },
        threadId,
        true
      )
    )
  );
  await Promise.all(ids.map((id) => cancelSteerableRunAndWait(id)));
  await cancelWaitingTurnTasks(database, scope);
  // Teardown may follow a terminal write. Always finalize after actual owners
  // settle; registration alone is not evidence that a future writer remains.
  await boundaries?.completeCancelledTurn({ runId, threadId: scope.threadId, turnRunIds: ids });
  await database.query(
    `UPDATE brainstrike_assistant_thread_runs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE id = ANY($1::text[]) AND status = 'cancelling'`,
    [ids]
  );
  return ids.length > 0;
}
