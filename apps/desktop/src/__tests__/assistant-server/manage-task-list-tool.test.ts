/**
 * Unit coverage for the host `brainstrike.manageTaskList` tool: the shared
 * executor (runManageTaskList) over the thread's tool state
 * (`hostTaskListStore`), exactly as a host call binds it.
 *
 * HERMETIC: the thread state is Core's per-key contract in memory. Proves
 * whole-list-replace persistence, stable id reuse across turns, the
 * NO-SILENT-FALLBACKS missing-thread path (structured { ok:false } — never a
 * no-op that reads as success), the self-bounded oversized-list output
 * (truncated + hint, still ok), and the store's validation of the stored list.
 */
import type { AssistantTaskItem, ManageTaskListResult, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  hostTaskListStore,
  type runManageTaskList,
} from '@brainstrike/host-capabilities/native-tools';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildHostNativeTools, memoryToolState } from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

type ThreadState = ReturnType<typeof memoryToolState>;
type ManageTaskListToolResult = Awaited<ReturnType<typeof runManageTaskList>>;

/** The task list is one thread-state key: the tool's catalog id. */
const TASK_LIST_KEY = NATIVE_TOOL_ID.manageTaskList;

function runtimeWithThread(threadId: string, resourceId: string): RuntimeData {
  return { memory: { resourceId, threadId } } as RuntimeData;
}

function isTaskListResult(result: ManageTaskListToolResult): result is ManageTaskListResult {
  return !('ok' in result);
}

function storedTasks(state: ThreadState): unknown[] | undefined {
  const stored = state.values.get(TASK_LIST_KEY);
  return Array.isArray(stored) ? stored : undefined;
}

async function run(
  state: ThreadState | undefined,
  input: unknown,
  runtimeData: RuntimeData = runtimeWithThread('thread-1', 'workspace-a')
): Promise<ManageTaskListToolResult> {
  const tools = buildHostNativeTools(runtimeData, {
    ids: [NATIVE_TOOL_ID.manageTaskList],
    ports: { taskList: state ? hostTaskListStore(state) : undefined },
  });
  return await requireToolExecute<ManageTaskListToolResult>(
    tools,
    NATIVE_TOOL_ID.manageTaskList
  )(input);
}

describe('manageTaskList host tool', () => {
  it('persists a 3-task list and returns ids + summary', async () => {
    const state = memoryToolState();
    const result = await run(state, {
      tasks: [
        { activeForm: 'Reading the spec', content: 'Read the spec', status: 'completed' },
        { activeForm: 'Implementing', content: 'Implement', status: 'in_progress' },
        { activeForm: 'Testing', content: 'Test', status: 'pending' },
      ],
    });

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
    // Persisted (whole-replace) under the thread state's task-list key.
    expect([...state.values.keys()]).toEqual([TASK_LIST_KEY]);
    expect(storedTasks(state)?.length).toBe(3);
  });

  it('whole-replaces on a second call and keeps the matched task id', async () => {
    const state = memoryToolState();
    const first = await run(state, {
      tasks: [{ activeForm: 'Implementing', content: 'Implement', status: 'in_progress' }],
    });
    if (!isTaskListResult(first)) {
      throw new Error('expected task-list result');
    }
    const firstId = first.tasks[0]?.id;

    const second = await run(state, {
      tasks: [{ activeForm: 'Implementing', content: 'Implement', status: 'completed' }],
    });
    if (!isTaskListResult(second)) {
      throw new Error('expected task-list result');
    }
    expect(second.tasks[0]?.id).toBe(firstId);
    expect(second.tasks[0]?.status).toBe('completed');
    expect(second.summary).toEqual({ completed: 1, inProgress: 0, pending: 0, total: 1 });
  });

  it('returns a structured error when there is no active thread (no silent fallback)', async () => {
    // `NativeToolPorts.taskList` is absent without an active thread.
    const result = await run(
      undefined,
      { tasks: [{ activeForm: 'Doing', content: 'Do', status: 'pending' }] },
      {} as RuntimeData
    );
    expect(isTaskListResult(result)).toBe(false);
    expect(result).toEqual({ error: expect.stringContaining('thread'), ok: false });
  });

  it('self-bounds an oversized list with truncated + hint (still ok)', async () => {
    const state = memoryToolState();
    const bigContent = 'x'.repeat(500);
    const bigActiveForm = 'y'.repeat(500);
    const result = await run(state, {
      tasks: Array.from({ length: 50 }, () => ({
        activeForm: bigActiveForm,
        content: bigContent,
        status: 'pending' as const,
      })),
    });
    if (!isTaskListResult(result)) {
      throw new Error('expected task-list result');
    }
    expect(result.truncated).toBe(true);
    expect(typeof result.hint).toBe('string');
    expect(result.tasks.length).toBeLessThan(50);
    // The FULL list still persists even though the returned view is trimmed.
    expect(storedTasks(state)?.length).toBe(50);
    // Summary reflects the full stored list, not the trimmed view.
    expect(result.summary.total).toBe(50);
  });
});

/** The list `hostTaskListStore` hands its replacer for a thread state seeded with `stored`. */
async function readCurrentTaskList(stored: unknown): Promise<readonly AssistantTaskItem[]> {
  const state = memoryToolState();
  if (stored !== undefined) {
    state.values.set(TASK_LIST_KEY, stored);
  }
  let seen: readonly AssistantTaskItem[] | undefined;
  await hostTaskListStore(state).replace((current) => {
    seen = current;
    return [...current];
  });
  if (!seen) {
    throw new Error('expected the store to call the replacer');
  }
  return seen;
}

// The store decodes the stored list with Effect Schema since BST-2048 (#3767).
describe('hostTaskListStore stored-list validation', () => {
  it('hands [] when no list is stored for the thread (genuine absence)', async () => {
    await expect(readCurrentTaskList(undefined)).resolves.toEqual([]);
  });

  it('hands the tasks when every item matches the AssistantTaskItem shape', async () => {
    const tasks = [
      { activeForm: 'Reading', content: 'Read', id: 'a', status: 'in_progress' },
      { activeForm: 'Testing', content: 'Test', id: 'b', status: 'pending' },
    ];
    await expect(readCurrentTaskList(tasks)).resolves.toEqual(tasks);
  });

  it('throws on a non-array stored list (corruption, not absence)', async () => {
    await expect(readCurrentTaskList({ not: 'an array' })).rejects.toThrow(Schema.SchemaError);
  });

  it('throws when a task item is missing a required field', async () => {
    await expect(
      readCurrentTaskList([{ activeForm: 'Reading', content: 'Read', status: 'pending' }])
    ).rejects.toThrow(Schema.SchemaError);
  });

  it('throws when a task item has an unknown status value', async () => {
    await expect(
      readCurrentTaskList([{ activeForm: 'Reading', content: 'Read', id: 'a', status: 'archived' }])
    ).rejects.toThrow(Schema.SchemaError);
  });
});
