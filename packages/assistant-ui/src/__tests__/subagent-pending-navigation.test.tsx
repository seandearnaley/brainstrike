// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
  SubagentInvocationResolverContext,
} from '../subagent-conversation-navigation';
import { Harness } from './assistant-activity-timeline-fixtures';

const adapter = {
  async run() {
    throw new Error('Opening a child must not start inference.');
  },
};
function invocation(run: string): Exclude<ThreadMessageLike['content'], string>[number] {
  return {
    data: {
      id: `${run}:start`,
      kind: 'subagent.started',
      label: 'Worker',
      metadata: { parentRuntimeRunId: run, parentToolCallId: 'reused-call', personaId: 'worker' },
      status: 'running',
      timestamp: '2026-09-11T08:00:00Z',
    },
    name: 'brainstrike.run-event',
    type: 'data',
  };
}
function message(id: string, runs: string[]): ThreadMessageLike {
  return {
    content: [
      {
        args: {},
        argsText: '{}',
        toolCallId: 'reused-call',
        toolName: 'agent-worker',
        type: 'tool-call',
      },
      ...runs.map(invocation),
    ],
    id,
    role: 'assistant',
  };
}
afterEach(cleanup);
it('opens the exact pending invocation when two turns reuse a native tool-call ID', async () => {
  const resolve = vi.fn(
    async ({ parentRuntimeRunId }: { parentRuntimeRunId: string }) => `child-${parentRuntimeRunId}`
  );
  const open = vi.fn();
  render(
    <SubagentConversationNavigationContext value={open}>
      <SubagentInvocationResolverContext value={resolve}>
        <Harness
          adapter={adapter}
          initialMessages={[
            message('earlier', ['run-one']),
            { content: 'Continue', id: 'followup', role: 'user' },
            message('current', ['run-two']),
          ]}
        />
      </SubagentInvocationResolverContext>
    </SubagentConversationNavigationContext>
  );
  const user = userEvent.setup();
  for (const fold of await screen.findAllByTestId('assistant-activity-summary')) {
    if (fold.getAttribute('aria-expanded') === 'false') {
      await user.click(fold);
    }
  }
  const buttons = await screen.findAllByRole('button', { name: 'Open Worker conversation' });
  expect(buttons).toHaveLength(2);
  const first = buttons[0];
  const second = buttons[1];
  if (!(first && second)) {
    throw new Error('Missing sibling cards');
  }
  await user.click(second);
  expect(resolve).toHaveBeenLastCalledWith({
    parentRuntimeRunId: 'run-two',
    parentToolCallId: 'reused-call',
  });
  expect(open).toHaveBeenLastCalledWith('child-run-two', second);
  await user.click(first);
  expect(resolve).toHaveBeenLastCalledWith({
    parentRuntimeRunId: 'run-one',
    parentToolCallId: 'reused-call',
  });
});

it('keeps a rejected pending lookup visible and lets the user retry it', async () => {
  const resolve = vi
    .fn<({ parentRuntimeRunId }: { parentRuntimeRunId: string }) => Promise<string>>()
    .mockRejectedValueOnce(new Error('The child invocation is not attached yet.'))
    .mockResolvedValueOnce('child-run-one');
  const open = vi.fn();
  render(
    <SubagentConversationNavigationContext value={open}>
      <SubagentInvocationResolverContext value={resolve}>
        <Harness adapter={adapter} initialMessages={[message('pending', ['run-one'])]} />
      </SubagentInvocationResolverContext>
    </SubagentConversationNavigationContext>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  const button = await screen.findByRole('button', { name: 'Open Worker conversation' });

  await user.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The child invocation is not attached yet.'
  );
  expect(open).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Open Worker conversation' }));
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledWith('child-run-one', button);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('renders a contradictory invocation as a local navigation error without losing the conversation', async () => {
  render(
    <Harness adapter={adapter} initialMessages={[message('conflict', ['run-one', 'run-two'])]} />
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  expect(await screen.findByText('Conflicting native invocation addresses.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

it('renders durable sibling names, roles and tasks through the shared tool renderer', async () => {
  const open = vi.fn();
  const presentation = vi.fn(async (threadId: string) => ({
    displayName: threadId === 'child-one' ? 'Cedar' : 'Flint',
    markClassName: 'text-emerald-500',
  }));
  const named = (id: string, task: string): ThreadMessageLike => ({
    content: [
      {
        args: { prompt: task },
        argsText: JSON.stringify({ prompt: task }),
        result: { subAgentThreadId: id, text: 'Completed' },
        toolCallId: id,
        toolName: 'agent-worker',
        type: 'tool-call',
      },
    ],
    id,
    role: 'assistant',
  });
  render(
    <SubagentConversationNavigationContext value={open}>
      <SubagentConversationPresentationContext value={presentation}>
        <Harness
          adapter={adapter}
          initialMessages={[
            named('child-one', 'Inspect the renderer'),
            { content: 'Next task', id: 'next', role: 'user' },
            named('child-two', 'Inspect the native host'),
          ]}
        />
      </SubagentConversationPresentationContext>
    </SubagentConversationNavigationContext>
  );
  const user = userEvent.setup();
  for (const fold of await screen.findAllByTestId('assistant-activity-summary')) {
    if (fold.getAttribute('aria-expanded') === 'false') {
      await user.click(fold);
    }
  }
  const cedar = await screen.findByRole('button', { name: 'Open Cedar conversation' });
  expect(await screen.findByRole('button', { name: 'Open Flint conversation' })).toBeVisible();
  expect(screen.getByText('Inspect the renderer')).toBeVisible();
  expect(screen.getByText('Inspect the native host')).toBeVisible();
  expect(screen.getAllByText('Worker')).toHaveLength(2);
  await user.click(cedar);
  expect(open).toHaveBeenLastCalledWith('child-one', cedar);
});
