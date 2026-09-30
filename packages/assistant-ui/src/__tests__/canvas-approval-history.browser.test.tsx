import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { type ChatModelAdapter, type ThreadMessageLike, useAuiState } from '@assistant-ui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { expect, test, vi } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';
import { Harness, runEventPart } from './assistant-activity-timeline-fixtures';

const request = {
  args: { action: 'create', content: '<main>Review</main>', title: 'Review canvas' },
  hostRunId: 'canvas-host-leg',
  riskCategory: 'edit' as const,
  runId: 'canvas-native-run',
  timelineRunId: 'canvas-host-leg',
  toolCallId: 'canvas-create',
  toolName: 'brainstrike.manageCanvas',
};

function tool(toolCallId: string, toolName: string, result?: unknown) {
  return { args: {}, argsText: '{}', result, toolCallId, toolName, type: 'tool-call' as const };
}

// Sanitized rendering shape of the captured 2026-09-30 canvas pause: reads
// separated by text, a final reasoning/text boundary, then the canvas call.
// Native row d953a21e... ends in state:'call'; the journal supplies the pause.
const pausedContent = [
  { text: 'Inspect the read side.', type: 'reasoning' },
  { text: 'Both candidates check out so far.', type: 'text' },
  tool('read-one', 'brainstrike.readWorkspaceFile', { ok: true }),
  tool('read-two', 'brainstrike.readWorkspaceFile', { ok: true }),
  tool('read-three', 'brainstrike.readWorkspaceFile', { ok: true }),
  { text: 'Verify the remaining path.', type: 'reasoning' },
  { text: 'The remaining read path is verified.', type: 'text' },
  tool('read-four', 'brainstrike.readWorkspaceFile', { ok: true }),
  tool('read-five', 'brainstrike.readWorkspaceFile', { ok: true }),
  { text: 'Check the router.', type: 'reasoning' },
  tool('read-six', 'brainstrike.readWorkspaceFile', { ok: true }),
  { text: 'Prepare the report.', type: 'reasoning' },
  { text: 'Now write the report to the canvas.', type: 'text' },
  {
    ...tool(request.toolCallId, request.toolName),
    args: request.args,
    argsText: JSON.stringify(request.args),
  },
  runEventPart({
    id: 'canvas-start',
    kind: 'tool.started',
    runId: request.timelineRunId,
    status: 'running',
    timestamp: '2026-09-30T02:39:20.342Z',
    toolCallId: request.toolCallId,
  }),
  runEventPart({
    id: 'canvas-pause',
    kind: 'tool.approval.requested',
    runId: request.timelineRunId,
    status: 'running',
    timestamp: '2026-09-30T02:39:22.245Z',
    toolCallId: request.toolCallId,
  }),
  { data: request, name: 'brainstrike.tool-approval' as const, type: 'data' },
] satisfies ThreadMessageLike['content'];

