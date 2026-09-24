import '@testing-library/jest-dom/vitest';
import { AssistantRuntimeProvider, type ThreadHistoryAdapter } from '@assistant-ui/react';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrainstrikeDataStreamRuntime } from '../data-stream-runtime';
import { FollowUpQueueBridge } from '../follow-up-queue';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import { ThreadScrollFollowProvider } from '../thread-scroll-follow';
import { useAssistantServerRunSession } from '../use-assistant-server-run-session';

const THREAD = 'thread-reload-first-turn';
const RESOURCE = 'resource-reload';
const API = 'http://127.0.0.1:43110/assistant';

function stream(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'assistant');
  window.sessionStorage.clear();
  resetFollowUpQueueStore();
});

it('rebuilds an unsaved first turn in a new window, then sends Next Up after replay finishes', async () => {
  (window as unknown as { assistant: object }).assistant = {};
  window.sessionStorage.clear();
  resetFollowUpQueueStore();
  const posts: unknown[] = [];
  const replayHeaders: string[] = [];
  let releaseReplay: (() => void) | undefined;
  const replayBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('f:{"messageId":"assistant-old"}\n'));
      controller.enqueue(encoder.encode('0:"Recovered answer"\n'));
      releaseReplay = () => {
        controller.enqueue(
          encoder.encode(
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":2},"path":[]}\n'
          )
        );
        controller.close();
      };
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/assistant/active-run') {
        return new Response(
          JSON.stringify({
            activeRun: {
              assistantMessageId: 'assistant-old',
              eventId: 'session-old:-1',
              inputMessage: {
                id: 'user-old',
                parts: [{ text: 'Original prompt', type: 'text' }],
                role: 'user',
              },
              inputParentMessageId: null,
              parentMessageId: 'user-old',
              runId: 'run-old',
              state: 'active',
            },
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/assistant/resume') {
        replayHeaders.push(new Headers(init?.headers).get('Last-Event-ID') ?? '');
        return new Response(replayBody, { status: 200 });
      }
      if (url.pathname === '/assistant' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as unknown);
        return new Response(
          stream([
            'f:{"messageId":"assistant-next"}',
            '0:"Next answer"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ]),
          {
            headers: {
              'X-Brainstrike-Assistant-Event-Id': 'session-next:-1',
              'X-Brainstrike-Assistant-Message-Id': 'assistant-next',
            },
            status: 200,
          }
        );
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    })
  );
  const appended: Array<{ message: { id: string }; parentId: string | null }> = [];
  const history: ThreadHistoryAdapter = {
    append: async (item) => {
      appended.push(item);
    },
    load: async () => ({ headId: null, messages: [] }),
  };
  let runtime: ReturnType<typeof useBrainstrikeDataStreamRuntime> | undefined;
  function Harness() {
    const session = useAssistantServerRunSession({
      api: API,
      prepareRequestData: async () => ({ memory: { runId: 'run-next' } }),
      resourceId: RESOURCE,
      threadKey: THREAD,
    });
    const currentRuntime = useBrainstrikeDataStreamRuntime({
      ...(session.activeRunSession && session.replayEligible && !session.isRecovering
        ? { activeRunSession: session.activeRunSession }
        : {}),
      ...(session.discoveredRun ? { discoveredRun: session.discoveredRun } : {}),
      adapters: { history },
      api: API,
      body: async (signal) => ({ data: await session.prepareRequest(signal) }),
      onError: session.onError,
      onFinish: session.onFinish,
      onReplayError: session.onReplayError,
      onResponse: session.onResponse,
      replayRetryToken: session.replayRetryToken,
      ...(session.resumeApi ? { resumeApi: session.resumeApi } : {}),
    });
    useEffect(() => {
      runtime = currentRuntime;
    }, [currentRuntime]);
    return (
      <AssistantRuntimeProvider runtime={currentRuntime}>
        <ThreadScrollFollowProvider>
          <FollowUpQueueBridge
            isReattaching={session.isRecovering || session.activeRunSession !== undefined}
            threadKey={THREAD}
          />
        </ThreadScrollFollowProvider>
      </AssistantRuntimeProvider>
    );
  }
  render(<Harness />);
  await waitFor(() => expect(replayHeaders).toEqual(['session-old:-1']));
  await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(true));
  expect(runtime?.thread.getState().messages.map((item) => item.id)).toEqual([
    'user-old',
    expect.any(String),
  ]);
  act(() => useFollowUpQueueStore.getState().enqueue(followUpQueueKey(THREAD), 'Next Up'));
  expect(posts).toHaveLength(0);
  act(() => releaseReplay?.());
  await waitFor(() => expect(posts).toHaveLength(1));
  expect((posts[0] as { messages: Array<{ id: string }> }).messages.at(-1)?.id).toBeDefined();
  await waitFor(() =>
    expect(runtime?.thread.getState().messages.map((item) => item.id)).toContain('assistant-old')
  );
  const nextUser = runtime?.thread
    .getState()
    .messages.find((item) => item.role === 'user' && item.id !== 'user-old');
  expect(nextUser).toBeDefined();
  await waitFor(() =>
    expect(
      appended.some((item) => item.message.id === nextUser?.id && item.parentId === 'assistant-old')
    ).toBe(true)
  );
  await waitFor(() => expect(runtime?.thread.getState().isRunning).toBe(false));
  expect(replayHeaders).toEqual(['session-old:-1']);
});

