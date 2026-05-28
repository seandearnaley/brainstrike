import type { ThreadMessage } from '@assistant-ui/react';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrainstrikeDataStreamRuntimeAdapter,
  extractTransportBodyData,
  selectTransportMessagesForMastraMemory,
} from '../assistant-ui-panel/data-stream-runtime';

function message(id: string, role: ThreadMessage['role']): ThreadMessage {
  return {
    id,
    role,
    content: [{ type: 'text', text: id }],
    createdAt: new Date(0),
    metadata: { custom: {} },
  } as ThreadMessage;
}

function dataStreamFromLines(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

async function readAssistantStreamMessages(lines: readonly string[]): Promise<
  readonly {
    readonly content?: unknown;
    readonly status?: unknown;
  }[]
> {
  const stream = dataStreamFromLines(lines)
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(
      unstable_toolResultStream({}, new AbortController().signal, () => {
        throw new Error('Tool interrupt is not supported in data stream runtime');
      })
    )
    .pipeThrough(new AssistantMessageAccumulator());
  const messages: {
    readonly content?: unknown;
    readonly status?: unknown;
  }[] = [];
  for await (const nextMessage of asAsyncIterableStream(stream)) {
    messages.push(nextMessage);
  }
  return messages;
}

describe('selectTransportMessagesForMastraMemory', () => {
  it('keeps the full transport history when Mastra memory is not active', () => {
    const messages = [
      message('old-user', 'user'),
      message('old-assistant', 'assistant'),
      message('new-user', 'user'),
    ];

    expect(selectTransportMessagesForMastraMemory(messages, { data: {} })).toBe(messages);
  });

  it('sends only system context and the current turn when Mastra memory is active', () => {
    const system = message('system', 'system');
    const oldUser = message('old-user', 'user');
    const oldAssistant = message('old-assistant', 'assistant');
    const currentUser = message('new-user', 'user');
    const messages = [system, oldUser, oldAssistant, currentUser];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([system, currentUser]);
  });

  it('keeps trailing active-turn messages after the latest user message', () => {
    const oldUser = message('old-user', 'user');
    const oldAssistant = message('old-assistant', 'assistant');
    const currentUser = message('new-user', 'user');
    const activeAssistant = message('active-assistant', 'assistant');
    const messages = [oldUser, oldAssistant, currentUser, activeAssistant];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([currentUser, activeAssistant]);
  });

  it('keeps multi-step tool workflow messages after the latest user message', () => {
    const oldUser = message('old-user', 'user');
    const oldAssistant = message('old-assistant', 'assistant');
    const currentUser = message('new-user', 'user');
    const firstToolCall = message('first-tool-call', 'assistant');
    const firstToolResult = message('first-tool-result', 'assistant');
    const secondToolCall = message('second-tool-call', 'assistant');
    const secondToolResult = message('second-tool-result', 'assistant');
    const messages = [
      oldUser,
      oldAssistant,
      currentUser,
      firstToolCall,
      firstToolResult,
      secondToolCall,
      secondToolResult,
    ];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([currentUser, firstToolCall, firstToolResult, secondToolCall, secondToolResult]);
  });

  it('keeps the transport payload bounded for long memory-backed threads', () => {
    const system = message('system', 'system');
    const historicalMessages = Array.from({ length: 200 }, (_, index) =>
      message(`history-${index}`, index % 2 === 0 ? 'user' : 'assistant')
    );
    const currentUser = message('current-user', 'user');
    const messages = [system, ...historicalMessages, currentUser];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toEqual([system, currentUser]);
  });

  it('preserves pre-seeded memory-backed threads without user messages', () => {
    const system = message('system', 'system');
    const assistant = message('assistant', 'assistant');
    const messages = [system, assistant];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toBe(messages);
  });
});

describe('extractTransportBodyData', () => {
  it('returns only the app-specific data payload', () => {
    expect(
      extractTransportBodyData({
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
      })
    ).toStrictEqual({
      data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
    });
  });

  it('rejects body values outside the app-specific data payload', () => {
    expect(() =>
      extractTransportBodyData({
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
        messages: [],
        system: 'override',
      })
    ).toThrow(
      'Assistant runtime body only supports top-level data; unsupported field(s): messages, system'
    );
  });
});

describe('assistant-stream integration', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves the original transport error when onError throws', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('server failed', {
          status: 500,
        })
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError: () => {
        throw new Error('callback failed');
      },
    });

    await expect(async () => {
      for await (const _message of adapter.run({
        abortSignal: new AbortController().signal,
        context: {
          callSettings: {},
          config: {},
          tools: {},
        },
        messages: [message('user', 'user')],
        runConfig: undefined,
        unstable_getMessage: () => ({
          metadata: {},
        }),
      } as unknown as Parameters<typeof adapter.run>[0])) {
        // The response fails before yielding.
      }
    }).rejects.toThrow('Status 500: server failed');
  });

  it('reports request setup failures through onError', async () => {
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      body: {
        data: { memory: { threadId: 'thread-1', resourceId: 'workspace-1' } },
        messages: [],
      },
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run({
        abortSignal: new AbortController().signal,
        context: {
          callSettings: {},
          config: {},
          tools: {},
        },
        messages: [message('user', 'user')],
        runConfig: undefined,
        unstable_getMessage: () => ({
          metadata: {},
        }),
      } as unknown as Parameters<typeof adapter.run>[0])) {
        // The request fails before yielding.
      }
    }).rejects.toThrow('Assistant runtime body only supports top-level data');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Assistant runtime body only supports top-level data'),
      })
    );
  });

  it('reports fetch failures through onError', async () => {
    const onError = vi.fn();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run({
        abortSignal: new AbortController().signal,
        context: {
          callSettings: {},
          config: {},
          tools: {},
        },
        messages: [message('user', 'user')],
        runConfig: undefined,
        unstable_getMessage: () => ({
          metadata: {},
        }),
      } as unknown as Parameters<typeof adapter.run>[0])) {
        // The request fails before yielding.
      }
    }).rejects.toThrow('Network request failed');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Network request failed',
      })
    );
  });

  it('rejects runtime config fields that would override transport protocol data', async () => {
    const onError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run({
        abortSignal: new AbortController().signal,
        context: {
          callSettings: { messages: [] },
          config: {},
          tools: {},
        },
        messages: [message('user', 'user')],
        runConfig: undefined,
        unstable_getMessage: () => ({
          metadata: {},
        }),
      } as unknown as Parameters<typeof adapter.run>[0])) {
        // The request fails before fetch because config collides with transport fields.
      }
    }).rejects.toThrow(
      'Assistant runtime callSettings cannot override transport field(s): messages'
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Assistant runtime callSettings cannot override transport field(s): messages.',
      })
    );
  });

  it('does not let onResponse mask HTTP status failures', async () => {
    const onError = vi.fn();
    const onResponse = vi.fn(() => {
      throw new Error('onResponse failed');
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response('server failed', {
          status: 500,
        })
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
      onResponse,
    });

    await expect(async () => {
      for await (const _message of adapter.run({
        abortSignal: new AbortController().signal,
        context: {
          callSettings: {},
          config: {},
          tools: {},
        },
        messages: [message('user', 'user')],
        runConfig: undefined,
        unstable_getMessage: () => ({
          metadata: {},
        }),
      } as unknown as Parameters<typeof adapter.run>[0])) {
        // The response fails before yielding.
      }
    }).rejects.toThrow('Status 500: server failed');

    expect(onResponse).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Status 500: server failed',
      })
    );
  });

  it('decodes tool result data stream chunks into accumulated assistant messages', async () => {
    const messages = await readAssistantStreamMessages([
      'f:{"messageId":"msg-test"}',
      'b:{"toolCallId":"call-1","toolName":"lookup"}',
      'c:{"toolCallId":"call-1","argsTextDelta":"{\\"city\\":\\"SF\\"}"}',
      '9:{"toolCallId":"call-1","toolName":"lookup","args":{"city":"SF"}}',
      'a:{"toolCallId":"call-1","result":{"tempC":18}}',
      '0:"Done"',
      'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
    ]);
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      throw new Error('Expected an accumulated assistant message.');
    }

    expect(lastMessage.status).toMatchObject({ type: 'complete', reason: 'stop' });
    expect(lastMessage.content).toMatchObject([
      {
        type: 'tool-call',
        state: 'result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        args: { city: 'SF' },
        result: { tempC: 18 },
        isError: false,
      },
      { type: 'text', text: 'Done' },
    ]);
  });
});