test('decoded canvas pause and acknowledged resume leave static history', async () => {
  const pause = [
    'f:{"messageId":"canvas-paused"}',
    'g:"Prepare the report."',
    '0:"Now write the report to the canvas."',
    `b:${JSON.stringify({ toolCallId: request.toolCallId, toolName: request.toolName })}`,
    `c:${JSON.stringify({ argsTextDelta: JSON.stringify(request.args), toolCallId: request.toolCallId })}`,
    `9:${JSON.stringify({ args: request.args, toolCallId: request.toolCallId, toolName: request.toolName })}`,
    `aui-data:${JSON.stringify({ data: { id: 'pause', kind: 'tool.approval.requested', label: 'Awaiting your approval', metadata: { toolCallId: request.toolCallId }, runId: request.timelineRunId, status: 'running', timestamp: '2026-09-30T02:39:22.245Z' }, name: 'brainstrike.run-event' })}`,
    `aui-data:${JSON.stringify({ data: request, name: 'brainstrike.tool-approval' })}`,
    'd:{"finishReason":"tool-calls","usage":{"inputTokens":0,"outputTokens":0},"path":[]}',
    '',
  ].join('\n');
  const resume = [
    'f:{"messageId":"canvas-resumed"}',
    `aui-data:${JSON.stringify({ data: { ...request, decision: 'approve', reason: 'user' }, name: 'brainstrike.tool-approval-answered' })}`,
    `9:${JSON.stringify({ args: request.args, toolCallId: request.toolCallId, toolName: request.toolName })}`,
    `a:${JSON.stringify({ result: { ok: true }, toolCallId: request.toolCallId })}`,
    '0:"Canvas created."',
    'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
    '',
  ].join('\n');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(pause))
    .mockResolvedValueOnce(new Response(resume));
  vi.stubGlobal('fetch', fetch);
  try {
    render(
      <Harness
        adapter={
          new BrainstrikeDataStreamRuntimeAdapter({ api: 'http://assistant.test/assistant' })
        }
      >
        {(children) => (
          <AnsweredApprovalsProvider>
            <AssistantDataRendererRegistration />
            {children}
          </AnsweredApprovalsProvider>
        )}
      </Harness>
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Create the report.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(
      await screen.findByRole('button', { name: `Approve ${request.toolName}` })
    );
    await screen.findByText('Canvas created.');
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
    expect(screen.queryAllByText('Waiting for approval')).toHaveLength(0);
    expect(document.querySelector('[data-live="true"]')).toBeNull();
    expect(document.querySelector('.bs-thinking-shimmer')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('settled reload content retains the captured reasoning and canvas without live chrome', async () => {
  const run = vi.fn<ChatModelAdapter['run']>(async () => {
    throw new Error('Hydration must not invoke a model.');
  });
  // Hydration completes retained messages and omits the transient approval
  // request/answer parts. A resultless historical call is not a live pause.
  const content = pausedContent.filter(
    (part) => part.type !== 'data' || part.name !== 'brainstrike.tool-approval'
  );
  render(
    <Harness
      adapter={{ run }}
      initialMessages={[
        { content, role: 'assistant', status: { reason: 'stop', type: 'complete' } },
      ]}
    >
      {(children) => (
        <AnsweredApprovalsProvider>
          <AssistantDataRendererRegistration />
          {children}
        </AnsweredApprovalsProvider>
      )}
    </Harness>
  );
  await screen.findByText('Now write the report to the canvas.');
  expectStaticHistory(screen.getByTestId('timeline'));
  expect(screen.getAllByTestId('local-chain-of-thought')).toHaveLength(4);
  expect(screen.queryByTestId('assistant-tool-approval-notice')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

function RuntimeStatusProbe() {
  const statuses = useAuiState((state) =>
    JSON.stringify(
      state.thread.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.status)
    )
  );
  return <output data-testid="runtime-statuses">{statuses}</output>;
}

function expectStaticHistory(timeline: HTMLElement): void {
  expect(within(timeline).queryAllByText('Waiting for approval')).toHaveLength(0);
  expect(timeline.querySelector('[data-live="true"]')).toBeNull();
  expect(timeline.querySelector('.bs-thinking-shimmer')).toBeNull();
  expect(within(timeline).getAllByTestId('assistant-activity-group').length).toBeGreaterThan(0);
  for (const group of within(timeline).getAllByTestId('assistant-activity-group')) {
    expect(group).toHaveAttribute('data-active', 'false');
  }
}

test.each(
  ['completed', 'failed', 'stopped'].flatMap((outcome) =>
    [false, true].map((separateNotice) => ({ outcome, separateNotice }))
  )
)(
  'captured canvas approval stays static after $outcome resume with separate notice: $separateNotice',
  async ({ outcome, separateNotice }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<ChatModelAdapter['run']>(async function* ({ abortSignal }) {
      yield {
        content: [
          {
            data: { ...request, decision: 'approve', reason: 'user' },
            name: 'brainstrike.tool-approval-answered',
            type: 'data' as const,
          },
          tool(request.toolCallId, request.toolName, { ok: true }),
          { text: 'Canvas created.', type: 'text' as const },
          tool('working-memory', 'updateWorkingMemory', { ok: true }),
          { text: 'Continue independent work.', type: 'text' as const },
          tool('running-sibling', 'brainstrike.readWorkspaceFile'),
        ],
      };
      await Promise.race([
        held,
        new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      if (outcome === 'failed') {
        yield {
          status: {
            error: 'Captured terminal observation failure.',
            reason: 'error',
            type: 'incomplete',
          },
        };
      } else if (outcome === 'completed') {
        yield { status: { reason: 'stop', type: 'complete' } };
      }
    });
    render(
      <Harness
        adapter={{ run }}
        initialMessages={[
          {
            content: separateNotice
              ? pausedContent.filter(
                  (part) =>
                    !(
                      part.type === 'data' &&
                      (part.name === 'brainstrike.tool-approval' ||
                        (part.name === 'brainstrike.run-event' &&
                          part.data.kind === 'tool.approval.requested'))
                    )
                )
              : pausedContent,
            role: 'assistant',
            status: { reason: 'interrupt', type: 'requires-action' },
          },
          ...(separateNotice
            ? [
                {
                  content: [
                    { data: request, name: 'brainstrike.tool-approval', type: 'data' as const },
                  ],
                  role: 'assistant' as const,
                },
              ]
            : []),
        ]}
      >
        {(content) => (
          <AnsweredApprovalsProvider>
            <AssistantDataRendererRegistration />
            <RuntimeStatusProbe />
            {content}
          </AnsweredApprovalsProvider>
        )}
      </Harness>
    );
    const pausedTimeline = screen.getAllByTestId('timeline')[0];
    if (!pausedTimeline) {
      throw new Error('Paused timeline missing.');
    }
    if (!separateNotice) {
      expectStaticHistory(pausedTimeline);
    }
    await userEvent.click(
      await screen.findByRole('button', { name: `Approve ${request.toolName}` })
    );
    await screen.findByText('Canvas created.');
    await waitFor(() =>
      expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved')
    );
    expectStaticHistory(pausedTimeline);
    const resumedTimeline = screen.getAllByTestId('timeline').at(-1);
    expect(resumedTimeline).toBeDefined();
    expect(resumedTimeline?.querySelector('[data-live="true"]')).not.toBeNull();
    expect(resumedTimeline?.querySelector('.bs-thinking-shimmer')).not.toBeNull();
    if (outcome === 'stopped') {
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    }
    await act(async () => {
      release?.();
      await held;
    });
    await waitFor(() => expect(document.querySelector('[data-live="true"]')).toBeNull());
    expectStaticHistory(pausedTimeline);
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved');
    const statuses: unknown = JSON.parse(
      screen.getByTestId('runtime-statuses').textContent ?? 'null'
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: outcome === 'completed' ? 'stop' : outcome === 'failed' ? 'error' : 'cancelled',
          type: outcome === 'completed' ? 'complete' : 'incomplete',
        }),
      ])
    );
    expect(run).toHaveBeenCalledTimes(1);
  }
);

test('a reused surface call on another host remains animated beside the addressed canvas history', async () => {
  const run = vi.fn<ChatModelAdapter['run']>(async () => {
    throw new Error('No decision has been submitted.');
  });
  const canvas = pausedContent.filter(
    (part) =>
      !(
        part.type === 'data' &&
        (part.name === 'brainstrike.tool-approval' ||
          (part.name === 'brainstrike.run-event' && part.data.kind === 'tool.approval.requested'))
      )
  );
  render(
    <Harness
      adapter={{ run }}
      initialMessages={[
        {
          content: canvas,
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
        },
        {
          content: [
            tool(request.toolCallId, 'brainstrike.readWorkspaceFile'),
            runEventPart({
              id: 'sibling-start',
              kind: 'tool.started',
              runId: 'other-host-leg',
              status: 'running',
              timestamp: '2026-09-30T02:39:21Z',
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
      {(children) => (
        <AnsweredApprovalsProvider>
          <AssistantDataRendererRegistration />
          {children}
        </AnsweredApprovalsProvider>
      )}
    </Harness>
  );
  await screen.findByRole('button', { name: `Approve ${request.toolName}` });
  const [owned, sibling] = screen.getAllByTestId('timeline');
  if (!(owned && sibling)) {
    throw new Error('Both owners must be rendered.');
  }
  expectStaticHistory(owned);
  expect(within(sibling).getAllByText('Waiting for approval')).not.toHaveLength(0);
  expect(sibling.querySelector('[data-live="true"]')).not.toBeNull();
  expect(sibling.querySelector('.bs-thinking-shimmer')).not.toBeNull();
  expect(run).not.toHaveBeenCalled();
});