it('reattaches approval output onto its paused assistant and preserves repeated text', async () => {
  (window as unknown as { assistant: object }).assistant = {};
  const replayHeaders: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/assistant/active-run') {
        return new Response(
          JSON.stringify({
            activeRun: {
              actionReplay: {
                pausedMessageId: 'assistant-paused',
                pausedParentMessageId: 'user-before',
                prefixContent: [{ text: 'Before approval. ', type: 'text' }],
                syntheticPauseMessageId: 'suspended-approval:native-run:call-1',
              },
              assistantMessageId: 'resume-stream-message',
              eventId: 'session-resume:-1',
              inputMessage: null,
              inputParentMessageId: null,
              runId: 'run-resume',
              state: 'active',
            },
          }),
          { status: 200 }
        );
      }
      if (url.pathname === '/assistant/resume') {
        replayHeaders.push(new Headers(init?.headers).get('Last-Event-ID') ?? '');
        return new Response(
          stream([
            'f:{"messageId":"resume-stream-message"}',
            '0:"Before approval. "',
            '0:"After approval."',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":2},"path":[]}',
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    })
  );
  const history: ThreadHistoryAdapter = {
    append: async () => undefined,
    load: async () => ({
      headId: 'suspended-approval:native-run:call-1',
      messages: [
        {
          message: {
            attachments: [],
            content: [{ text: 'Original prompt', type: 'text' }],
            createdAt: new Date(0),
            id: 'user-before',
            metadata: { custom: {} },
            role: 'user',
          },
          parentId: null,
        },
        {
          message: {
            content: [{ text: 'Before approval. ', type: 'text' }],
            createdAt: new Date(0),
            id: 'assistant-paused',
            metadata: {
              custom: {},
              steps: [],
              unstable_annotations: [],
              unstable_data: [],
              unstable_state: null,
            },
            role: 'assistant',
            status: { reason: 'stop', type: 'complete' },
          },
          parentId: 'user-before',
        },
        {
          message: {
            content: [{ data: {}, name: 'brainstrike.tool-approval', type: 'data' }],
            createdAt: new Date(0),
            id: 'suspended-approval:native-run:call-1',
            metadata: {
              custom: {},
              steps: [],
              unstable_annotations: [],
              unstable_data: [],
              unstable_state: null,
            },
            role: 'assistant',
            status: { reason: 'stop', type: 'complete' },
          },
          parentId: 'assistant-paused',
        },
      ],
    }),
  };
  let runtime: ReturnType<typeof useBrainstrikeDataStreamRuntime> | undefined;
  function Harness() {
    const session = useAssistantServerRunSession({
      api: API,
      resourceId: RESOURCE,
      threadKey: THREAD,
    });
    const currentRuntime = useBrainstrikeDataStreamRuntime({
      ...(session.activeRunSession && session.replayEligible && !session.isRecovering
        ? { activeRunSession: session.activeRunSession }
        : {}),
      ...(session.discoveredRun ? { discoveredRun: session.discoveredRun } : {}),
      adapters: { history },
      api: API,
      onError: session.onError,
      onFinish: session.onFinish,
      onReplayError: session.onReplayError,
      onResponse: session.onResponse,
      replayRetryToken: session.replayRetryToken,
      ...(session.resumeApi ? { resumeApi: session.resumeApi } : {}),
    });
    useEffect(() => {
      runtime = currentRuntime;
    }, [currentRuntime]);
    return <AssistantRuntimeProvider runtime={currentRuntime} />;
  }
  render(<Harness />);

  await waitFor(() => expect(replayHeaders).toEqual(['session-resume:-1']));
  await waitFor(() =>
    expect(runtime?.thread.getState().messages.at(-1)?.id).toBe('assistant-paused')
  );
  const messages = runtime?.thread.getState().messages ?? [];
  expect(messages.map((item) => item.id)).toEqual(['user-before', 'assistant-paused']);
  expect(
    messages
      .at(-1)
      ?.content.map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
  ).toBe('Before approval. Before approval. After approval.');
});
