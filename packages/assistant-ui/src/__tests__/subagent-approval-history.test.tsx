// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import {
  type SubagentAnsweredApproval,
  SubagentApprovalHistoryContext,
  SubagentChildRunContext,
} from '../subagent-conversation-navigation';
import { childRunSource, Harness } from './assistant-activity-timeline-fixtures';

const adapter = {
  async run() {
    throw new Error('Showing a child’s history must not start inference.');
  },
};
afterEach(cleanup);

/** The root's background delegation, whose result addresses the child thread. */
const delegation: ThreadMessageLike = {
  content: [
    {
      args: { prompt: 'WORKER_COMMAND_FIRST: run the command.' },
      argsText: '{"prompt":"WORKER_COMMAND_FIRST: run the command."}',
      result: { childThreadId: 'child-1', status: 'started', text: 'Background task started.' },
      toolCallId: 'delegate-1',
      toolName: 'agent-worker',
      type: 'tool-call',
    },
  ],
  id: 'root-message',
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
};

const answered: SubagentAnsweredApproval = {
  args: { command: "printf 'started' > started-first.txt" },
  byPolicy: false,
  decision: 'approve',
  interactionId: 'interaction-1',
  owner: 'Falcon-a53dd3',
  runId: 'child-run-1',
  toolCallId: 'command-1',
  toolName: 'brainstrike.executeCommand',
};

/** The owner's child runs: the background worker is still working. */
const runs = () => childRunSource({ 'child-1': { status: 'running', toolCalls: 2 } });

it('shows a background child’s answered approval in its delegation card, owner-named and locked', async () => {
  render(
    <SubagentChildRunContext value={runs()}>
      <SubagentApprovalHistoryContext
        value={(threadId) => (threadId === 'child-1' ? [answered] : [])}
      >
        <Harness adapter={adapter} initialMessages={[delegation]} />
      </SubagentApprovalHistoryContext>
    </SubagentChildRunContext>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  const notice = await screen.findByTestId('assistant-tool-approval-notice');
  expect(within(notice).getByTestId('approval-delegation-owner')).toHaveTextContent(
    'Falcon-a53dd3'
  );
  expect(within(notice).getByTestId('approval-row-status')).toHaveTextContent('Approved');
  await user.click(within(notice).getByRole('button', { name: /show approval details/i }));
  expect(notice).toHaveTextContent("printf 'started' > started-first.txt");
  expect(
    within(notice).queryByRole('button', { name: 'Approve brainstrike.executeCommand' })
  ).not.toBeInTheDocument();
});

it('names an approval the root’s policy answered as a session grant, and a declined one as declined', async () => {
  render(
    <SubagentChildRunContext value={runs()}>
      <SubagentApprovalHistoryContext
        value={() => [
          { ...answered, byPolicy: true, interactionId: 'interaction-2', toolCallId: 'command-2' },
          {
            ...answered,
            decision: 'deny',
            interactionId: 'interaction-3',
            toolCallId: 'command-3',
          },
        ]}
      >
        <Harness adapter={adapter} initialMessages={[delegation]} />
      </SubagentApprovalHistoryContext>
    </SubagentChildRunContext>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('assistant-activity-summary'));
  const statuses = await screen.findAllByTestId('approval-row-status');
  expect(statuses.map((status) => status.textContent)).toEqual([
    'Allowed by session grant',
    'Declined',
  ]);
});
