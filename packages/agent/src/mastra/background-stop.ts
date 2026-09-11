import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { BackgroundTaskScope } from '../pglite-mastra-memory/background-store';

async function cancelUnfinishedTasks(
  manager: BackgroundTaskManager,
  cancelPaused: boolean,
  scope: BackgroundTaskScope
): Promise<void> {
  const attempted = new Set<string>();
  while (true) {
    const page = await manager.listTasks({
      ...scope,
      page: 0,
      perPage: 100,
      status: cancelPaused ? ['pending', 'running', 'suspended'] : ['pending', 'running'],
    });
    if (page.tasks.length === 0) {
      return;
    }
    for (const task of page.tasks) {
      if (attempted.has(task.id)) {
        throw new Error(`Native task ${task.id} did not advance during cancellation.`);
      }
      attempted.add(task.id);
      await manager.cancel(task.id);
    }
  }
}

/** Explicit root Stop cancels queued and paused children as well as running executors. */
export async function stopBackgroundTree(
  manager: BackgroundTaskManager | undefined,
  cancelPaused: boolean,
  scope: BackgroundTaskScope | undefined
): Promise<void> {
  if (!manager) {
    return;
  }
  if (!(scope?.resourceId && scope.threadId)) {
    throw new Error('Background cancellation requires its root owner.');
  }
  // shutdown sets its admission barrier synchronously before the scoped store scan.
  // Keep joining executor/workflow ownership even if a cancellation write fails.
  const results = await Promise.allSettled([
    manager.shutdown(),
    cancelUnfinishedTasks(manager, cancelPaused, scope),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Background tree cancellation failed');
  }
}
