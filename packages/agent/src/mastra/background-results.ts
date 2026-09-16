import type { MastraDBMessage } from '@mastra/core/agent';
import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import type { BackgroundOutcome } from '../background-result-projection';
import type { RuntimeData } from '../types';
import {
  completedBackgroundOutcome,
  requireBackgroundResultDelivery,
} from './background-result-delivery';

/** Result and cleared decision metadata are saved in the same native message write. */
interface BackgroundTaskResultStore {
  saveBackgroundTaskResult(args: {
    recoveryMessage: MastraDBMessage;
    taskId: string;
  }): Promise<MastraDBMessage[]>;
}

function requireBackgroundTaskResultStore(value: unknown): BackgroundTaskResultStore {
  if (
    !(
      value &&
      typeof value === 'object' &&
      'saveBackgroundTaskResult' in value &&
      typeof value.saveBackgroundTaskResult === 'function'
    )
  ) {
    throw new Error('Background execution requires atomic task-result persistence.');
  }
  return value as BackgroundTaskResultStore;
}

export async function saveBackgroundResult(
  memory: MastraMemory,
  task: BackgroundTask,
  _outcome: BackgroundOutcome
): Promise<void> {
  if (!(task.threadId && task.resourceId)) {
    throw new Error('Background result has no root memory owner.');
  }
  const store = requireBackgroundTaskResultStore(await memory.storage.getStore('memory'));
  await store.saveBackgroundTaskResult({
    recoveryMessage: recoveredInvocation(task),
    taskId: task.id,
  });
}

function recoveredInvocation(task: BackgroundTask): MastraDBMessage {
  if (!(task.threadId && task.resourceId)) {
    throw new Error('Recovered background result has no owner.');
  }
  return {
    content: {
      format: 2,
      metadata: { backgroundTasks: { [task.toolCallId]: { taskId: task.id } } },
      parts: [
        {
          text: 'Recovered a finished background task whose original message is no longer available. This reports its saved outcome; the work was not executed again.',
          type: 'text',
        },
        {
          toolInvocation: {
            args: task.args,
            state: 'call',
            toolCallId: task.toolCallId,
            toolName: task.toolName,
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: task.completedAt ?? task.createdAt,
    id: `background-result-${task.id}`,
    resourceId: task.resourceId,
    role: 'assistant',
    threadId: task.threadId,
  };
}

/** Repair completed-but-undelivered results before inference; never dispatch task executors. */
export async function repairBackgroundResults(params: {
  readonly manager: BackgroundTaskManager | undefined;
  readonly memory: MastraMemory | undefined;
  readonly scope: RuntimeData['memory'];
}): Promise<string[]> {
  const { manager, memory, scope } = params;
  if (!manager) {
    return [];
  }
  if (!(memory && scope)) {
    throw new Error('Background recovery requires the original root memory owner.');
  }
  const delivery = requireBackgroundResultDelivery(await manager.getStorage());
  const listPage = (page: number) =>
    delivery.listUndeliveredTasks({
      orderBy: 'createdAt',
      orderDirection: 'asc',
      page,
      perPage: 100,
      resourceId: scope.resourceId,
      status: ['completed', 'failed', 'timed_out'],
      threadId: scope.threadId,
    });
  const repaired: string[] = [];
  const seen = new Set<string>();
  while (true) {
    const result = await listPage(0);
    if (result.total === 0) {
      return repaired;
    }
    if (result.tasks.length === 0) {
      throw new Error('Background result repair made no pagination progress.');
    }
    for (const task of result.tasks) {
      if (seen.has(task.id)) {
        throw new Error('Background result repair repeated an undelivered task.');
      }
      await saveBackgroundResult(memory, task, completedBackgroundOutcome(task));
      seen.add(task.id);
      repaired.push(task.id);
    }
  }
}

/**
 * LATE RESULTS AFTER A ROOT PAUSE (settled 2026-09-15, live-app verifier run
 * 7): Mastra's `approveToolCall`/`resumeStream` restore the message list
 * snapshotted when the run parked, which holds only the dispatch
 * acknowledgement of every background child still running at that moment. A
 * child that returns after the pause writes its result into memory (native
 * `onResult`), but the resumed run never sees it — the root pre-created its
 * canvas 25 s in, approved it after all four specialists returned, and wrote
 * the report from its own inspection while telling the user it was "still
 * waiting on the four analyses". The late results are exactly the finished
 * tasks this run dispatched whose completion follows the run's pause stamp
 * (`AgentRun.suspendedAt`); they are overlaid onto the resumed run's prompt at
 * the provider boundary (`late-background-results-processor.ts`) and, because
 * the resumed run's final save re-persists its stale copy of the invocation,
 * restored into memory from the task rows once the leg settles.
 */
export interface LateBackgroundResultsParams {
  readonly manager: BackgroundTaskManager | undefined;
  readonly runId: string;
  readonly scope: RuntimeData['memory'];
  /** The resumed run's pause stamp; `undefined` when the run is not parked. */
  readonly suspendedAt: Date | undefined;
}

export async function listLateBackgroundResults(
  params: LateBackgroundResultsParams
): Promise<BackgroundTask[]> {
  const { manager, runId, scope, suspendedAt } = params;
  if (!(manager && scope && suspendedAt)) {
    return [];
  }
  const late: BackgroundTask[] = [];
  let page = 0;
  let total: number;
  do {
    const result = await manager.listTasks({
      orderBy: 'createdAt',
      orderDirection: 'asc',
      page,
      perPage: 100,
      resourceId: scope.resourceId,
      runId,
      status: ['completed', 'failed', 'timed_out'],
      threadId: scope.threadId,
    });
    total = result.total;
    for (const task of result.tasks) {
      if (!task.completedAt) {
        throw new Error('A finished background task omitted its completion stamp.');
      }
      if (task.completedAt.getTime() >= suspendedAt.getTime()) {
        late.push(task);
      }
    }
    page += 1;
  } while (page * 100 < total);
  return late;
}

/** Re-persist late outcomes after the resumed run's final save wrote its stale copy over them. */
export async function restoreLateBackgroundResults(
  memory: MastraMemory,
  tasks: readonly BackgroundTask[]
): Promise<void> {
  for (const task of tasks) {
    await saveBackgroundResult(memory, task, completedBackgroundOutcome(task));
  }
}
