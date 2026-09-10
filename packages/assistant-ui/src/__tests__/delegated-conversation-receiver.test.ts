import type { ThreadMessage } from '@assistant-ui/react';
import type {
  DelegatedConversationBaseline,
  DelegatedConversationStreamData,
} from '@brainstrike/assistant-contract';
import { DELEGATED_CONVERSATION_DATA_NAME } from '@brainstrike/assistant-contract';
import type { AssistantMessage } from 'assistant-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';
import type { DelegatedConversationUpdate } from '../delegated-conversation-receiver';

const finish = {
  code: 'd',
  value: { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
};
const frame = (code: string, value: unknown): string => `${code}:${JSON.stringify(value)}\n`;
function child(
  id: string,
  frames: DelegatedConversationStreamData['frames'],
  messageId = `native-${id}`,
  baseline?: DelegatedConversationBaseline
): string {
  return frame('aui-data', {
    data: {
      ...(baseline ? { baseline } : {}),
      frames,
      identity: {
        childRuntimeRunId: id,
        parentRuntimeRunId: 'parent-run',
        parentToolCallId: `parent-call-${id}`,
        personaId: 'explorer',
      },
      messageId,
    },
    name: DELEGATED_CONVERSATION_DATA_NAME,
  });
}
function options(): Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0] {
  return {
    abortSignal: new AbortController().signal,
    context: { callSettings: {}, config: {}, tools: {} },
    messages: [],
    runConfig: {},
    unstable_getMessage: () =>
      ({
        content: [],
        id: 'parent-message',
        metadata: { custom: {} },
        role: 'assistant',
      }) as unknown as ThreadMessage,
  } as Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0];
}
function serve(lines: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new TextEncoder().encode(lines.join(''))))
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('delegated conversations through the normal runtime adapter', () => {
  it('rejects a history row whose content disappeared at the JSON boundary', async () => {
    const baseline = {
      hostRunId: 'host',
      messages: [
        { content: undefined, createdAt: '2026-09-10T00:00:00.000Z', id: 'saved', role: 'user' },
      ],
      runEvents: [],
      threadId: 'child',
    };
    serve([
      frame('f', { messageId: 'parent-message' }),
      child('a', [{ code: 'f', value: { messageId: 'native-a' } }, finish], 'native-a', baseline),
      frame(finish.code, finish.value),
    ]);
    await expect(
      consume(
        new BrainstrikeDataStreamRuntimeAdapter({
          api: 'http://assistant.test',
          onDelegatedConversation: vi.fn(),
        })
      )
    ).rejects.toThrow(/content/i);
  });

  it.each(['duplicate', 'late'] as const)(
    'rejects a %s baseline instead of replacing an already published history boundary',
    async (mode) => {
      const baseline = { hostRunId: 'host', messages: [], runEvents: [], threadId: 'child' };
      serve([
        frame('f', { messageId: 'parent-message' }),
        child(
          'a',
          [
            { code: 'f', value: { messageId: 'native-a' } },
            { code: '0', value: 'Already published' },
          ],
          'native-a',
          mode === 'duplicate' ? baseline : undefined
        ),
        child('a', [finish], 'native-a', baseline),
        frame(finish.code, finish.value),
      ]);
      const adapter = new BrainstrikeDataStreamRuntimeAdapter({
        api: '/test',
        onDelegatedConversation: vi.fn(),
      });
      await expect(async () => {
        for await (const _ of adapter.run(options())) {
          /* Drain the real decoder. */
        }
      }).rejects.toThrow(/baseline/i);
    }
  );

  it('keeps concurrent children and open tool input separate across observed native message changes', async () => {
    const children = new Map<string, { message: AssistantMessage; messageId: string }>();
    serve([
      frame('f', { messageId: 'parent-message' }),
      frame('0', 'Parent before.'),
      child('a', [
        { code: 'f', value: { messageId: 'native-a' } },
        { code: '0', value: 'A before.' },
      ]),
      child('b', [
        { code: 'f', value: { messageId: 'native-b' } },
        { code: '0', value: 'B answer.' },
      ]),
      child('a', [
        { code: 'g', value: 'A reasoning.' },
        { code: 'b', value: { toolCallId: 'same-tool', toolName: 'grep' } },
        { code: 'c', value: { argsTextDelta: '{"pattern":', toolCallId: 'same-tool' } },
      ]),
      child('b', [
        { code: '9', value: { args: { pattern: 'b' }, toolCallId: 'same-tool', toolName: 'grep' } },
        { code: 'a', value: { result: { matches: ['B'] }, toolCallId: 'same-tool' } },
        finish,
      ]),
      child(
        'a',
        [
          { code: 'c', value: { argsTextDelta: '"a"}', toolCallId: 'same-tool' } },
          {
            code: '9',
            value: { args: { pattern: 'a' }, toolCallId: 'same-tool', toolName: 'grep' },
          },
          { code: 'a', value: { result: { matches: ['A'] }, toolCallId: 'same-tool' } },
          { code: '0', value: 'A final.' },
          finish,
        ],
        'native-a-resumed'
      ),
      frame('0', 'Parent final.'),
      frame(finish.code, finish.value),
    ]);
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test',
      onDelegatedConversation: (update) => children.set(update.identity.childRuntimeRunId, update),
    });
    let parent: AssistantMessage | undefined;
    for await (const message of adapter.run(options())) {
      parent = message as AssistantMessage;
    }
    expect([...children.keys()].sort()).toEqual(['a', 'b']);
    expect(children.get('a')?.messageId).toBe('native-a-resumed');
    expect(children.get('a')?.message.parts.map((part) => part.type)).toEqual([
      'text',
      'reasoning',
      'tool-call',
      'text',
    ]);
    for (const id of ['a', 'b']) {
      expect(children.get(id)?.message.parts).toContainEqual(
        expect.objectContaining({
          args: expect.objectContaining({ pattern: id }),
          result: { matches: [id.toUpperCase()] },
          toolCallId: 'same-tool',
          type: 'tool-call',
        })
      );
      expect(children.get(id)?.message.status.type).toBe('complete');
    }
    expect(
      parent?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    ).toBe('Parent before.Parent final.');
  });
});

