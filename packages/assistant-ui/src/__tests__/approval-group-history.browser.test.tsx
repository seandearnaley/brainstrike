import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { Harness, runEventPart } from './assistant-activity-timeline-fixtures';

test.each(['root-host-leg', 'child-host-leg', 'grandchild-host-leg'])(
  'approving a separate card on %s leaves static history and no stale waiting group',
  async (timelineRunId) => {
    const request = {
      args: { path: 'package.json' },
      hostRunId: 'root-host-leg',
      riskCategory: 'read' as const,
      runId: 'native-run',
      timelineRunId,
      toolCallId: 'read-package',
      toolName: 'brainstrike.readWorkspaceFile',
    };
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
                runId: request.timelineRunId,
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
    expect(screen.queryByTestId('assistant-activity-group')).toBeNull();
    expect(screen.queryAllByText('Waiting for approval')).toHaveLength(0);
    await userEvent.click(
      await screen.findByRole('button', { name: `Approve ${request.toolName}` })
    );
    await screen.findByText('The package has been read.');
    await waitFor(() =>
      expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved')
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('Waiting for approval')).toHaveLength(0);
    expect(screen.queryByTestId('assistant-activity-group')).toBeNull();
    expect(document.querySelector('[data-live="true"]')).toBeNull();
    expect(document.querySelector('.bs-thinking-shimmer')).toBeNull();
  }
);

test('a chained approval leaves the answered resume static while the next call executes', async () => {
  const approved = {
    args: { pattern: '**/*.ts' },
    hostRunId: 'host-initial',
    riskCategory: 'read' as const,
    runId: 'native-generation',
    timelineRunId: 'host-initial',
    toolCallId: 'glob-first',
    toolName: 'brainstrike.globWorkspace',
  };
  const pending = {
    ...approved,
    hostRunId: 'host-resumed',
    timelineRunId: 'host-resumed',
    toolCallId: 'glob-second',
  };
  const tool = (request: typeof approved) => ({
    args: request.args,
    argsText: JSON.stringify(request.args),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    type: 'tool-call' as const,
  });
  const start = (request: typeof approved, runId: string) =>
    runEventPart({
      id: `start-${request.toolCallId}-${runId}`,
      kind: 'tool.started',
      runId,
      timestamp: '2026-09-30T15:22:30Z',
      toolCallId: request.toolCallId,
    });
  let finish: (() => void) | undefined;
  let completeTool: (() => void) | undefined;
  const executing = new Promise<void>((resolve) => {
    completeTool = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(async function* () {
    yield {
      content: [
        tool(pending),
        start(pending, 'host-next'),
        {
          data: { ...pending, decision: 'approve', reason: 'user' },
          name: 'brainstrike.tool-approval-answered',
          type: 'data' as const,
        },
      ],
    };
    await executing;
    yield {
      content: [
        { ...tool(approved), result: { files: ['a.ts'] } },
        { ...tool(pending), result: { files: ['b.ts'] } },
        { text: 'Further model work.', type: 'text' as const },
        { text: 'Considering the discovered files.', type: 'reasoning' as const },
      ],
    };
    await blocked;
    yield { content: [{ text: 'Finished.', type: 'text' as const }] };
  });
  render(
    <Harness
      adapter={{ run }}
      initialMessages={[
        {
          content: [
            tool(approved),
            start(approved, approved.timelineRunId),
            { data: approved, name: 'brainstrike.tool-approval', type: 'data' },
          ],
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
        },
        {
          content: [
            tool(approved),
            start(approved, pending.timelineRunId),
            {
              data: { ...approved, decision: 'approve', reason: 'user' },
              name: 'brainstrike.tool-approval-answered',
              type: 'data',
            },
            tool(pending),
            start(pending, pending.timelineRunId),
            { data: pending, name: 'brainstrike.tool-approval', type: 'data' },
          ],
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
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
  const history = screen.getAllByTestId('timeline');
  expect(within(history[1]!).queryByTestId('assistant-activity-group')).toBeNull();
  expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
  const approve = screen.getByRole('button', { name: `Approve ${pending.toolName}` });
  expect(approve).toBeEnabled();
  await userEvent.click(approve);
  await waitFor(() => expect(screen.getAllByTestId('approval-row-status')).toHaveLength(2));
  const executingMessage = screen.getAllByTestId('timeline').at(-1)!;
  expect(within(executingMessage).getByTestId('assistant-activity-group')).toHaveAttribute(
    'data-active',
    'true'
  );
  expect(within(executingMessage).queryByText('Waiting for approval')).toBeNull();
  expect(executingMessage.querySelector('[data-live="true"]')).not.toBeNull();
  // Admission is proven, but no result exists yet: execution stays live.
  await act(async () => {
    completeTool?.();
  });
  await screen.findByText('Further model work.');
  const settledHistory = screen.getAllByTestId('timeline')[1]!;
  expect(settledHistory.isConnected).toBe(true);
  expect(settledHistory.querySelector('[data-live="true"]')).toBeNull();
  expect(settledHistory.querySelector('.bs-thinking-shimmer')).toBeNull();
  expect(screen.queryAllByText('Waiting for approval')).toHaveLength(0);
  expect(
    screen
      .getAllByTestId('assistant-activity-group')
      .some((group) => group.dataset['active'] === 'true')
  ).toBe(true);
  expect(document.querySelector('[data-live="true"]')).not.toBeNull();
  await act(async () => {
    finish?.();
  });
  await screen.findByText('Finished.');
});
