// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { act } from '@brainstrike/test-utils/react-act';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SubagentChildRunContext,
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
  type SubagentInvocationAddress,
  SubagentLiveInvocationContext,
} from '../subagent-conversation-navigation';
import { childRunSource, Harness } from './assistant-activity-timeline-fixtures';

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
it('shows a persisted child callsign and color from an authorized live publication before tool completion', async () => {
  let childThreadId: string | undefined;
  const open = vi.fn();
  const listeners = new Set<() => void>();
  const source = {
    getThreadId: vi.fn((identity: { parentRuntimeRunId: string; parentToolCallId: string }) => {
      expect(identity).toEqual({ parentRuntimeRunId: 'run-one', parentToolCallId: 'reused-call' });
      return childThreadId;
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const presentation = vi.fn(async () => ({
    colorId: 'orange',
    displayName: 'Cedar',
    markClassName: 'bg-orange-500',
  }));
  // The owner has not read the new child's log yet.
  const { container } = render(
    <SubagentChildRunContext value={childRunSource()}>
      <SubagentConversationNavigationContext value={open}>
        <SubagentLiveInvocationContext value={source}>
          <SubagentConversationPresentationContext value={presentation}>
            <Harness adapter={adapter} initialMessages={[message('pending', ['run-one'])]} />
          </SubagentConversationPresentationContext>
        </SubagentLiveInvocationContext>
      </SubagentConversationNavigationContext>
    </SubagentChildRunContext>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  expect(screen.queryByText('Delegating to Cedar')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Open .+ conversation$/u })).not.toBeInTheDocument();
  act(() => {
    childThreadId = 'child-run-one';
    for (const listener of listeners) {
      listener();
    }
  });
  expect(await screen.findByText('Delegating to Cedar')).toBeVisible();
  expect(container.querySelector('.bs-subagent-card')).toHaveAttribute(
    'data-agent-color',
    'orange'
  );
  expect(presentation).toHaveBeenCalledWith('child-run-one');
});
it('keeps a later result address that conflicts with the live invocation visible', async () => {
  const presentation = vi.fn(async () => ({
    colorId: 'orange',
    displayName: 'Cedar',
    markClassName: 'bg-orange-500',
  }));
  const settled: ThreadMessageLike = {
    ...message('settled', ['run-one']),
    content: [
      {
        args: {},
        argsText: '{}',
        result: { subAgentThreadId: 'other-child', text: 'Completed' },
        toolCallId: 'reused-call',
        toolName: 'agent-worker',
        type: 'tool-call',
      },
      invocation('run-one'),
    ],
  };
  render(
    <SubagentLiveInvocationContext
      value={{ getThreadId: () => 'child-run-one', subscribe: () => () => undefined }}
    >
      <SubagentConversationPresentationContext value={presentation}>
        <Harness adapter={adapter} initialMessages={[settled]} />
      </SubagentConversationPresentationContext>
    </SubagentLiveInvocationContext>
  );
  await userEvent.setup().click(await screen.findByTestId('assistant-activity-summary'));
  expect(await screen.findByText('Conflicting child conversation addresses.')).toBeVisible();
  expect(presentation).not.toHaveBeenCalled();
});
it('opens the exact pending invocation when two turns reuse a native tool-call ID', async () => {
  const children = new Map([
    ['run-one:reused-call', 'child-run-one'],
    ['run-two:reused-call', 'child-run-two'],
  ]);
  const source = {
    getThreadId: vi.fn(({ parentRuntimeRunId, parentToolCallId }: SubagentInvocationAddress) =>
      children.get(`${parentRuntimeRunId}:${parentToolCallId}`)
    ),
    subscribe: () => () => undefined,
  };
  const open = vi.fn();
  render(
    <SubagentConversationNavigationContext value={open}>
      <SubagentChildRunContext value={childRunSource()}>
        <SubagentLiveInvocationContext value={source}>
          <Harness
            adapter={adapter}
            initialMessages={[
              message('earlier', ['run-one']),
              { content: 'Continue', id: 'followup', role: 'user' },
              message('current', ['run-two']),
            ]}
          />
        </SubagentLiveInvocationContext>
      </SubagentChildRunContext>
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
  expect(source.getThreadId).toHaveBeenCalledWith({
    parentRuntimeRunId: 'run-two',
    parentToolCallId: 'reused-call',
  });
  expect(open).toHaveBeenLastCalledWith('child-run-two', second);
  await user.click(first);
  expect(source.getThreadId).toHaveBeenCalledWith({
    parentRuntimeRunId: 'run-one',
    parentToolCallId: 'reused-call',
  });
  expect(open).toHaveBeenLastCalledWith('child-run-one', first);
});

it('renders a contradictory invocation as a local navigation error without losing the conversation', async () => {
  const open = vi.fn();
  render(
    <SubagentConversationNavigationContext value={open}>
      <Harness adapter={adapter} initialMessages={[message('conflict', ['run-one', 'run-two'])]} />
    </SubagentConversationNavigationContext>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  expect(await screen.findByText('Conflicting native invocation addresses.')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Open Worker conversation' })
  ).not.toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();
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
  const runs = childRunSource({
    'child-one': { status: 'completed', toolCalls: 4 },
    'child-two': { status: 'completed', toolCalls: 7 },
  });
  render(
    <SubagentChildRunContext value={runs}>
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
    </SubagentChildRunContext>
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
