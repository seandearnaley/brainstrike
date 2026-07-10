import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TASK_STATUSES,
  type AssistantTaskItem,
  assignTaskIds,
  summarizeAssistantTaskList,
} from '../assistant-task-list';

describe('ASSISTANT_TASK_STATUSES', () => {
  it('is the Mastra-convention triple in order', () => {
    expect(ASSISTANT_TASK_STATUSES).toEqual(['pending', 'in_progress', 'completed']);
  });
});

describe('summarizeAssistantTaskList', () => {
  it('counts tasks by status', () => {
    const tasks: AssistantTaskItem[] = [
      { activeForm: 'Reading', content: 'Read', id: 'a', status: 'completed' },
      { activeForm: 'Parsing', content: 'Parse', id: 'b', status: 'in_progress' },
      { activeForm: 'Writing', content: 'Write', id: 'c', status: 'pending' },
      { activeForm: 'Testing', content: 'Test', id: 'd', status: 'pending' },
    ];
    expect(summarizeAssistantTaskList(tasks)).toEqual({
      completed: 1,
      inProgress: 1,
      pending: 2,
      total: 4,
    });
  });

  it('returns zeroes for an empty list', () => {
    expect(summarizeAssistantTaskList([])).toEqual({
      completed: 0,
      inProgress: 0,
      pending: 0,
      total: 0,
    });
  });
});

describe('assignTaskIds', () => {
  it('assigns fresh ids for a first (no previous) list', () => {
    const assigned = assignTaskIds([{ activeForm: 'Reading', content: 'Read', status: 'pending' }]);
    expect(assigned).toHaveLength(1);
    expect(typeof assigned[0]?.id).toBe('string');
    expect(assigned[0]?.id.length).toBeGreaterThan(0);
    expect(assigned[0]).toMatchObject({
      activeForm: 'Reading',
      content: 'Read',
      status: 'pending',
    });
  });

  it('reuses the prior id when content is unchanged', () => {
    const previous: AssistantTaskItem[] = [
      { activeForm: 'Reading', content: 'Read', id: 'stable-1', status: 'pending' },
    ];
    const assigned = assignTaskIds(
      [{ activeForm: 'Reading', content: 'Read', status: 'in_progress' }],
      previous
    );
    expect(assigned[0]?.id).toBe('stable-1');
    expect(assigned[0]?.status).toBe('in_progress');
  });

  it('assigns a fresh id when content changes', () => {
    const previous: AssistantTaskItem[] = [
      { activeForm: 'Reading', content: 'Read', id: 'stable-1', status: 'pending' },
    ];
    const assigned = assignTaskIds(
      [{ activeForm: 'Parsing', content: 'Parse', status: 'pending' }],
      previous
    );
    expect(assigned[0]?.id).not.toBe('stable-1');
  });

  it('reuses distinct ids for duplicate contents without aliasing', () => {
    const previous: AssistantTaskItem[] = [
      { activeForm: 'Doing', content: 'Do', id: 'id-1', status: 'pending' },
      { activeForm: 'Doing', content: 'Do', id: 'id-2', status: 'pending' },
    ];
    const assigned = assignTaskIds(
      [
        { activeForm: 'Doing', content: 'Do', status: 'completed' },
        { activeForm: 'Doing', content: 'Do', status: 'pending' },
      ],
      previous
    );
    expect(new Set(assigned.map((task) => task.id))).toEqual(new Set(['id-1', 'id-2']));
  });

  it('returns an empty list for empty input', () => {
    expect(assignTaskIds([])).toEqual([]);
  });
});
