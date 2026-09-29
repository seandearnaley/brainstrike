import type { BackgroundTaskManager } from '@mastra/core/background-tasks';

// A host binding may survive reconstruction; native executor closures cannot.
// Correlate only public hook observations with the manager that executed them.
const observedExecutors = new WeakMap<BackgroundTaskManager, Set<string>>();

export function observeNativeBackgroundExecutor(
  manager: BackgroundTaskManager | undefined,
  context: unknown
): void {
  if (
    !(
      manager &&
      context &&
      typeof context === 'object' &&
      'isBackgroundTask' in context &&
      context.isBackgroundTask === true
    )
  ) {
    return;
  }
  const background = 'background' in context ? context.background : undefined;
  const taskId =
    background && typeof background === 'object' && 'taskId' in background
      ? background.taskId
      : undefined;
  if (!(typeof taskId === 'string' && taskId.length > 0)) {
    throw new Error('Background execution requires its observed native task identity.');
  }
  let tasks = observedExecutors.get(manager);
  if (!tasks) {
    tasks = new Set();
    observedExecutors.set(manager, tasks);
  }
  tasks.add(taskId);
}

export function hasObservedNativeBackgroundExecutor(
  manager: BackgroundTaskManager,
  taskId: string
): boolean {
  return observedExecutors.get(manager)?.has(taskId) ?? false;
}
