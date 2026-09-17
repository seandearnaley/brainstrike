import type { BackgroundTask, TaskFilter, TaskListResult } from '@mastra/core/background-tasks';
import type { BackgroundTasksStorage } from '@mastra/core/storage';

/** Host delivery acknowledgement lives on the native task row, independently
 * of transcript retention. It never changes native task status or executes work. */
export interface BackgroundResultDelivery {
  listUndeliveredTasks(filter: TaskFilter): Promise<TaskListResult>;
  markResultDelivered(taskId: string): Promise<void>;
}

export function requireBackgroundResultDelivery(
  store: BackgroundTasksStorage | undefined
): BackgroundResultDelivery {
  if (
    !(
      store &&
      'listUndeliveredTasks' in store &&
      typeof store.listUndeliveredTasks === 'function' &&
      'markResultDelivered' in store &&
      typeof store.markResultDelivered === 'function'
    )
  ) {
    throw new Error('Background execution requires durable result-delivery acknowledgement.');
  }
  return store as BackgroundTasksStorage & BackgroundResultDelivery;
}

export function completedBackgroundOutcome(task: BackgroundTask) {
  if (task.status === 'completed') {
    return { result: task.result, status: 'completed' as const };
  }
  if (task.status === 'cancelled') {
    return {
      error: {
        message: 'Background task was cancelled; it has no result. Do not rerun unless requested.',
      },
      status: 'failed' as const,
    };
  }
  if (task.status !== 'failed' && task.status !== 'timed_out') {
    throw new Error('Background recovery returned an unfinished task.');
  }
  return {
    error: task.error ?? {
      message:
        task.status === 'timed_out'
          ? 'Background task timed out. External effects may have completed; inspect the workspace before rerunning.'
          : 'Background task failed without persisted error details. Inspect its transcript and workspace before rerunning.',
    },
    status: 'failed' as const,
  };
}
