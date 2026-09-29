import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { Harness, runEventPart } from './assistant-activity-timeline-fixtures';

const request = {
  args: { path: 'package.json' },
  riskCategory: 'read' as const,
  runId: 'paused-run',
  toolCallId: 'read-package',
  toolName: 'brainstrike.readWorkspaceFile',
};

test('approving a separate card leaves static history and no stale waiting group', async () => {
  const run = vi.fn(async () => ({
    content: [
      {
        data: { ...request, decision: 'approve', reason: 'user' },
        name: 'brainstrike.tool-approval-answered',
        type: 'data' as const,
      },
      { text: 'The package has been read.', type: 'text' as const },
    ],
  }));
  render(
    <Harness
      adapter={{ run }}
      initialMessages={[
        {
          content: [
            {
              args: request.args,
              argsText: JSON.stringify(request.args),
              toolCallId: request.toolCallId,
              toolName: request.toolName,
              type: 'tool-call',
            },
            runEventPart({
              id: 'pause',
              kind: 'tool.approval.requested',
              runId: request.runId,
              timestamp: '2026-09-28T19:03:00Z',
              toolCallId: request.toolCallId,
            }),
          ],
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
        },
        {
          content: [{ data: request, name: 'brainstrike.tool-approval', type: 'data' }],
          role: 'assistant',
        },
      ]}
    >
      {(content) => (
        <AnsweredApprovalsProvider>
          <AssistantDataRendererRegistration />
          {content}
        </AnsweredApprovalsProvider>
      )}
    </Harness>
  );
  await userEvent.click(await screen.findByRole('button', { name: `Approve ${request.toolName}` }));
  await screen.findByText('The package has been read.');
  await waitFor(() =>
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved')
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryAllByText('Waiting for approval')).toHaveLength(0);
  expect(screen.queryByTestId('assistant-activity-group')).toBeNull();
  expect(document.querySelector('[data-live="true"]')).toBeNull();
  expect(document.querySelector('.bs-thinking-shimmer')).toBeNull();
});
