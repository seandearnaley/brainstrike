import { BACKGROUND_TASK_WORKFLOW_ID } from '@mastra/core/background-tasks';
import type { MastraCompositeStore } from '@mastra/core/storage';
import type { BackgroundTaskScope } from '../pglite-mastra-memory/background-store';

/** Called only after the host has revoked turn admission and joined live owners.
 * No new runtime is started: cancellation cannot recover/restart another task. */
export async function cancelStoredBackgroundTasks(
  storage: MastraCompositeStore,
  scope: BackgroundTaskScope,
  parentRunIds: readonly string[]
): Promise<void> {
  if (parentRunIds.length === 0) {
    return;
  }
  const tasks = await storage.getStore('backgroundTasks');
  const workflows = await storage.getStore('workflows');
  if (!(tasks && workflows)) {
    throw new Error('Native background cancellation storage is unavailable.');
  }
  for (const runId of new Set(parentRunIds)) {
    const page = await tasks.listTasks({
      ...scope,
      runId,
      status: ['pending', 'running', 'suspended', 'cancelled'],
    });
    for (const task of page.tasks) {
      if (
        task.threadId !== scope.threadId ||
        task.resourceId !== scope.resourceId ||
        task.runId !== runId
      ) {
        throw new Error('Native cancellation returned a task outside the cancelled turn.');
      }
      if (
        task.status !== 'cancelled' &&
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
