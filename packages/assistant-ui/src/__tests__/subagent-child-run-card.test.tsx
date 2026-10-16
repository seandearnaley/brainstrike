// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SubagentChildRunContext } from '../subagent-conversation-navigation';
import { childRunSource, Harness } from './assistant-activity-timeline-fixtures';

const adapter = {
  async run() {
    throw new Error('Showing a child’s state must not start inference.');
  },
};
afterEach(cleanup);

/**
 * The root's background delegation as the host commits it: the call settles at
 * once with the start acknowledgement, which names the child thread.
 */
const delegation: ThreadMessageLike = {
  content: [
    {
      args: { prompt: 'Survey the renderer.' },
      argsText: '{"prompt":"Survey the renderer."}',
      result: {
        childThreadId: 'child-1',
        status: 'started',
        text: 'Background task started. Task ID: child-1.',
      },
      toolCallId: 'delegate-1',
      toolName: 'agent-explore',
      type: 'tool-call',
    },
  ],
  id: 'root-message',
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
};

it('follows the child’s committed run live: working with its count, then finished', async () => {
  const runs = childRunSource({ 'child-1': { status: 'running', toolCalls: 3 } });
  render(
    <SubagentChildRunContext value={runs}>
      <Harness adapter={adapter} initialMessages={[delegation]} />
    </SubagentChildRunContext>
  );
  await userEvent.setup().click(await screen.findByTestId('assistant-activity-summary'));
  const card = await screen.findByTestId('subagent-execution-card');
  expect(within(card).getByText('Explorer is working')).toBeVisible();
  expect(within(card).getByText('· 3 tool calls')).toBeVisible();

  act(() => runs.set('child-1', { status: 'running', toolCalls: 12 }));
  expect(within(card).getByText('· 12 tool calls')).toBeVisible();

  act(() => runs.set('child-1', { status: 'completed', toolCalls: 43 }));
  expect(within(card).getByText('Explorer finished')).toBeVisible();
  expect(within(card).getByText('· 43 tool calls')).toBeVisible();
  expect(within(card).getByRole('img', { name: 'Completed' })).toBeVisible();
});

class Captured extends Component<
  { readonly children: ReactNode; readonly onError: (error: Error) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

it('fails loudly when a card names a child its conversation owner does not follow', async () => {
  const errors: Error[] = [];
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    render(
      <Captured onError={(error) => errors.push(error)}>
        <Harness adapter={adapter} initialMessages={[delegation]} />
      </Captured>
    );
    const summary = screen.queryByTestId('assistant-activity-summary');
    if (summary) {
      await userEvent.setup().click(summary);
    }
    await vi.waitFor(() =>
      expect(errors.map((error) => error.message)).toContain(
        'A delegation card with a child conversation requires SubagentChildRunContext'
      )
    );
  } finally {
    quiet.mockRestore();
  }
});
