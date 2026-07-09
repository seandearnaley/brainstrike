import type { AssistantTaskItem } from '@brainstrike/agent';

/**
 * Minimal query surface the task-list repository needs. Both the production
 * main-process DB handle (`getDatabase()` → RemoteDbClient) and the test double
 * satisfy it, so the repository never depends on the concrete client.
 */
export interface TaskListDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

interface TaskListRow {
  tasks: unknown;
}

function isAssistantTaskItemArray(value: unknown): value is AssistantTaskItem[] {
  return Array.isArray(value);
}

/**
 * Read the current persisted task list for a thread. Returns `[]` when the row
 * is absent (no plan yet) — a genuine "no plan" state, not a swallowed error.
 */
export async function readThreadTaskList(
  db: TaskListDatabase,
  threadId: string
): Promise<AssistantTaskItem[]> {
  const result = await db.query<TaskListRow>(
    'SELECT tasks FROM brainstrike_assistant_task_lists WHERE thread_id = $1',
    [threadId]
  );
  const row = result.rows[0];
  if (!row) {
    return [];
  }
  return isAssistantTaskItemArray(row.tasks) ? row.tasks : [];
}

/**
 * Whole-replace the task list for a thread. `INSERT ... ON CONFLICT` overwrites
 * the row (one plan per thread) and bumps `updated_at`.
 */
export async function writeThreadTaskList(
  db: TaskListDatabase,
  args: { threadId: string; resourceId: string; tasks: readonly AssistantTaskItem[] }
): Promise<void> {
  await db.query(
    `INSERT INTO brainstrike_assistant_task_lists (thread_id, resource_id, tasks, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (thread_id) DO UPDATE
       SET tasks = EXCLUDED.tasks,
           resource_id = EXCLUDED.resource_id,
           updated_at = NOW()`,
    [args.threadId, args.resourceId, JSON.stringify(args.tasks)]
  );
}