async function consume(adapter: BrainstrikeDataStreamRuntimeAdapter): Promise<void> {
  for await (const _message of adapter.run(options())) {
    // Exercise the complete production adapter lifecycle.
  }
}

describe('delegated receiver settlement and replay', () => {
  it('routes a descendant carried inside a child through the same conversation decoder', async () => {
    const updates = new Map<string, DelegatedConversationUpdate>();
    const nested = JSON.parse(
      child('grandchild', [
        { code: 'f', value: { messageId: 'native-grandchild' } },
        { code: '0', value: 'Nested answer.' },
        finish,
      ]).slice('aui-data:'.length)
    );
    serve([
      frame('f', { messageId: 'root' }),
      child('a', [
        { code: 'f', value: { messageId: 'native-a' } },
        { code: 'aui-data', value: nested },
        { code: '0', value: 'Child answer.' },
        finish,
      ]),
      frame(finish.code, finish.value),
    ]);
    await consume(
      new BrainstrikeDataStreamRuntimeAdapter({
        api: 'http://assistant.test',
        onDelegatedConversation: (update) => updates.set(update.identity.childRuntimeRunId, update),
      })
    );
    expect(updates.get('grandchild')?.message.parts).toContainEqual(
      expect.objectContaining({ text: 'Nested answer.', type: 'text' })
    );
    expect(
      updates
        .get('a')
        ?.message.parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
    ).toEqual(['Child answer.']);
  });

  it('fails visibly and preserves partial child content when the parent ends without a child terminal', async () => {
    const updates: DelegatedConversationUpdate[] = [];
    serve([
      frame('f', { messageId: 'root' }),
      child('a', [
        { code: 'f', value: { messageId: 'native-a' } },
        { code: '0', value: 'Partial answer.' },
      ]),
      frame(finish.code, finish.value),
    ]);
    const onError = vi.fn();
    await expect(
      consume(
        new BrainstrikeDataStreamRuntimeAdapter({
          api: 'http://assistant.test',
          onDelegatedConversation: (update) => updates.push(update),
          onError,
        })
      )
    ).rejects.toThrow('delegated conversation terminal');
    expect(onError).toHaveBeenCalledOnce();
    expect(updates.at(-1)?.message.status).toMatchObject({ reason: 'error', type: 'incomplete' });
    expect(updates.at(-1)?.message.parts).toContainEqual(
      expect.objectContaining({ text: 'Partial answer.', type: 'text' })
    );
  });

  it('replaces invocation snapshots during replay without duplicating text or starting a new model request', async () => {
    const updates = new Map<string, DelegatedConversationUpdate>();
    const lines = [
      frame('f', { messageId: 'root' }),
      child('a', [
        { code: 'f', value: { messageId: 'native-a' } },
        { code: '0', value: 'Saved answer.' },
        finish,
      ]),
      frame(finish.code, finish.value),
    ];
    serve(lines);
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test',
      onDelegatedConversation: (update) => updates.set(update.identity.childRuntimeRunId, update),
    });
    await consume(adapter);
    for await (const _message of adapter.resume(options(), {
      eventId: 'session:-1',
      resumeApi: 'http://assistant.test/resume',
    })) {
      // Replay uses a fresh decoder, replacing snapshots for the same invocation.
    }
    expect(updates.size).toBe(1);
    expect(
      updates
        .get('a')
        ?.message.parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
    ).toEqual(['Saved answer.']);
    expect(fetch).toHaveBeenLastCalledWith(
      'http://assistant.test/resume',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('keeps an ordinary child error in that child while the parent completes', async () => {
    const updates: DelegatedConversationUpdate[] = [];
    serve([
      frame('f', { messageId: 'root' }),
      child('a', [
        { code: 'f', value: { messageId: 'native-a' } },
        { code: '0', value: 'Partial.' },
        { code: '3', value: 'Child tool failed' },
        { code: 'd', value: { ...finish.value, finishReason: 'error' } },
      ]),
      frame('0', 'Parent recovers.'),
      frame(finish.code, finish.value),
    ]);
    const onError = vi.fn();
    await consume(
      new BrainstrikeDataStreamRuntimeAdapter({
        api: 'http://assistant.test',
        onDelegatedConversation: (update) => updates.push(update),
        onError,
      })
    );
    expect(updates.at(-1)?.message.status).toMatchObject({ reason: 'error', type: 'incomplete' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects malformed envelopes without silently losing a child', async () => {
    serve([
      frame('f', { messageId: 'root' }),
      frame('aui-data', { data: { identity: {} }, name: DELEGATED_CONVERSATION_DATA_NAME }),
      frame(finish.code, finish.value),
    ]);
    await expect(
      consume(
        new BrainstrikeDataStreamRuntimeAdapter({
          api: 'http://assistant.test',
          onDelegatedConversation: vi.fn(),
        })
      )
    ).rejects.toThrow('Invalid delegated conversation');
  });
});

it('delivers partial child snapshots before the parent ends and settles children on a transport fault', async () => {
  const updates: DelegatedConversationUpdate[] = [];
  const fault = new Error('Disconnected before child terminal');
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(
        new TextEncoder().encode(
          frame('f', { messageId: 'root' }) +
            child('a', [
              { code: 'f', value: { messageId: 'native-a' } },
              { code: '0', value: 'Still working.' },
              { code: 'b', value: { toolCallId: 'open-call', toolName: 'grep' } },
              { code: 'c', value: { argsTextDelta: '{"pattern":', toolCallId: 'open-call' } },
            ])
        )
      );
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body))
  );
  let signaled = false;
  let observedStatus: string | undefined;
  const adapter = new BrainstrikeDataStreamRuntimeAdapter({
    api: 'http://assistant.test',
    onDelegatedConversation: (update) => {
      updates.push(update);
      if (
        !signaled &&
        update.message.parts.some(
          (part) => part.type === 'tool-call' && part.argsText === '{"pattern":'
        )
      ) {
        signaled = true;
        observedStatus = update.message.status.type;
        source?.error(fault);
      }
    },
  });
  await expect(consume(adapter)).rejects.toBe(fault);
  expect(signaled).toBe(true);
  expect(observedStatus).toBe('running');
  expect(updates.at(-1)?.message.status).toMatchObject({ reason: 'error', type: 'incomplete' });
});

