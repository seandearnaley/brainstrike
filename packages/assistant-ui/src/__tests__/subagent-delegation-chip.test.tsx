// @vitest-environment jsdom
/**
 * A collapsed activity group names the subagents it delegated to in its
 * header: each a chip in its family colour that opens its conversation
 * without opening the group.
 */
import '@testing-library/jest-dom/vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SubagentChildRunContext,
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
} from '../subagent-conversation-navigation';
import { childRunSource, Harness } from './assistant-activity-timeline-fixtures';

const adapter = {
  async run() {
    throw new Error('Opening a child must not start inference.');
  },
};

const delegated: ThreadMessageLike = {
  content: [
    {
      args: {},
      argsText: '{}',
      result: { subAgentThreadId: 'child-one', text: 'Completed' },
      toolCallId: 'delegation',
      toolName: 'agent-worker',
      type: 'tool-call',
    },
  ],
  id: 'delegated',
  role: 'assistant',
};

afterEach(cleanup);

it('a collapsed group’s header opens the subagent it delegated to', async () => {
  const open = vi.fn();
  const presentation = vi.fn(async () => ({
    colorId: 'orange',
    displayName: 'Cedar',
    markClassName: 'bg-orange-500',
  }));
  render(
    <SubagentChildRunContext value={childRunSource()}>
      <SubagentConversationNavigationContext value={open}>
        <SubagentConversationPresentationContext value={presentation}>
          <Harness adapter={adapter} initialMessages={[delegated]} />
        </SubagentConversationPresentationContext>
      </SubagentConversationNavigationContext>
    </SubagentChildRunContext>
  );
  const summary = await screen.findByTestId('assistant-activity-summary');
  const chip = await screen.findByRole('button', { name: 'Go to Cedar' });
  expect(chip).toBeVisible();
  expect(chip).toHaveAttribute('data-agent-color', 'orange');

  await userEvent.setup().click(chip);

  expect(open).toHaveBeenCalledWith('child-one', chip);
  expect(summary).toHaveAttribute('aria-expanded', 'false');
});
