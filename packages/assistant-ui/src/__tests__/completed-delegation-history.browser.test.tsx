import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';
import { Harness } from './assistant-activity-timeline-fixtures';

// Controlled public decoder sequence using the recorded two-child identity
// shape. This is not an exact wire replay and contains no captured content.
const nativeRun = 'native-root-generation';
function request(call: string, leaf: string, host: string) {
  return {
    args: { path: `${leaf}.json` },
    delegation: {
      path: [
        {
          childRuntimeRunId: `child-${call}`,
          parentRuntimeRunId: nativeRun,
          parentToolCallId: call,
          personaId: 'explore',
        },
      ],
      toolCallId: leaf,
    },
    hostRunId: host,
    riskCategory: 'read',
    runId: nativeRun,
    timelineRunId: host,
    toolCallId: call,
    toolName: 'brainstrike.readWorkspaceFile',
  };
}
function event(kind: string, call: string, host: string, generation = nativeRun) {
  return `aui-data:${JSON.stringify({ data: { id: `${kind}-${call}-${host}`, kind, label: kind, metadata: { parentRuntimeRunId: generation, parentToolCallId: call, personaId: 'explore', toolCallId: call, toolName: 'agent-explore' }, runId: host, status: kind === 'subagent.finished' ? 'completed' : 'running', timestamp: '2026-10-01T00:33:45Z' }, name: 'brainstrike.run-event' })}`;
}
function tool(call: string, result?: unknown): string[] {
  return [
    `b:${JSON.stringify({ toolCallId: call, toolName: 'agent-explore' })}`,
    `9:${JSON.stringify({ args: { prompt: 'Read the explicitly named file.' }, toolCallId: call, toolName: 'agent-explore' })}`,
    ...(result === undefined ? [] : [`a:${JSON.stringify({ result, toolCallId: call })}`]),
  ];
}
const first = request('delegate-one', 'read-one', 'host-initial');
const data = (name: string, value: unknown) => `aui-data:${JSON.stringify({ data: value, name })}`;
const finish = (reason: string) =>
  `d:${JSON.stringify({ finishReason: reason, path: [], usage: { inputTokens: 1, outputTokens: 1 } })}`;
function stream(message: string, frames: string[]): Response {
  const encoder = new TextEncoder();
  const wire = [`f:${JSON.stringify({ messageId: message })}`, ...frames, ''];
  let position = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const frame = wire[position++];
        if (frame === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${frame}\n`));
        // Different transport reads exercise tool→owner-event→pause status changes.
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      },
    })
  );
}

test.each([2, 8])(
  'exact native delegation completion settles paused aliases after %i decoded approvals',
  async (count) => {
    const requests = Array.from({ length: count }, (_, index) =>
      request(index < count / 2 ? 'delegate-one' : 'delegate-two', `read-${index}`, `host-${index}`)
    );
    const fetch = vi.fn();
    for (const [index, approval] of requests.entries()) {
      const previous = requests[index - 1];
      fetch.mockResolvedValueOnce(
        stream(`paused-${index}`, [
          ...(previous
            ? [
                data('brainstrike.tool-approval-answered', {
                  ...previous,
                  decision: 'approve',
                  reason: 'user',
                }),
              ]
            : []),
          ...tool('delegate-one'),
          event('subagent.started', 'delegate-one', `host-${index}`),
          ...tool('delegate-two'),
          event('subagent.started', 'delegate-two', `host-${index}`),
          data('brainstrike.tool-approval', approval),
          finish('tool-calls'),
        ])
      );
    }
    const last = requests.at(-1);
    fetch.mockResolvedValueOnce(
      stream('finished', [
        data('brainstrike.tool-approval-answered', {
          ...last,
          decision: 'approve',
          reason: 'user',
        }),
        ...tool('delegate-one', { text: 'First child fact.' }),
        event('subagent.finished', 'delegate-one', 'host-final'),
        ...tool('delegate-two', { text: 'Second child fact.' }),
        event('subagent.finished', 'delegate-two', 'host-final'),
        '0:"Both children completed."',
        finish('stop'),
      ])
    );
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
      await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Read two files.');
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      const original = screen.getAllByTestId('timeline')[0];
      if (!original) {
        throw new Error('Original delegation message missing.');
      }
      for (let index = 0; index < count; index += 1) {
        const pending = await screen.findByRole('button', { name: `Approve ${first.toolName}` });
        expect(pending).toBeEnabled();
        expect(original.querySelector('[data-live="true"]')).not.toBeNull();
        // The fixture dispatches idle decisions. A click before stream close
        // would correctly queue into a follow-up executor this harness omits.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled());
        await userEvent.click(pending);
      }
      await screen.findByText('Both children completed.');
      await waitFor(() =>
        expect(
          within(original).queryAllByRole('img', { hidden: true, name: 'Waiting for approval' })
        ).toHaveLength(0)
      );
      expect(original.querySelector('[data-live="true"]')).toBeNull();
      expect(document.querySelector('.bs-thinking-shimmer')).toBeNull();
      expect(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY &&
              animation.playState === 'running'
          )
      ).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(count + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  }
);

test.each([
  'foreign-generation',
  'missing-owner',
  'conflicting-owner',
  'foreign-tool',
  'failed-finish',
  'active-execution',
])('a %s cannot settle another paused native invocation', async (control) => {
  const run = vi.fn(async () => {
    throw new Error('This control must not start a model.');
  });
  const call = {
    args: {},
    argsText: '{}',
    toolCallId: 'delegate-one',
    toolName: 'agent-explore',
    type: 'tool-call' as const,
  };
  const part = (
    kind: string,
    generation: string,
    toolName = 'agent-explore',
    status = 'completed'
  ) => ({
    data: {
      id: `${kind}-${generation}`,
      kind,
      label: kind,
      metadata: {
        parentRuntimeRunId: generation,
        parentToolCallId: call.toolCallId,
        personaId: 'explore',
        toolName,
      },
      runId: 'foreign-host-leg',
      status,
      timestamp: '2026-10-01T00:33:45Z',
    },
    name: 'brainstrike.run-event' as const,
    type: 'data' as const,
  });
  await act(async () => {
    render(
      <Harness
        adapter={{ run }}
        initialMessages={[
          {
            content: [
              call,
              ...(control === 'missing-owner'
                ? []
                : [part('subagent.started', nativeRun, 'agent-explore', 'running')]),
              ...(control === 'conflicting-owner'
                ? [part('subagent.started', 'other-generation', 'agent-explore', 'running')]
                : []),
            ],
            role: 'assistant',
            status:
              control === 'active-execution'
                ? { type: 'running' }
                : { reason: 'interrupt', type: 'requires-action' },
          },
          {
            content: [
              part(
                'subagent.finished',
                control === 'foreign-generation' ? 'other-generation' : nativeRun,
                control === 'foreign-tool' ? 'agent-analyst' : 'agent-explore',
                control === 'failed-finish' ? 'failed' : 'completed'
              ),
            ],
            role: 'assistant',
            status: { reason: 'stop', type: 'complete' },
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
  });
  const original = screen.getAllByTestId('timeline')[0];
  if (!original) {
    throw new Error('Paused control missing.');
  }
  expect(
    within(original).queryAllByRole('img', {
      hidden: true,
      name: control === 'active-execution' ? 'Running' : 'Waiting for approval',
    }).length
  ).toBeGreaterThan(0);
  expect(original.querySelector('[data-live="true"]')).not.toBeNull();
  expect(run).not.toHaveBeenCalled();
});
