/**
 * Assistant task-list (todo) contract.
 *
 * Shared shapes for the `brainstrike.manageTaskList` native tool, the per-turn
 * `<current-task-list>` instruction re-injection, and the `TodoProgress` UI.
 * Whole-list-replace semantics and the `pending | in_progress | completed`
 * status enum mirror Mastra's `TaskSignalProvider` conventions so the model
 * behaves conventionally and a future migration to the built-in provider stays
 * low-friction (see the P0 plan D1).
 */

export const ASSISTANT_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type AssistantTaskStatus = (typeof ASSISTANT_TASK_STATUSES)[number];

/** A single task item as persisted and rendered (server-assigned id). */
export interface AssistantTaskItem {
  /** Present-tense in-progress label, e.g. "Implementing the parser". */
  activeForm: string;
  /** Imperative label, e.g. "Implement the parser". */
  content: string;
  id: string;
  status: AssistantTaskStatus;
}

/** Tool INPUT item (no id — the server assigns stable ids). */
export interface AssistantTaskItemInput {
  activeForm: string;
  content: string;
  status: AssistantTaskStatus;
}

export interface AssistantTaskListSummary {
  completed: number;
  inProgress: number;
  pending: number;
  total: number;
}

/**
 * `manageTaskList` tool RESULT — also the shape the UI derives from the message
 * parts (live and after reload). `truncated`/`hint` follow the anti-thrash tool
 * output budget contract; a well-formed list is comfortably within budget.
 */
export interface ManageTaskListResult {
  hint?: string;
  summary: AssistantTaskListSummary;
  tasks: readonly AssistantTaskItem[];
  truncated?: boolean;
}

/** Count a task list by status. Pure. */
export function summarizeAssistantTaskList(
  tasks: readonly AssistantTaskItem[]
): AssistantTaskListSummary {
  const summary: AssistantTaskListSummary = {
    completed: 0,
    inProgress: 0,
    pending: 0,
    total: tasks.length,
  };
  for (const task of tasks) {
    if (task.status === 'completed') {
      summary.completed += 1;
    } else if (task.status === 'in_progress') {
      summary.inProgress += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

/**
 * Assign stable ids to a whole-list-replace input, reusing the previous list's
 * id when an item's `content` is unchanged (mirrors Mastra's `assignTaskIds`
 * intent) so the UI can diff and the re-injection stays stable. Duplicate
 * contents consume prior ids positionally (first occurrence → first prior id),
 * so two identical labels never alias to the same id. Content that has no match
 * gets a fresh `crypto.randomUUID()`.
 */
export function assignTaskIds(
  inputs: readonly AssistantTaskItemInput[],
  previous: readonly AssistantTaskItem[] = []
): AssistantTaskItem[] {
  const availableIdsByContent = new Map<string, string[]>();
  for (const prior of previous) {
    const queue = availableIdsByContent.get(prior.content);
    if (queue) {
      queue.push(prior.id);
    } else {
      availableIdsByContent.set(prior.content, [prior.id]);
    }
  }

  return inputs.map((input) => {
    const queue = availableIdsByContent.get(input.content);
    const reusedId = queue && queue.length > 0 ? queue.shift() : undefined;
    return {
      activeForm: input.activeForm,
      content: input.content,
      id: reusedId ?? crypto.randomUUID(),
      status: input.status,
    };
  });
}
