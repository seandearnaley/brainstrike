import type { ThreadMessage } from '@assistant-ui/react';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
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

vi.mock('@brainstrike/utils/string-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/string-utils')>();
  return {
    ...actual,
    sliceCodePoints: vi.fn(actual.sliceCodePoints),
  };
});

function message(id: string, role: ThreadMessage['role']): ThreadMessage {
  return {
    content: [{ text: id, type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: { custom: {} },
    role,
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

function runOptions(
  overrides: Partial<Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0]> = {}
): Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0] {
  return {
    abortSignal: new AbortController().signal,
    context: {
      callSettings: {},
      config: {},
      tools: {},
    },
    messages: [message('user', 'user')],
    runConfig: undefined,
    unstable_getMessage: () => message('message-id', 'assistant'),
    ...overrides,
  } as Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0];
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
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
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
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
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
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
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
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
      })
    ).toEqual([system, currentUser]);
  });

  it('preserves pre-seeded memory-backed threads without user messages', () => {
    const system = message('system', 'system');
    const assistant = message('assistant', 'assistant');
    const messages = [system, assistant];

    expect(
      selectTransportMessagesForMastraMemory(messages, {
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
      })
    ).toBe(messages);
  });
});

describe('extractTransportBodyData', () => {
  it('returns an empty data payload for absent body values', () => {
    expect(extractTransportBodyData(undefined)).toStrictEqual({});
  });

  it('returns only the app-specific data payload', () => {
    expect(
      extractTransportBodyData({
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
      })
    ).toStrictEqual({
      data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
    });
  });

  it('rejects body values outside the app-specific data payload', () => {
    expect(() =>
      extractTransportBodyData({
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
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
        data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
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

  it('uses the latest runtime callbacks from a stable adapter source', async () => {
    const firstOnError = vi.fn();
    const secondOnError = vi.fn();
    let onError = firstOnError;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter(() => ({
      api: 'http://assistant.test/api/assistant',
      onError,
    }));
    onError = secondOnError;

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

    expect(firstOnError).not.toHaveBeenCalled();
    expect(secondOnError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Network request failed',
      })
    );
  });

  it('strips text part metadata from hosted request messages', async () => {
    let requestBody: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        dataStreamFromLines([
          'f:{"messageId":"msg-test"}',
          '0:"Done"',
          'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
        ])
      );
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });

    for await (const _message of adapter.run({
      abortSignal: new AbortController().signal,
      context: {
        callSettings: {},
        config: {},
        tools: {},
      },
      messages: [message('hello', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({
        metadata: {},
      }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      // Consume the response so the request is fully exercised.
    }

    expect(requestBody).toMatchObject({
      messages: [
        {
          content: [{ text: 'hello' }],
          role: 'user',
        },
      ],
    });
    expect(JSON.stringify(requestBody)).not.toContain('"type":"text"');
  });

  it('serializes hosted system, file, assistant tool-call, and tool result messages', async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        dataStreamFromLines([
          'f:{"messageId":"msg-test"}',
          '0:"Done"',
          'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
        ])
      );
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });
    const userFileMessage = {
      ...message('file-user', 'user'),
      content: [{ data: 'data:text/plain;base64,SGVsbG8=', mimeType: 'text/plain', type: 'file' }],
    } as unknown as ThreadMessage;
    const assistantToolCallMessage = {
      ...message('assistant-tool-call', 'assistant'),
      content: [
        {
          args: { query: 'weather' },
          result: { tempC: 18 },
          toolCallId: 'call-1',
          toolName: 'lookup',
          type: 'tool-call',
        },
        {
          args: { query: 'broken' },
          isError: true,
          result: { message: 'failed' },
          toolCallId: 'call-2',
          toolName: 'lookup',
          type: 'tool-call',
        },
      ],
    } as unknown as ThreadMessage;

    for await (const _message of adapter.run(
      runOptions({
        messages: [message('system prompt', 'system'), userFileMessage, assistantToolCallMessage],
      })
    )) {
      // Consume the response so the request is fully exercised.
    }

    expect(requestBody?.['messages']).toEqual([
      {
        content: [{ text: 'system prompt' }],
        role: 'system',
      },
      {
        content: [
          { data: 'data:text/plain;base64,SGVsbG8=', mediaType: 'text/plain', type: 'file' },
        ],
        role: 'user',
      },
      {
        content: [
          {
            input: { query: 'weather' },
            toolCallId: 'call-1',
            toolName: 'lookup',
            type: 'tool-call',
          },
          {
            input: { query: 'broken' },
            toolCallId: 'call-2',
            toolName: 'lookup',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'json', value: { tempC: 18 } },
            toolCallId: 'call-1',
            toolName: 'lookup',
            type: 'tool-result',
          },
          {
            output: { type: 'error-json', value: { message: 'failed' } },
            toolCallId: 'call-2',
            toolName: 'lookup',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
    ]);
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

  it('rejects runtime config collisions separately from call settings', async () => {
    const onError = vi.fn();
    const collidingConfig = { threadId: 'override' } as unknown as Parameters<
      BrainstrikeDataStreamRuntimeAdapter['run']
    >[0]['context']['config'];
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run(
        runOptions({
          context: {
            callSettings: {},
            config: collidingConfig,
            tools: {},
          },
        })
      )) {
        // The request fails before fetch because config collides with transport fields.
      }
    }).rejects.toThrow('Assistant runtime config cannot override transport field(s): threadId');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Assistant runtime config cannot override transport field(s): threadId.',
      })
    );
  });

  it('builds requests from async options and attaches transport compaction metadata', async () => {
    const onResponse = vi.fn();
    const onFinish = vi.fn();
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    let requestCredentials: RequestCredentials | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = init?.headers as Headers;
      requestCredentials = init?.credentials;
      return new Response(
        dataStreamFromLines([
          'f:{"messageId":"msg-test"}',
          '0:"Done"',
          'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
        ])
      );
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      body: async () => ({ data: { memory: { resourceId: 'workspace', threadId: 'thread' } } }),
      credentials: 'include',
      headers: async () => ({ authorization: 'Bearer token' }),
      onFinish,
      onResponse,
    });
    const oldUser = message('old-user', 'user');
    const currentUser = message('current-user', 'user');
    const finishMessage = message('finished', 'assistant');
    const providerConfig = { temperature: 0.2 } as unknown as Parameters<
      BrainstrikeDataStreamRuntimeAdapter['run']
    >[0]['context']['config'];
    const runConfig = { maxTokens: 128 } as unknown as Parameters<
      BrainstrikeDataStreamRuntimeAdapter['run']
    >[0]['runConfig'];

    for await (const _message of adapter.run(
      runOptions({
        context: {
          callSettings: {},
          config: providerConfig,
          system: 'System prompt',
          tools: {},
        },
        messages: [oldUser, currentUser],
        runConfig,
        unstable_assistantMessageId: 'assistant-message',
        unstable_getMessage: () =>
          ({
            ...finishMessage,
            metadata: { ...finishMessage.metadata, unstable_state: { mode: 'debug' } },
          }) as unknown as ThreadMessage,
        unstable_parentId: null,
        unstable_threadId: 'thread-id',
      })
    )) {
      // Consume the response so finish hooks run.
    }

    expect(requestHeaders?.get('authorization')).toBe('Bearer token');
    expect(requestHeaders?.get('content-type')).toBe('application/json');
    expect(requestCredentials).toBe('include');
    expect(onResponse).toHaveBeenCalledWith(expect.any(Response));
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'finished',
      })
    );
    expect(requestBody).toMatchObject({
      data: {
        memory: { resourceId: 'workspace', threadId: 'thread' },
        transportCompaction: {
          originalMessageCount: 2,
          sentMessageCount: 1,
          strategy: 'mastra-memory-current-turn',
        },
      },
      parentId: null,
      runConfig: { maxTokens: 128 },
      state: { mode: 'debug' },
      system: 'System prompt',
      temperature: 0.2,
      threadId: 'thread-id',
      unstable_assistantMessageId: 'assistant-message',
    });
    expect(
      (requestBody?.['messages'] as unknown[]).map((item) => (item as { role: string }).role)
    ).toEqual(['user']);
  });

  it('reports null response bodies as transport failures', async () => {
    const onError = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run(runOptions())) {
        // The response has no stream body.
      }
    }).rejects.toThrow('Response body is null');

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Response body is null',
      })
    );
  });

  it('reports empty HTTP error response bodies without reading from a null stream', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });

    await expect(async () => {
      for await (const _message of adapter.run(runOptions())) {
        // The response fails before yielding.
      }
    }).rejects.toThrow('Status 500: ');
  });

  it('invokes onCancel for normal aborts but not detach aborts', async () => {
    const onCancel = vi.fn();
    const createBlockingFetch = () =>
      vi.fn(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          })
      ) as typeof fetch;

    const normalAbortController = new AbortController();
    globalThis.fetch = createBlockingFetch();
    const normalAdapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onCancel,
    });
    const normalRun = (async () => {
      for await (const _message of normalAdapter.run(
        runOptions({ abortSignal: normalAbortController.signal })
      )) {
        // The fetch promise rejects when aborted.
      }
    })();
    normalAbortController.abort(new DOMException('cancelled', 'AbortError'));
    await expect(normalRun).rejects.toThrow('cancelled');
    expect(onCancel).toHaveBeenCalledTimes(1);

    const detachAbortController = new AbortController();
    globalThis.fetch = createBlockingFetch();
    const detachAdapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onCancel,
    });
    const detachRun = (async () => {
      for await (const _message of detachAdapter.run(
        runOptions({ abortSignal: detachAbortController.signal })
      )) {
        // The fetch promise rejects when aborted.
      }
    })();
    detachAbortController.abort({ detach: true });
    await expect(detachRun).rejects.toMatchObject({ detach: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
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

  it('bounds HTTP error response bodies before reporting transport failures', async () => {
    const onError = vi.fn();
    const encoder = new TextEncoder();
    let cancelCalled = false;
    const sliceCodePointsMock = vi.mocked(sliceCodePoints);
    sliceCodePointsMock.mockClear();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalled = true;
            },
            pull(controller) {
              controller.enqueue(encoder.encode('x'.repeat(3000)));
              controller.enqueue(encoder.encode('y'.repeat(5000)));
              controller.enqueue(encoder.encode('tail-that-should-not-be-read'));
            },
          }),
          { status: 500 }
        )
    ) as typeof fetch;
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
        // The response fails before yielding.
      }
    }).rejects.toThrow(`Status 500: ${'x'.repeat(3000)}${'y'.repeat(1000)}...[truncated]`);

    expect(cancelCalled).toBe(true);
    expect(
      Math.max(
        ...sliceCodePointsMock.mock.calls.map(([value]) =>
          typeof value === 'string' ? value.length : 0
        )
      )
    ).toBe(5000);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.not.stringContaining('tail-that-should-not-be-read') as string,
      })
    );
  });

  it('truncates HTTP error responses when a later chunk arrives after the size limit is reached', async () => {
    const encoder = new TextEncoder();
    let cancelCalled = false;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalled = true;
            },
            pull(controller) {
              controller.enqueue(encoder.encode('x'.repeat(4000)));
              controller.enqueue(encoder.encode('y'));
            },
          }),
          { status: 500 }
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });

    await expect(async () => {
      for await (const _message of adapter.run(runOptions())) {
        // The response fails before yielding.
      }
    }).rejects.toThrow(`Status 500: ${'x'.repeat(4000)}...[truncated]`);

    expect(cancelCalled).toBe(true);
  });

  it('invokes onActivity for each streamed chunk', async () => {
    const onActivity = vi.fn();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Hello"',
            '0:" world"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onActivity,
    });

    let yieldedCount = 0;
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
      yieldedCount += 1;
    }

    expect(yieldedCount).toBeGreaterThan(0);
    expect(onActivity).toHaveBeenCalledTimes(yieldedCount);
  });

  it('does not break the stream when onActivity throws', async () => {
    const onActivity = vi.fn(() => {
      throw new Error('activity hook failed');
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Done"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onActivity,
    });

    const yielded: unknown[] = [];
    for await (const nextMessage of adapter.run({
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
      yielded.push(nextMessage);
    }

    expect(onActivity).toHaveBeenCalled();
    expect(yielded.length).toBeGreaterThan(0);
    const lastMessage = yielded.at(-1) as { status?: { type?: string } };
    expect(lastMessage.status).toMatchObject({ type: 'complete' });
  });

  it('does not expose a complete message until every decoded part has drained', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Done"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });

    const yielded: { status?: { type?: string } }[] = [];
    for await (const nextMessage of adapter.run(runOptions())) {
      yielded.push(nextMessage as { status?: { type?: string } });
    }

    const firstCompleteIndex = yielded.findIndex((item) => item.status?.type === 'complete');
    expect(firstCompleteIndex).toBe(yielded.length - 1);
  });

  it('preserves the authoritative abort reason instead of reporting a teardown error', async () => {
    const abortController = new AbortController();
    const abortReason = new DOMException('superseded by the next turn', 'AbortError');
    const teardownError = new TypeError(
      "Failed to execute 'enqueue' on 'ReadableStreamDefaultController': Cannot enqueue a chunk into a readable stream that is closed"
    );
    const onError = vi.fn();
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('f:{"messageId":"msg-test"}\n'));
          controller.enqueue(encoder.encode('0:"Started"\n'));
          abortController.signal.addEventListener('abort', () => controller.error(teardownError), {
            once: true,
          });
        },
      });
      return new Response(body);
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });
    const iterator = adapter.run(runOptions({ abortSignal: abortController.signal }));

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    abortController.abort(abortReason);
    const drainAfterAbort = async () => {
      while (true) {
        await iterator.next();
      }
    };
    await expect(drainAfterAbort()).rejects.toBe(abortReason);
    expect(onError).not.toHaveBeenCalled();
  });

  it('fires onUsage with provider token counts from finish-message chunks', async () => {
    const usageEvents: { inputTokens: number; outputTokens: number }[] = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Hello"',
            'd:{"finishReason":"stop","usage":{"inputTokens":123,"outputTokens":45},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage: (usage) => {
        usageEvents.push(usage);
      },
    });

    const yielded: unknown[] = [];
    for await (const nextMessage of adapter.run({
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
      yielded.push(nextMessage);
    }

    // Tap must be pass-through: existing message accumulation still works.
    expect(yielded.length).toBeGreaterThan(0);
    const lastMessage = yielded.at(-1) as { status?: { type?: string } };
    expect(lastMessage.status).toMatchObject({ type: 'complete' });

    // Exact wire values forwarded to the callback.
    expect(usageEvents).toEqual([{ inputTokens: 123, outputTokens: 45 }]);
  });

  it('completes normally and does not call onUsage when finish-message chunk has no usage field', async () => {
    // Guard: buildUsageTap must handle a chunk where `usage` is null/undefined.
    // Without the guard the destructure throws, erroring the whole stream.
    const onUsage = vi.fn();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Hello"',
            // finish chunk deliberately omits the usage field
            'd:{"finishReason":"stop","path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage,
    });

    const yielded: unknown[] = [];
    for await (const nextMessage of adapter.run({
      abortSignal: new AbortController().signal,
      context: { callSettings: {}, config: {}, tools: {} },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      yielded.push(nextMessage);
    }

    expect(yielded.length).toBeGreaterThan(0);
    const lastMessage = yielded.at(-1) as { status?: { type?: string } };
    expect(lastMessage.status).toMatchObject({ type: 'complete' });
    // onUsage must NOT be called when usage is absent
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does not call onUsage for a zero-token finish (approval-pause junk row guard)', async () => {
    // Approval-pause turns emit a {0,0} message-finish (makeToolCallsFinishChunk);
    // onUsage must skip it so no junk (provider, model, 0, 0) durable row is written.
    const onUsage = vi.fn();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Hello"',
            'd:{"finishReason":"tool-calls","usage":{"inputTokens":0,"outputTokens":0},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage,
    });

    const yielded: unknown[] = [];
    for await (const nextMessage of adapter.run({
      abortSignal: new AbortController().signal,
      context: { callSettings: {}, config: {}, tools: {} },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      yielded.push(nextMessage);
    }

    expect(yielded.length).toBeGreaterThan(0);
    // The stream still completes (pass-through tap), it just skips the {0,0} usage.
    expect(onUsage).not.toHaveBeenCalled();
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

    expect(lastMessage.status).toMatchObject({ reason: 'stop', type: 'complete' });
    expect(lastMessage.content).toMatchObject([
      {
        args: { city: 'SF' },
        isError: false,
        result: { tempC: 18 },
        state: 'result',
        toolCallId: 'call-1',
        toolName: 'lookup',
        type: 'tool-call',
      },
      { text: 'Done', type: 'text' },
    ]);
  });
});
