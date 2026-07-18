import {
  type AssistantTaskItem,
  assignTaskIds,
  fitItemsToCharBudget,
  type ManageTaskListInput,
  type ManageTaskListResult,
  type RuntimeData,
  summarizeAssistantTaskList,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import {
  readThreadTaskList,
  type TaskListDatabase,
  writeThreadTaskList,
} from './task-list-repository';

export type { TaskListDatabase } from './task-list-repository';

export const MANAGE_TASK_LIST_TOOL_ID = NATIVE_TOOL_ID.manageTaskList;

const logger = createLogger('AssistantTaskList');

export interface ManageTaskListDependencies {
  /** Injected DB handle for tests; production resolves the main-process handle. */
  database?: TaskListDatabase;
}

async function resolveDesktopDatabase(): Promise<TaskListDatabase> {
  const { getDatabase } = await import('../db-main');
  return getDatabase();
}

/**
 * Result of the tool. On success it is the shared {@link ManageTaskListResult}
 * (which the UI derives from the message parts); on a missing active thread it
 * is a structured error so the model sees a failure rather than a silent no-op.
 */
export type ManageTaskListToolResult = ManageTaskListResult | { ok: false; error: string };

/**
 * Whole-replace the current thread's task list, assigning stable ids (reusing
 * prior ids on unchanged content), persist it, and return a budget-bounded view
 * plus a status summary.
 */
export async function runManageTaskList(
  input: ManageTaskListInput,
  runtimeData: RuntimeData | undefined,
  dependencies: ManageTaskListDependencies = {}
): Promise<ManageTaskListToolResult> {
  const threadId = runtimeData?.memory?.threadId;
  const resourceId = runtimeData?.memory?.resourceId;
  if (!(threadId && resourceId)) {
    logger.warn('manageTaskList called without an active memory thread');
    return { error: 'manageTaskList requires an active memory thread.', ok: false };
  }

  // db-main is lazy-imported so unit tests can inject a fake DB without dragging
  // in the wasm/PGlite loader at module-eval time.
  const db = dependencies.database ?? (await resolveDesktopDatabase());
  const previous = await readThreadTaskList(db, threadId);
  const tasks = assignTaskIds(input.tasks, previous);
  await writeThreadTaskList(db, { resourceId, tasks, threadId });

  // Summary reflects the FULL persisted list, even if the returned `tasks` view
  // is trimmed to fit the tool result budget.
  const summary = summarizeAssistantTaskList(tasks);
  const { result } = fitItemsToCharBudget<AssistantTaskItem, ManageTaskListResult>(
    tasks,
    (kept) => {
      const truncated = kept.length < tasks.length;
      return {
        summary,
        tasks: kept,
        ...(truncated
          ? {
              hint: `Stored ${tasks.length} tasks; showing ${kept.length} to fit the tool result budget. The full list persists and is re-shown to you next turn.`,
              truncated: true,
            }
          : {}),
      };
    }
  );
  return result;
}
