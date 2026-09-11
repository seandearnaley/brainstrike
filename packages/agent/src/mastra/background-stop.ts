import type { BackgroundTaskManager } from '@mastra/core/background-tasks';

async function cancelUnfinishedTasks(
  manager: BackgroundTaskManager,
  cancelPaused: boolean
): Promise<void> {
  while (true) {
    const page = await manager.listTasks({
      page: 0,
      perPage: 100,
      status: cancelPaused ? ['pending', 'running', 'suspended'] : ['pending', 'running'],
    });
    if (page.tasks.length === 0) {
      return;
    }
    for (const task of page.tasks) {
      await manager.cancel(task.id);
    }
  }
}

/** Explicit root Stop cancels queued and paused children as well as running executors. */
export async function stopBackgroundTree(
  manager: BackgroundTaskManager | undefined,
  cancelPaused: boolean
): Promise<void> {
  if (!manager) {
    return;
  }
  // shutdown sets its admission barrier synchronously before the scoped store scan.
  // Keep joining executor/workflow ownership even if a cancellation write fails.
  const results = await Promise.allSettled([
    manager.shutdown(),
    cancelUnfinishedTasks(manager, cancelPaused),
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
