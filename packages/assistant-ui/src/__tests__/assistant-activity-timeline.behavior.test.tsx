// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  completedParts,
  completedPartsWithEvents,
  firstParts,
  Harness,
  runEventPart,
  secondReasoning,
  secondTools,
} from './assistant-activity-timeline-fixtures';

function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function expectChronologicalGroups() {
  const groups = screen.getAllByTestId('assistant-activity-group');
  expect(groups).toHaveLength(2);
  const first = groups[0];
  const second = groups[1];
  if (!(first && second)) {
    throw new Error('Expected two activity groups.');
  }
  const text = screen.getByText('I found the issue.');
  expect(first.contains(text)).toBe(false);
  expect(second.contains(text)).toBe(false);
  expect(Boolean(first.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
    true
  );
  expect(Boolean(text.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
    true
  );
  expect(first).toHaveAttribute('data-active', 'false');
  return { first, second };
}

describe('assistant activity chronology through the real runtime', () => {
  it.each([false, true])(
    'settles cancellation without showing success (tools: %s)',
    async (includeTools) => {
      const adapter: ChatModelAdapter = {
        async *run({ abortSignal }) {
          yield { content: [...firstParts, secondReasoning, ...(includeTools ? secondTools : [])] };
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      };
      const user = userEvent.setup();
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('I found the issue.');
      const { first, second } = expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'true');
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(second).toHaveAttribute('data-active', 'false'));
      expect(first).toHaveAttribute('data-active', 'false');
      expect(first).toHaveTextContent('Worked');
      expect(first).not.toHaveTextContent('Stopped');
      expect(second).toHaveTextContent('Stopped');
      expect(second).not.toHaveTextContent('Worked');
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
    }
  );

  it('keeps later reasoning and parallel tools after text without reactivating or remounting earlier groups', async () => {
    const think = deferred();
    const call = deferred();
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: firstParts };
        await think.promise;
        yield { content: [...firstParts, secondReasoning] };
        await call.promise;
        yield { content: [...firstParts, secondReasoning, ...secondTools] };
        await finish.promise;
        yield { content: completedParts };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    try {
      await act(async () => {
        think.release();
      });
      await waitFor(() =>
        expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(2)
      );
      const { first, second } = expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'true');
      await user.click(within(first).getByRole('button', { name: 'Expand activity' }));
      await user.click(within(first).getByRole('button', { name: 'Show thinking' }));
      expect(within(first).getByText('First reasoning segment.')).toBeVisible();
      await act(async () => {
        call.release();
      });
      await waitFor(() => expect(second).toHaveTextContent('linear_list_relations'));
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
      expect(first).not.toHaveTextContent('linear_list_relations');
      await act(async () => {
        finish.release();
      });
      await screen.findByText('Review complete.');
      expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'false');
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
      expect(within(first).getByText('First reasoning segment.')).toBeVisible();
    } finally {
      await act(async () => {
        think.release();
        call.release();
        finish.release();
      });
    }
  }, 20_000);

  it('shows a persisted reasoning-only error as failed', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Must not invoke a model.');
          },
        }}
        initialMessages={[
          {
            content: [secondReasoning],
            role: 'assistant',
            status: { reason: 'error', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Activity failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
    expect(screen.getByTestId('assistant-activity-group')).not.toHaveTextContent('Worked');
  });

  it('marks an explicit tool-result error in only its completed activity group', async () => {
    const content = completedParts.map((part) =>
      part.type === 'tool-call' && part.toolCallId === 'comments'
        ? { ...part, isError: true, result: { error: 'Tool refused.' } }
        : part
    );
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(first).toHaveTextContent('Worked');
    expect(first).toHaveAttribute('data-failed', 'false');
    expect(first).not.toHaveTextContent('failed');
    expect(second).toHaveTextContent('Worked');
    expect(second).toHaveTextContent('1 failed');
    expect(second).toHaveAttribute('data-failed', 'false');
  });

  it('preserves the same order and completed state when hydrated from persisted parts', async () => {
    const event = (toolCallId: string, timestamp: string, kind: string) => ({
      data: {
        id: timestamp,
        kind,
        label: 'tool',
        metadata: { toolCallId },
        status: 'completed',
        timestamp,
      },
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data' as const,
    });
    const events = [
      event('first', '2026-09-05T10:00:00.000Z', 'tool.started'),
      event('first', '2026-09-05T10:00:02.000Z', 'tool.completed'),
      event('comments', '2026-09-05T10:00:10.000Z', 'tool.started'),
      event('comments', '2026-09-05T10:00:14.000Z', 'tool.completed'),
    ];
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: [...completedParts, ...events], role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'false');
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
    expect(within(first).getByText('for 2.0s')).toBeInTheDocument();
    expect(within(second).getByText('for 4.0s')).toBeInTheDocument();
  });

  it('keeps every tool call of a run in ONE group when run events fence each call (field shape)', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: completedPartsWithEvents, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
    expect(within(first).getByText('for 2.0s')).toBeInTheDocument();
    expect(within(second).getByText('for 4.0s')).toBeInTheDocument();
  });

  it('renders a trailing data-only group (run.finished after the final text) bare, not as an empty "0 steps" card', async () => {
    const content = [
      ...completedPartsWithEvents,
      runEventPart({ id: 'e-fin', kind: 'run.finished', timestamp: '2026-09-05T10:00:15.000Z' }),
    ];
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const groups = screen.getAllByTestId('assistant-activity-group');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).not.toHaveTextContent('0 steps');
    }
  });

  it('keeps grouping when run events fence each call LIVE, and settles into one summary', async () => {
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: completedPartsWithEvents.slice(0, 9) };
        await finish.promise;
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    const { second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'true');
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(second).toHaveAttribute('data-active', 'false'));
    expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(2);
    expect(second).toHaveTextContent('2 steps');
  }, 20_000);
});
