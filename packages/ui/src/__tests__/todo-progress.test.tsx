import type { ManageTaskListResult } from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TodoProgress } from '../assistant-ui-panel/todo-progress.js';

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
