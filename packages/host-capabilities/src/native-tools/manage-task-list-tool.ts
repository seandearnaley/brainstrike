import {
  type AssistantTaskItem,
  assignTaskIds,
  fitItemsToCharBudget,
  type ManageTaskListInput,
  type ManageTaskListResult,
  summarizeAssistantTaskList,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { TaskListStore } from './ports.js';

export const MANAGE_TASK_LIST_TOOL_ID = NATIVE_TOOL_ID.manageTaskList;

/**
 * Result of the tool. On success it is the shared {@link ManageTaskListResult}
 * (which the UI derives from the message parts); without a thread store it is
 * a structured error so the model sees a failure rather than a silent no-op.
 */
export type ManageTaskListToolResult = ManageTaskListResult | { ok: false; error: string };

/**
 * Whole-replace the current thread's task list, assigning stable ids (reusing
 * prior ids on unchanged content), persist it through the thread's store, and
 * return a budget-bounded view plus a status summary.
 */
export async function runManageTaskList(
  input: ManageTaskListInput,
  store: TaskListStore | undefined
): Promise<ManageTaskListToolResult> {
  if (!store) {
    return { error: 'manageTaskList requires an active memory thread.', ok: false };
  }
  const tasks = [...(await store.replace((previous) => assignTaskIds(input.tasks, [...previous])))];

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
