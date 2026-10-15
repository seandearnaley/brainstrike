// @vitest-environment node
import type { ManageTaskListResult } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { deriveTaskListFromParts } from '../derive-task-list';

const result = (
  tasks: ManageTaskListResult['tasks'],
  summary: ManageTaskListResult['summary']
): ManageTaskListResult => ({ summary, tasks });

const liveToolCallPart = (toolName: string, res: ManageTaskListResult) => ({
  args: { tasks: res.tasks },
  result: res,
  toolName,
  type: 'tool-call' as const,
});

describe('deriveTaskListFromParts', () => {
  it('returns the latest manageTaskList result across multiple tool calls', () => {
    const first = result(
      [{ activeForm: 'Reading', content: 'Read', id: 'a', status: 'in_progress' }],
      { completed: 0, inProgress: 1, pending: 0, total: 1 }
    );
    const second = result(
      [
        { activeForm: 'Reading', content: 'Read', id: 'a', status: 'completed' },
        { activeForm: 'Writing', content: 'Write', id: 'b', status: 'in_progress' },
      ],
      { completed: 1, inProgress: 1, pending: 0, total: 2 }
    );
    const derived = deriveTaskListFromParts([
      liveToolCallPart('brainstrike_manageTaskList', first),
      { text: 'thinking', type: 'text' },
      liveToolCallPart('brainstrike_manageTaskList', second),
    ]);
    expect(derived).toEqual(second);
  });

  it('matches both the dotted and the Mastra-sanitized tool name', () => {
    const res = result([{ activeForm: 'Doing', content: 'Do', id: 'a', status: 'pending' }], {
      completed: 0,
      inProgress: 0,
      pending: 1,
      total: 1,
    });
    expect(deriveTaskListFromParts([liveToolCallPart('brainstrike.manageTaskList', res)])).toEqual(
      res
    );
    expect(deriveTaskListFromParts([liveToolCallPart('brainstrike_manageTaskList', res)])).toEqual(
      res
    );
  });

  it('derives from a hydrated tool-invocation-normalized part (result inline)', () => {
    // assistant-memory-repository normalizes persisted `tool-invocation` parts to
    // `{ type: 'tool-call', toolName, result }` — mirror that reload shape.
    const res = result([{ activeForm: 'Testing', content: 'Test', id: 'a', status: 'completed' }], {
      completed: 1,
      inProgress: 0,
      pending: 0,
      total: 1,
    });
    const hydratedPart = {
      result: res,
      toolName: 'brainstrike_manageTaskList',
      type: 'tool-call' as const,
    };
    expect(deriveTaskListFromParts([hydratedPart])).toEqual(res);
  });

  it('returns null when there is no manageTaskList result', () => {
    expect(deriveTaskListFromParts([])).toBeNull();
    expect(
      deriveTaskListFromParts([
        {
          args: {},
          result: { matches: [] },
          toolName: 'brainstrike_grepSearch',
          type: 'tool-call',
        },
        { text: 'hi', type: 'text' },
      ])
    ).toBeNull();
  });

  it('ignores a malformed manageTaskList result payload (no silent bad render)', () => {
    expect(
      deriveTaskListFromParts([
        {
          result: { tasks: 'not-an-array' },
          toolName: 'brainstrike_manageTaskList',
          type: 'tool-call',
        },
      ])
    ).toBeNull();
    // A structured { ok:false } error result is not a task list.
    expect(
      deriveTaskListFromParts([
        {
          result: { error: 'no thread', ok: false },
          toolName: 'brainstrike_manageTaskList',
          type: 'tool-call',
        },
      ])
    ).toBeNull();
  });
});
