/**
 * Unit coverage for the desktop `brainstrike.manageTaskList` tool
 * (runManageTaskList) + its task-list repository.
 *
 * HERMETIC: the DB is an in-memory double injected via dependencies, so no real
 * PGlite or getDatabase() is touched. Proves whole-list-replace persistence,
 * stable id reuse across turns, the NO-SILENT-FALLBACKS missing-thread path
 * (structured { ok:false } — never a no-op that reads as success), and the
 * self-bounded oversized-list output (truncated + hint, still ok).
 */
import type { ManageTaskListResult, RuntimeData } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import {
  runManageTaskList,
  type TaskListDatabase,
} from '../../assistant-server/manage-task-list-tool';
import { readThreadTaskList } from '../../assistant-server/task-list-repository';

function createFakeDb(): TaskListDatabase & {
  store: Map<string, { resource_id: string; tasks: unknown }>;
} {
  const store = new Map<string, { resource_id: string; tasks: unknown }>();
  return {
    query: async <T = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[]
    ): Promise<{ rows: T[] }> => {
      if (/^\s*SELECT/i.test(sql)) {
        const threadId = String(params?.[0]);
        const row = store.get(threadId);
        return { rows: (row ? [{ tasks: row.tasks }] : []) as T[] };
      }
      if (/INSERT/i.test(sql)) {
        const threadId = String(params?.[0]);
        const resourceId = String(params?.[1]);
        const tasksJson = String(params?.[2]);
        store.set(threadId, { resource_id: resourceId, tasks: JSON.parse(tasksJson) });
        return { rows: [] as T[] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    store,
  };
}

function runtimeWithThread(threadId: string, resourceId: string): RuntimeData {
  return { memory: { resourceId, threadId } } as RuntimeData;
}

function isTaskListResult(
  result: ManageTaskListResult | { ok: false; error: string }
): result is ManageTaskListResult {
  return !('ok' in result);
}

describe('runManageTaskList', () => {
  it('persists a 3-task list and returns ids + summary', async () => {
    const db = createFakeDb();
    const result = await runManageTaskList(
      {
        tasks: [
          { activeForm: 'Reading the spec', content: 'Read the spec', status: 'completed' },
          { activeForm: 'Implementing', content: 'Implement', status: 'in_progress' },
          { activeForm: 'Testing', content: 'Test', status: 'pending' },
        ],
      },
      runtimeWithThread('thread-1', 'workspace-a'),
      { database: db }
    );

    expect(isTaskListResult(result)).toBe(true);
    if (!isTaskListResult(result)) {
      return;
    }
    expect(result.tasks).toHaveLength(3);
    for (const task of result.tasks) {
      expect(typeof task.id).toBe('string');
      expect(task.id.length).toBeGreaterThan(0);
    }
    expect(result.summary).toEqual({ completed: 1, inProgress: 1, pending: 1, total: 3 });
    // Persisted (whole-replace) under the thread id.
    expect(db.store.get('thread-1')?.resource_id).toBe('workspace-a');
    expect((db.store.get('thread-1')?.tasks as unknown[] | undefined)?.length).toBe(3);
  });

  it('whole-replaces on a second call and keeps the matched task id', async () => {
    const db = createFakeDb();
    const first = await runManageTaskList(
      { tasks: [{ activeForm: 'Implementing', content: 'Implement', status: 'in_progress' }] },
      runtimeWithThread('thread-1', 'workspace-a'),
      { database: db }
    );
    if (!isTaskListResult(first)) {
      throw new Error('expected task-list result');
    }
    const firstId = first.tasks[0]?.id;

    const second = await runManageTaskList(
      { tasks: [{ activeForm: 'Implementing', content: 'Implement', status: 'completed' }] },
      runtimeWithThread('thread-1', 'workspace-a'),
      { database: db }
    );
    if (!isTaskListResult(second)) {
      throw new Error('expected task-list result');
    }
    expect(second.tasks[0]?.id).toBe(firstId);
    expect(second.tasks[0]?.status).toBe('completed');
    expect(second.summary).toEqual({ completed: 1, inProgress: 0, pending: 0, total: 1 });
  });

  it('returns a structured error when there is no active thread (no silent fallback)', async () => {
    const db = createFakeDb();
    const result = await runManageTaskList(
      { tasks: [{ activeForm: 'Doing', content: 'Do', status: 'pending' }] },
      {} as RuntimeData,
      { database: db }
    );
    expect(isTaskListResult(result)).toBe(false);
    expect(result).toEqual({ error: expect.stringContaining('thread'), ok: false });
    // Nothing persisted.
    expect(db.store.size).toBe(0);
  });

  it('self-bounds an oversized list with truncated + hint (still ok)', async () => {
    const db = createFakeDb();
    const bigContent = 'x'.repeat(500);
    const bigActiveForm = 'y'.repeat(500);
    const result = await runManageTaskList(
      {
        tasks: Array.from({ length: 50 }, () => ({
          activeForm: bigActiveForm,
          content: bigContent,
          status: 'pending' as const,
        })),
      },
      runtimeWithThread('thread-1', 'workspace-a'),
      { database: db }
    );
    if (!isTaskListResult(result)) {
      throw new Error('expected task-list result');
    }
    expect(result.truncated).toBe(true);
    expect(typeof result.hint).toBe('string');
    expect(result.tasks.length).toBeLessThan(50);
    // The FULL list still persists even though the returned view is trimmed.
    expect((db.store.get('thread-1')?.tasks as unknown[] | undefined)?.length).toBe(50);
    // Summary reflects the full stored list, not the trimmed view.
    expect(result.summary.total).toBe(50);
  });
});

/** A fake DB whose SELECT returns a fixed `tasks` value verbatim, for probing readThreadTaskList's row-shape validation. */
function createFixedRowDb(tasks: unknown): TaskListDatabase {
  return {
    query: async <T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> => {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: [{ tasks }] as T[] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe('readThreadTaskList row validation', () => {
  it('returns [] when no row is persisted for the thread (genuine absence)', async () => {
    const db: TaskListDatabase = {
      query: async <T = Record<string, unknown>>(): Promise<{ rows: T[] }> => ({ rows: [] as T[] }),
    };
    await expect(readThreadTaskList(db, 'thread-missing')).resolves.toEqual([]);
  });

  it('returns the tasks when every item matches the AssistantTaskItem shape', async () => {
    const tasks = [
      { activeForm: 'Reading', content: 'Read', id: 'a', status: 'in_progress' },
      { activeForm: 'Testing', content: 'Test', id: 'b', status: 'pending' },
    ];
    const db = createFixedRowDb(tasks);
    await expect(readThreadTaskList(db, 'thread-1')).resolves.toEqual(tasks);
  });

  it('throws on a non-array tasks column (corruption, not absence)', async () => {
    const db = createFixedRowDb({ not: 'an array' });
    await expect(readThreadTaskList(db, 'thread-1')).rejects.toThrow(/corrupt/i);
  });

  it('throws when a task item is missing a required field', async () => {
    const db = createFixedRowDb([{ activeForm: 'Reading', content: 'Read', status: 'pending' }]);
    await expect(readThreadTaskList(db, 'thread-1')).rejects.toThrow(/corrupt/i);
  });

  it('throws when a task item has an unknown status value', async () => {
    const db = createFixedRowDb([
      { activeForm: 'Reading', content: 'Read', id: 'a', status: 'archived' },
    ]);
    await expect(readThreadTaskList(db, 'thread-1')).rejects.toThrow(/corrupt/i);
  });
});