it('stops child publication on cancellation while draining the ordinary decoder', async () => {
  const abort = new AbortController();
  const reason = new DOMException('User stopped the run', 'AbortError');
  const updates: DelegatedConversationUpdate[] = [];
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(
        new TextEncoder().encode(
          frame('f', { messageId: 'root' }) +
            child('a', [
              { code: 'f', value: { messageId: 'native-a' } },
              { code: '0', value: 'Partial.' },
              { code: 'b', value: { toolCallId: 'open-call', toolName: 'grep' } },
              { code: 'c', value: { argsTextDelta: '{"pattern":', toolCallId: 'open-call' } },
            ])
        )
      );
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body))
  );
  const adapter = new BrainstrikeDataStreamRuntimeAdapter({
    api: 'http://assistant.test',
    onDelegatedConversation: (update) => {
      updates.push(update);
      if (
        update.message.parts.some(
          (part) => part.type === 'tool-call' && part.argsText === '{"pattern":'
        )
      ) {
        abort.abort(reason);
        source?.enqueue(
          new TextEncoder().encode(child('a', [{ code: '0', value: 'Late answer.' }, finish]))
        );
        source?.close();
      }
    },
  });
  const run = async (): Promise<void> => {
    for await (const _message of adapter.run({ ...options(), abortSignal: abort.signal })) {
      // Cancellation must not publish later child frames during drain.
    }
  };
  await expect(run()).rejects.toBe(reason);
  expect(
    updates
      .at(-1)
      ?.message.parts.filter((part) => part.type === 'text')
      .map((part) => part.text)
  ).toEqual(['Partial.']);
});

