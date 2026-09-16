import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessage,
  type ThreadRuntime,
  useLocalRuntime,
} from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SubagentInvocationIndexProvider } from '../subagent-invocation-index';
import { useSubagentInvocationSnapshot } from '../use-subagent-invocation-snapshot';

const adapter: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({ content: [], status: { reason: 'stop', type: 'complete' } }),
};

function message(
  child: string,
  status: 'complete' | 'running' = 'running',
  outcome?: 'no-answer' | 'rejected',
  metadata?: ThreadMessage['metadata'],
  tail?: string
): ThreadMessage {
  return {
    content: [
      {
        data: {
          id: `started-${child}`,
          kind: 'subagent.tool.started',
          label: 'started',
          metadata: {
            childToolName: 'read',
            parentToolCallId: 'delegation-1',
            toolCallId: child,
          },
          status: 'running',
          timestamp: '2026-09-15T00:00:00.000Z',
        },
        name: ASSISTANT_RUN_EVENT_DATA_NAME,
        type: 'data',
      },
      ...(outcome
        ? [
            {
              data: {
                id: `terminal-${child}`,
                kind: 'subagent.failed',
                label: 'failed',
                metadata: { outcome, parentToolCallId: 'delegation-1' },
                status: 'failed',
                timestamp: '2026-09-15T00:00:01.000Z',
              },
              name: ASSISTANT_RUN_EVENT_DATA_NAME,
              type: 'data' as const,
            },
          ]
        : []),
      ...(tail ? [{ text: tail, type: 'text' as const }] : []),
    ],
    createdAt: new Date(0),
    id: 'assistant-1',
    metadata:
      metadata ??
      ({
        custom: {},
        steps: [],
        unstable_annotations: [],
        unstable_data: [],
        unstable_state: null,
      } as ThreadMessage['metadata']),
    role: 'assistant',
    status: status === 'complete' ? { reason: 'stop', type: 'complete' } : { type: 'running' },
  } as ThreadMessage;
}

function Snapshot() {
  const snapshot = useSubagentInvocationSnapshot('delegation-1');
  return (
    <output data-testid="snapshot">
      {snapshot.rows.map((row) => `${row.key}:${row.status}`).join(',')}|{snapshot.outcome ?? ''}
    </output>
  );
}

function Harness({
  initialMessage,
  onRuntime,
}: {
  readonly initialMessage: ThreadMessage;
  readonly onRuntime: (runtime: ThreadRuntime) => void;
}) {
  const runtime = useLocalRuntime(adapter, { initialMessages: [initialMessage] });
  useEffect(() => onRuntime(runtime.thread), [onRuntime, runtime.thread]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SubagentInvocationIndexProvider>
        <Snapshot />
      </SubagentInvocationIndexProvider>
    </AssistantRuntimeProvider>
  );
}

describe('SubagentInvocationIndexProvider', () => {
  it('handles append, settlement, same-id replacement, StrictMode, and unmount cleanly', async () => {
    let runtime: ThreadRuntime | undefined;
    const onRuntime = (next: ThreadRuntime) => {
      runtime = next;
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sharedMetadata = message('metadata-source').metadata;
    const view = render(
      <StrictMode>
        <Harness
          initialMessage={message('child-1', 'complete', 'no-answer', sharedMetadata)}
          onRuntime={onRuntime}
        />
      </StrictMode>
    );
    expect(screen.getByTestId('snapshot')).toHaveTextContent('child-1:interrupted|no-answer');

    act(() =>
      runtime?.append({
        content: [{ text: 'unrelated', type: 'text' }],
        role: 'user',
        startRun: false,
      })
    );
    await waitFor(() => expect(runtime?.getState().messages).toHaveLength(2));
    expect(screen.getByTestId('snapshot')).toHaveTextContent('child-1:interrupted|no-answer');

    act(() =>
      runtime?.reset([message('child-2', 'complete', 'rejected', sharedMetadata, 'appended text')])
    );
    await waitFor(() =>
      expect(screen.getByTestId('snapshot')).toHaveTextContent('child-2:interrupted|rejected')
    );

    act(() =>
      runtime?.reset([
        message('child-3', 'complete', 'no-answer', sharedMetadata, 'mutable text tail'),
      ])
    );
    await waitFor(() =>
      expect(screen.getByTestId('snapshot')).toHaveTextContent('child-3:interrupted|no-answer')
    );

    view.unmount();
    act(() => runtime?.reset([message('child-after-unmount')]));
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('disposes the old store when the runtime changes', async () => {
    let runtime: ThreadRuntime | undefined;
    const onRuntime = (next: ThreadRuntime) => {
      runtime = next;
    };
    const view = render(
      <Harness initialMessage={message('child-first')} key="first" onRuntime={onRuntime} />
    );
    const firstRuntime = runtime;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () =>
      view.rerender(
        <Harness initialMessage={message('child-second')} key="second" onRuntime={onRuntime} />
      )
    );
    expect(screen.getByTestId('snapshot')).toHaveTextContent('child-second:running|');
    act(() => firstRuntime?.reset([message('stale-child')]));
    expect(screen.getByTestId('snapshot')).toHaveTextContent('child-second:running|');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
