import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  MessagePrimitive,
  type PartState,
  type ThreadMessageLike,
  ThreadPrimitive,
  type ThreadRuntime,
  useAuiState,
  useLocalRuntime,
} from '@assistant-ui/react';
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';
import { SubagentInvocationIndexContext } from '../subagent-invocation-index-context';
import {
  completedSubagentInvocationKey,
  createSubagentInvocationIndex,
} from '../subagent-invocation-index-model';
import {
  serializeCompletedSubagentOwners,
  useCompletedSubagentCalls,
} from '../use-completed-subagent-calls';

const model: ChatModelAdapter = {
  async run() {
    throw new Error('History replacement must not invoke a model.');
  },
};
function ownerEvent(generation: string, finished = false) {
  return {
    data: {
      id: `${generation}-${finished}`,
      kind: finished ? 'subagent.finished' : 'subagent.started',
      label: 'Explorer',
      metadata: {
        parentRuntimeRunId: generation,
        parentToolCallId: 'delegate',
        personaId: 'explore',
        toolName: 'agent-explore',
      },
      status: finished ? 'completed' : 'running',
      timestamp: '2026-10-01T00:40:00Z',
    },
    name: 'brainstrike.run-event' as const,
    type: 'data' as const,
  };
}
function paused(generation: string, text: string): ThreadMessageLike {
  return {
    content: [
      {
        args: {},
        argsText: '{}',
        toolCallId: 'delegate',
        toolName: 'agent-explore',
        type: 'tool-call',
      },
      ownerEvent(generation),
      { text, type: 'text' },
    ],
    id: 'paused',
    role: 'assistant',
    status: { reason: 'interrupt', type: 'requires-action' },
  };
}
function completion(generation: string): ThreadMessageLike {
  return {
    content: [ownerEvent(generation, true)],
    id: 'completion',
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' },
  };
}
function Probe() {
  const completed = useCompletedSubagentCalls();
  const id = useAuiState((state) => state.message.id);
  const source = useAuiState((state) =>
    JSON.stringify(
      state.message.parts
        .filter((part) => part.type === 'tool-call')
        .map((part) => ({ hasResult: part.result !== undefined, status: part.status.type }))
    )
  );
  return (
    <MessagePrimitive.Root>
      <output data-testid={`completed-${id}`}>{JSON.stringify([...completed])}</output>
      <output data-testid={`source-${id}`}>{source}</output>
    </MessagePrimitive.Root>
  );
}

it('keeps exact-owner subscriptions stable through public message deltas and releases changed owners', async () => {
  const index = createSubagentInvocationIndex();
  const release = vi.fn();
  const originalSubscribe = index.subscribeCompleted;
  const subscribe = vi.spyOn(index, 'subscribeCompleted').mockImplementation((key, listener) => {
    const unsubscribe = originalSubscribe(key, listener);
    return () => {
      release(key);
      unsubscribe();
    };
  });
  let thread: ThreadRuntime | undefined;
  function Harness() {
    const runtime = useLocalRuntime(model, {
      initialMessages: [paused('native-one', 'delta-0'), completion('native-one')],
    });
    useEffect(() => {
      thread = runtime.thread;
      const advance = () =>
        index.advance(
          runtime.thread.getState().messages.map((message) => ({
            id: message.id,
            parts: message.content,
            status: message.status,
          }))
        );
      const stop = runtime.thread.subscribe(advance);
      advance();
      return stop;
    }, [runtime.thread]);
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <SubagentInvocationIndexContext value={index}>
          <ThreadPrimitive.Messages
            components={{ AssistantMessage: Probe, UserMessage: () => null }}
          />
        </SubagentInvocationIndexContext>
      </AssistantRuntimeProvider>
    );
  }
  const view = render(<Harness />);
  if (!thread) {
    throw new Error('Public thread runtime missing.');
  }
  const activeThread = thread;
  expect(screen.getByTestId('completed-paused')).toHaveTextContent('["delegate"]');
  expect(JSON.parse(screen.getByTestId('source-paused').textContent ?? 'null')).toEqual([
    { hasResult: false, status: 'requires-action' },
  ]);
  expect(subscribe).toHaveBeenCalledTimes(1);
  for (let delta = 1; delta <= 5; delta += 1) {
    await act(async () =>
      activeThread.reset([paused('native-one', `delta-${delta}`), completion('native-one')])
    );
  }
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  // Same public message ID with a different generation must replace ownership.
  await act(async () =>
    activeThread.reset([paused('native-two', 'changed owner'), completion('native-two')])
  );
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(subscribe.mock.calls[1]?.[0]).toBe(
    completedSubagentInvocationKey('native-two', 'delegate', 'agent-explore')
  );
  expect(release).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('completed-paused')).toHaveTextContent('["delegate"]');
  // Replacing completion history removes evidence without churning the owner.
  await act(async () => activeThread.reset([paused('native-two', 'completion removed')]));
  expect(screen.getByTestId('completed-paused')).toHaveTextContent('[]');
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(2);
});

it('observes owner events appended to or replaced in the same public parts array', () => {
  const parts: PartState[] = [
    {
      args: {},
      argsText: '{}',
      status: { reason: 'interrupt', type: 'requires-action' },
      toolCallId: 'delegate',
      toolName: 'agent-explore',
      type: 'tool-call',
    },
  ];
  expect(serializeCompletedSubagentOwners(parts)).toBe('[]');
  parts.push({ ...ownerEvent('native-one'), status: { type: 'complete' } });
  expect(serializeCompletedSubagentOwners(parts)).toBe(
    JSON.stringify([
      ['delegate', completedSubagentInvocationKey('native-one', 'delegate', 'agent-explore')],
    ])
  );
  parts[1] = { ...ownerEvent('native-two'), status: { type: 'complete' } };
  expect(serializeCompletedSubagentOwners(parts)).toBe(
    JSON.stringify([
      ['delegate', completedSubagentInvocationKey('native-two', 'delegate', 'agent-explore')],
    ])
  );
  parts.push({ ...ownerEvent('native-one'), status: { type: 'complete' } });
  expect(serializeCompletedSubagentOwners(parts)).toBe('[]');
});