it.each(['missing', 'mismatched'] as const)(
  'rejects %s native opening frames on replay',
  async (kind) => {
    const opening =
      kind === 'missing'
        ? { code: '0', value: 'Unseeded suffix.' }
        : { code: 'f', value: { messageId: 'wrong-native-id' } };
    serve([
      frame('f', { messageId: 'root' }),
      child('a', [opening, finish]),
      frame(finish.code, finish.value),
    ]);
    await expect(
      consume(
        new BrainstrikeDataStreamRuntimeAdapter({
          api: 'http://assistant.test',
          onDelegatedConversation: vi.fn(),
        })
      )
    ).rejects.toThrow('native opening frame');
  }
);

it.each(['text', 'reasoning', 'tool'] as const)(
  'publishes child completion only after the final %s part settles',
  async (kind) => {
    const content =
      kind === 'tool'
        ? [
            { code: '9', value: { args: {}, toolCallId: 'call', toolName: 'grep' } },
            { code: 'a', value: { result: 'result', toolCallId: 'call' } },
          ]
        : [{ code: kind === 'text' ? '0' : 'g', value: 'Final part.' }];
    serve([
      frame('f', { messageId: 'root' }),
      child('a', [{ code: 'f', value: { messageId: 'native-a' } }, ...content, finish]),
      frame(finish.code, finish.value),
    ]);
    const completed: AssistantMessage[] = [];
    await consume(
      new BrainstrikeDataStreamRuntimeAdapter({
        api: 'http://assistant.test',
        onDelegatedConversation: ({ message }) => {
          if (message.status.type === 'complete') {
            completed.push(message);
          }
        },
      })
    );
    expect(completed.length).toBeGreaterThan(0);
    for (const message of completed) {
      expect(message.parts).toHaveLength(1);
      expect(message.parts[0]).toMatchObject({ status: { type: 'complete' } });
      if (kind === 'tool') {
        expect(message.parts[0]).toMatchObject({ result: 'result' });
      }
    }
  }
);

