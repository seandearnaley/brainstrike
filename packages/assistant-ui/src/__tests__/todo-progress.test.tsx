import type { ManageTaskListResult } from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskListToolCard, TodoProgress } from '../todo-progress.js';

const result = (
  tasks: ManageTaskListResult['tasks'],
  summary: ManageTaskListResult['summary']
): ManageTaskListResult => ({ summary, tasks });

describe('TodoProgress', () => {
  it('renders a checklist row per task with the in_progress active form', () => {
    render(
      <TodoProgress
        result={result(
          [
            {
              activeForm: 'Reading the spec',
              content: 'Read the spec',
              id: 'a',
              status: 'completed',
            },
            {
              activeForm: 'Implementing the parser',
              content: 'Implement the parser',
              id: 'b',
              status: 'in_progress',
            },
            {
              activeForm: 'Writing the tests',
              content: 'Write the tests',
              id: 'c',
              status: 'pending',
            },
          ],
          { completed: 1, inProgress: 1, pending: 1, total: 3 }
        )}
      />
    );

    // Completed + pending show the imperative content; the in_progress task shows
    // its present-tense activeForm.
    expect(screen.getByText('Read the spec')).toBeInTheDocument();
    expect(screen.getByText('Implementing the parser')).toBeInTheDocument();
    expect(screen.getByText('Write the tests')).toBeInTheDocument();
  });

  it('shows progress as completed/total', () => {
    render(
      <TodoProgress
        result={result(
          [
            { activeForm: 'A', content: 'A', id: 'a', status: 'completed' },
            { activeForm: 'B', content: 'B', id: 'b', status: 'completed' },
            { activeForm: 'C', content: 'C', id: 'c', status: 'pending' },
            { activeForm: 'D', content: 'D', id: 'd', status: 'pending' },
          ],
          { completed: 2, inProgress: 0, pending: 2, total: 4 }
        )}
      />
    );
    expect(screen.getByText('2/4')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
  });

  it('renders nothing for an empty task list', () => {
    const { container } = render(
      <TodoProgress result={result([], { completed: 0, inProgress: 0, pending: 0, total: 0 })} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

function renderTaskCard(props: Record<string, unknown>) {
  const Comp = TaskListToolCard as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(<Comp {...props} />);
}

describe('TaskListToolCard', () => {
  // BST-1681: the raw `manageTaskList` card is a step row like every other
  // card in the group body — the verb carries the tense, the disclosure is
  // the row itself (no <details>/<summary>).
  it('reads the past-tense verb once the call settled and keeps the raw payload collapsed', () => {
    renderTaskCard({
      args: { merge: true },
      argsText: '{"merge":true}',
      result: { ok: true },
      status: { type: 'complete' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    expect(screen.getByText('Updated tasks')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
    expect(screen.queryByText(/"merge"/)).not.toBeInTheDocument();
  });

  it('opens the raw args and result behind the row toggle', () => {
    renderTaskCard({
      args: { merge: true },
      argsText: '{"merge":true}',
      result: { ok: true },
      status: { type: 'complete' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand details' }));
    expect(screen.getByText(/"merge"/)).toBeInTheDocument();
    expect(screen.getByText(/"ok"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse details' })).toBeInTheDocument();
  });

  it('reads the present-tense verb while the call runs', () => {
    renderTaskCard({
      args: {},
      argsText: '{}',
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    expect(screen.getByText('Updating tasks')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
  });

  // Task 5 review, Important 1: the card used to compute `isRunning ? running
  // : done`, so every settled call — cancelled, errored, or carrying an error
  // result — earned a green Completed while the group headline (which reads
  // `toolStepStateFor`) called the same step Stopped/Failed. One step, one
  // state machine.
  it('reads a cancelled call as Stopped, not Completed', () => {
    renderTaskCard({
      args: {},
      argsText: '{}',
      result: undefined,
      status: { reason: 'cancelled', type: 'incomplete' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Completed' })).not.toBeInTheDocument();
    // Past tense: the call is not running, whatever it settled as.
    expect(screen.getByText('Updated tasks')).toBeInTheDocument();
  });

  it('reads an errored incomplete call as Failed, not Completed', () => {
    renderTaskCard({
      args: {},
      argsText: '{}',
      result: undefined,
      status: { reason: 'error', type: 'incomplete' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Completed' })).not.toBeInTheDocument();
  });

  it('reads a complete call whose result states its own error as Failed', () => {
    renderTaskCard({
      args: {},
      argsText: '{}',
      result: { error: 'boom' },
      status: { type: 'complete' },
      toolCallId: 'tasks-1',
      toolName: 'brainstrike.manageTaskList',
    });
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Completed' })).not.toBeInTheDocument();
  });
});
