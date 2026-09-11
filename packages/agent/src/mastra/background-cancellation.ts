import { BACKGROUND_TASK_WORKFLOW_ID } from '@mastra/core/background-tasks';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { BackgroundTaskScope } from '../pglite-mastra-memory/background-store';
import type { DelegatedCancellationTarget } from './delegated-conversation-binding';

/** Called only after the host has revoked turn admission and joined live owners.
 * No new runtime is started: cancellation cannot recover/restart another task. */
export async function cancelStoredBackgroundTasks(
  storage: MastraCompositeStore,
  scope: BackgroundTaskScope,
  parentRunIds: readonly string[]
): Promise<void> {
  await cancelSelectedTasks(
    storage,
    scope,
    [...new Set(parentRunIds)].map((runId) => ({ runId }))
  );
}

/** Host admission and live ownership must be revoked/joined before this stored cleanup. */
export async function cancelStoredBackgroundInvocations(
  storage: MastraCompositeStore,
  scope: BackgroundTaskScope,
  targets: readonly DelegatedCancellationTarget[]
): Promise<void> {
  await cancelSelectedTasks(
    storage,
    scope,
    targets.map((target) => ({
      runId: target.parentRuntimeRunId,
      toolCallId: target.parentToolCallId,
    }))
  );
}

async function cancelSelectedTasks(
  storage: MastraCompositeStore,
  scope: BackgroundTaskScope,
  selection: readonly { runId: string; toolCallId?: string }[]
): Promise<void> {
  if (selection.length === 0) {
    return;
  }
  const tasks = await storage.getStore('backgroundTasks');
  const workflows = await storage.getStore('workflows');
  if (!(tasks && workflows)) {
    throw new Error('Native background cancellation storage is unavailable.');
  }
  for (const { runId, toolCallId } of selection) {
    const page = await tasks.listTasks({
      ...scope,
      runId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
    for (const task of page.tasks) {
      if (
        task.threadId !== scope.threadId ||
        task.resourceId !== scope.resourceId ||
        task.runId !== runId ||
        (toolCallId !== undefined && task.toolCallId !== toolCallId)
      ) {
        throw new Error('Native cancellation returned a task outside the cancelled turn.');
      }
      if (
        (task.status === 'pending' || task.status === 'running' || task.status === 'suspended') &&
        !(await tasks.updateTask(
          task.id,
          { completedAt: new Date(), status: 'cancelled' },
          { expectedStatus: task.status }
        ))
      ) {
        throw new Error('Native background task changed while cancelling the stopped turn.');
      }
      // Repeated Stop also retries an interrupted snapshot deletion for cancelled rows.
      await workflows.deleteWorkflowRunById({
        runId: task.id,
        workflowName: BACKGROUND_TASK_WORKFLOW_ID,
      });
    }
  }
}