it('never publishes parent completion before discovering an unfinished child', async () => {
  serve([
    frame('f', { messageId: 'root' }),
    child('a', [
      { code: 'f', value: { messageId: 'native-a' } },
      { code: '0', value: 'Partial.' },
    ]),
    frame(finish.code, finish.value),
  ]);
  const completed: unknown[] = [];
  const adapter = new BrainstrikeDataStreamRuntimeAdapter({
    api: 'http://assistant.test',
    onDelegatedConversation: vi.fn(),
  });
  const run = async (): Promise<void> => {
    for await (const message of adapter.run(options())) {
      if (message.status?.type === 'complete') {
        completed.push(message);
      }
    }
  };
  await expect(run()).rejects.toThrow('delegated conversation terminal');
  expect(completed).toEqual([]);
});

it.each(['transport', 'envelope'] as const)(
  'preserves the primary %s error when child settlement also fails',
  async (kind) => {
    const fault = new Error('Primary transport failure');
    const cleanup = new Error('Secondary observer failure');
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(
          new TextEncoder().encode(
            frame('f', { messageId: 'root' }) +
              child('a', [
                { code: 'f', value: { messageId: 'native-a' } },
                { code: '0', value: 'Partial.' },
              ])
          )
        );
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );
    let interrupted = false;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test',
      onDelegatedConversation: ({ message }) => {
        if (message.status.type === 'incomplete') {
          throw cleanup;
        }
        if (
          !interrupted &&
          message.parts.some((part) => part.type === 'text' && part.text === 'Partial.')
        ) {
          interrupted = true;
          if (kind === 'transport') {
            source?.error(fault);
          } else {
            source?.enqueue(
              new TextEncoder().encode(
                frame('aui-data', { data: {}, name: DELEGATED_CONVERSATION_DATA_NAME })
              )
            );
            source?.close();
          }
        }
      },
    });
    if (kind === 'transport') {
      await expect(consume(adapter)).rejects.toBe(fault);
    } else {
      await expect(consume(adapter)).rejects.toThrow('Invalid delegated conversation identity');
    }
  }
);

it('rejects a truncated child error without its required finish frame', async () => {
  serve([
    frame('f', { messageId: 'root' }),
    child('a', [
      { code: 'f', value: { messageId: 'native-a' } },
      { code: '3', value: 'Child failed' },
    ]),
    frame(finish.code, finish.value),
  ]);
  await expect(
    consume(
      new BrainstrikeDataStreamRuntimeAdapter({
        api: 'http://assistant.test',
        onDelegatedConversation: vi.fn(),
      })
    )
  ).rejects.toThrow('delegated conversation terminal');
});

it('preserves the first child observer failure when its decoder also fails', async () => {
  const primary = new Error('observer-primary');
  serve([
    frame('f', { messageId: 'root' }),
    child('a', [
      { code: 'f', value: { messageId: 'native-a' } },
      { code: '0', value: 'Partial.' },
      { code: 'x', value: 'invalid-frame' },
      finish,
    ]),
    frame(finish.code, finish.value),
  ]);
  const observer = vi.fn(() => {
    throw primary;
  });
  const adapter = new BrainstrikeDataStreamRuntimeAdapter({
    api: 'http://assistant.test',
    onDelegatedConversation: observer,
  });
  const run = async () => {
    for await (const _message of adapter.run(options())) {
      /* drain */
    }
  };
  await expect(run()).rejects.toBe(primary);
  expect(observer).toHaveBeenCalled();
});
