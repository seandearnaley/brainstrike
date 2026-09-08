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

/**
 * PR #3061 review, Finding 1 (narrowed, fix round): `getGroupStatus` mirrors
 * the group's own LAST member part, so a group whose last member is a
 * transparent `tool.completed` run-event (not the message's last PART — a
 * trailing always-visible `run.cancelled`/`run.failed` standalone row follows
 * it) reads "complete" even when a RESULTLESS tool call earlier in the same
 * group carries the message's own `incomplete` status. The fix derives the
 * group's headline from its ACTIVITY parts (reasoning/tool-call) only, never
 * from a transparent data member — and, symmetrically, a group whose activity
 * parts ALL resolved (the tool call has a result) reads "Worked" even on a
 * cancelled/errored message: the standalone `run.*` row carries the run
 * outcome, the activity card reports what the activity itself did.
 */
describe('activity-part-derived group status (BST-1677 wave 3 fix round, PR #3061 finding 1)', () => {
  const neverRun = {
    async run() {
      throw new Error('Hydration must not invoke a model.');
    },
  };

  /**
   * The genuine masking shape: `tool.completed` is a GROUP-transparent data
   * part, but it is followed by an always-visible standalone row
   * (`run.cancelled`/`run.failed`, per `isAlwaysVisibleRunEvent`) that stays
   * OUTSIDE the group. That trailing standalone row means `tool.completed` is
   * no longer the message's own last PART, so the library's own
   * `toMessagePartStatus` no longer falls through to the message status for
   * it — its status resolves to `complete` regardless of the tool call's own
   * outcome. Without a trailing standalone row, `tool.completed` WOULD be the
   * message's last part and would already read the correct status by
   * construction, so this row is what makes the test actually exercise the
   * masking bug rather than passing by coincidence.
   */
  function trailingGroupContent(
    toolCallId: string,
    withResult: boolean,
    trailingKind: 'run.cancelled' | 'run.failed'
  ) {
    return [
      { text: 'Reasoning.', type: 'reasoning' as const },
      runEventPart({
        id: `e-${toolCallId}-s`,
        kind: 'tool.started',
        status: 'running' as const,
        timestamp: '2026-09-05T10:00:00.000Z',
        toolCallId,
      }),
      {
        args: {},
        argsText: '{}',
        ...(withResult ? { result: { ok: true } } : {}),
        toolCallId,
        toolName: `tool_${toolCallId}`,
        type: 'tool-call' as const,
      },
      runEventPart({
        id: `e-${toolCallId}-c`,
        kind: 'tool.completed',
        timestamp: '2026-09-05T10:00:01.000Z',
        toolCallId,
      }),
      runEventPart({
        id: `e-${toolCallId}-r`,
        kind: trailingKind,
        status: trailingKind === 'run.cancelled' ? ('cancelled' as const) : ('failed' as const),
        timestamp: '2026-09-05T10:00:02.000Z',
      }),
    ];
  }

  it('reads "Stopped" (not "Worked") when a resultless tool call is masked by a trailing tool.completed data part, message cancelled', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', false, 'run.cancelled'),
            role: 'assistant',
            status: { reason: 'cancelled', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Stopped');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.queryByText('Worked')).not.toBeInTheDocument();
  });

  it('reads "Activity failed" (not "Worked") when a resultless tool call is masked by a trailing tool.completed data part, message errored', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', false, 'run.failed'),
            role: 'assistant',
            status: { reason: 'error', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Activity failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
    expect(screen.queryByText('Worked')).not.toBeInTheDocument();
  });

  it('reads "Worked" (not "Stopped") when the tool call HAS a result, even though the owning message was cancelled', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', true, 'run.cancelled'),
            role: 'assistant',
            status: { reason: 'cancelled', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Worked');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('two-group message: the resolved group reads "Worked", the unresolved trailing group reads "Stopped"', async () => {
    const content = [
      { text: 'First reasoning.', type: 'reasoning' as const },
      {
        args: {},
        argsText: '{}',
        result: { ok: true },
        toolCallId: 'a',
        toolName: 'tool_a',
        type: 'tool-call' as const,
      },
      runEventPart({
        id: 'e-a-c',
        kind: 'tool.completed',
        timestamp: '2026-09-05T10:00:00.500Z',
        toolCallId: 'a',
      }),
      { text: 'Between.', type: 'text' as const },
      runEventPart({
        id: 'e-b-s',
        kind: 'tool.started',
        status: 'running' as const,
        timestamp: '2026-09-05T10:00:01.000Z',
        toolCallId: 'b',
      }),
      {
        args: {},
        argsText: '{}',
        toolCallId: 'b',
        toolName: 'tool_b',
        type: 'tool-call' as const,
      },
    ];
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          { content, role: 'assistant', status: { reason: 'cancelled', type: 'incomplete' } },
        ]}
      />
    );
    await screen.findByText('Between.');
    const groups = screen.getAllByTestId('assistant-activity-group');
    expect(groups).toHaveLength(2);
    const [groupA, groupB] = groups;
    if (!(groupA && groupB)) {
      throw new Error('Expected two activity groups.');
    }
    expect(within(groupA).getByText('Worked')).toBeInTheDocument();
    expect(within(groupB).getByText('Stopped')).toBeInTheDocument();
  });
});
