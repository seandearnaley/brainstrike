import { ASSISTANT_TASK_STATUSES, type AssistantTaskItem } from '@brainstrike/agent';
import type { TaskListStore } from '@brainstrike/host-capabilities/native-tools';

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

function isAssistantTaskItem(value: unknown): value is AssistantTaskItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['content'] === 'string' &&
    typeof record['activeForm'] === 'string' &&
    typeof record['status'] === 'string' &&
    (ASSISTANT_TASK_STATUSES as readonly string[]).includes(record['status'])
  );
}

function isAssistantTaskItemArray(value: unknown): value is AssistantTaskItem[] {
  return Array.isArray(value) && value.every(isAssistantTaskItem);
}

/**
 * Read the current persisted task list for a thread. Returns `[]` when the row
 * is absent (no plan yet) — a genuine "no plan" state, not a swallowed error.
 *
 * A PRESENT row whose `tasks` column does not match the expected
 * `AssistantTaskItem[]` shape (missing/mistyped field, unknown status) is
 * corruption, not absence — this THROWS rather than silently degrading to `[]`
 * or building on unvalidated data (mirrors the require*-throws convention in
 * assistant-data's assistant-memory-repository.ts for structurally-required
 * fields). Both call sites already have a boundary for this: the per-turn
 * re-injection read in assistant-server/agent-stream-init.ts catches and logs a warn (a corrupt
 * row this turn legitimately degrades to "no plan"), and the manageTaskList
 * tool's read is caught by the tool execution wrapper, surfacing as a visible
 * structured tool failure instead of a silent no-op.
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
  if (!isAssistantTaskItemArray(row.tasks)) {
    throw new Error(
      `Corrupt persisted task list for thread "${threadId}": the tasks column does not match the expected AssistantTaskItem[] shape.`
    );
  }
  return row.tasks;
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

async function resolveDesktopTaskListDatabase(): Promise<TaskListDatabase> {
  const { getDatabase } = await import('../db-main');
  return getDatabase();
}

/** A legacy thread's PGlite-backed plan (lazy main-process handle unless injected). */
export function createDesktopTaskListStore(
  thread: { readonly resourceId: string; readonly threadId: string },
  database?: TaskListDatabase
): TaskListStore {
  return {
    replace: async (next) => {
      const db = database ?? (await resolveDesktopTaskListDatabase());
      const tasks = next(await readThreadTaskList(db, thread.threadId));
      await writeThreadTaskList(db, { ...thread, tasks });
      return tasks;
    },
  };
}
