import type { ThreadMessage } from '@assistant-ui/react';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  AssistantAttachmentValidationError,
} from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readApprovalActionChipProps } from '../approval-action-chip';
import {
  BrainstrikeDataStreamRuntimeAdapter,
  boundResentImageHistory,
  extractTransportBodyData,
  selectTransportMessagesForMastraMemory,
} from '../data-stream-runtime';

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

/** A user message appended by the approval notice (Approve/Decline). */
function approvalActionMessage(id: string, text = 'Approved shell.tool.'): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: {
      custom: {
        [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
          action: 'approve',
          runId: 'run-echo-1',
          toolCallId: 'call-echo-1',
          toolName: 'shell.tool',
        },
      },
    },
    role: 'user',
  } as unknown as ThreadMessage;
}

/** A user message appended by the suspend notice ("Approved the plan."). */
function suspendActionMessage(id: string): ThreadMessage {
  return {
    content: [{ text: 'Approved the plan.', type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: {
      custom: {
        [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
          resumeData: { action: 'approved' },
          runId: 'run-plan-1',
          toolCallId: 'call-plan-1',
          toolName: 'brainstrike.submitPlan',
        },
      },
    },
    role: 'user',
  } as unknown as ThreadMessage;
}

/** Run the adapter against a scripted one-chunk response and capture the request body. */
async function captureRequestBody(
  options: Partial<Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0]>,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = vi.fn(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      dataStreamFromLines([
        'f:{"messageId":"msg-echo"}',
        '0:"Done"',
        'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
      ])
    );
  }) as typeof fetch;
  const adapter = new BrainstrikeDataStreamRuntimeAdapter({
    api: 'http://assistant.test/api/assistant',
    ...(body ? { body } : {}),
  });
  for await (const _message of adapter.run(runOptions(options))) {
    // Consume the stream so the request fully completes.
  }
  if (!requestBody) {
    throw new Error('adapter run did not issue a request');
  }
  return requestBody;
}

const MEMORY_BODY = {
  data: { memory: { resourceId: 'workspace-1', threadId: 'thread-1' } },
} as const;

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

describe('turn anchor threading (BST-1163)', () => {
  function scriptedFetch(): void {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-echo"}',
            '0:"Done"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        )
    ) as typeof fetch;
  }

  it('forwards the current run configuration before preparing the persisted host run', async () => {
    scriptedFetch();
    const runConfig = {
      custom: {
        brainstrikeChildFollowup: { id: 'child-input', text: 'Continue', threadId: 'child' },
      },
    };
    let received: unknown;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      body: async (_signal, context) => {
        received = context?.runConfig;
        return { data: {} };
      },
    });
    for await (const _message of adapter.run(runOptions({ runConfig }))) {
      /* consume real transport */
    }
    expect(received).toBe(runConfig);
  });

  it('passes the last REAL user message id to the body provider — never an approval action echo', async () => {
    scriptedFetch();
    let receivedAnchor: unknown = 'unset';
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      body: async (_signal: AbortSignal, context?: { turnAnchorMessageId: string | null }) => {
        receivedAnchor = context?.turnAnchorMessageId;
        return { data: {} };
      },
    });
    for await (const _message of adapter.run(
      runOptions({
        messages: [
          message('msg-user-1', 'user'),
          message('msg-assistant-1', 'assistant'),
          approvalActionMessage('action-echo-1'),
        ],
      })
    )) {
      // Consume.
    }
    // The action echo is UI bookkeeping with no durable row — the turn's
    // anchor is the triggering REAL user message, on resume legs too.
    expect(receivedAnchor).toBe('msg-user-1');
  });

  it('passes null when the thread has no real user message', async () => {
    scriptedFetch();
    let receivedAnchor: unknown = 'unset';
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      body: async (_signal: AbortSignal, context?: { turnAnchorMessageId: string | null }) => {
        receivedAnchor = context?.turnAnchorMessageId;
        return { data: {} };
      },
    });
    for await (const _message of adapter.run(
      runOptions({ messages: [message('msg-assistant-1', 'assistant')] })
    )) {
      // Consume.
    }
    expect(receivedAnchor).toBeNull();
  });
});

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

describe('BrainstrikeDataStreamRuntimeAdapter active-run reattachment', () => {
  it('replays a desktop stream without composing a second model request', async () => {
    const body = vi.fn(async () => {
      throw new Error('resume must not compose a fresh request body');
    });
    const onResponse = vi.fn();
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response(
        dataStreamFromLines([
          'f:{"messageId":"msg-resumed"}',
          'g:"Still reasoning"',
          '0:"Finished after reload"',
          'd:{"finishReason":"stop","usage":{"inputTokens":2,"outputTokens":3},"path":[]}',
        ])
      );
    }) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/assistant',
      body,
      headers: { 'X-Brainstrike-Assistant-Token': 'secret' },
      onResponse,
    });

    const yielded: unknown[] = [];
    for await (const nextMessage of adapter.resume(runOptions(), {
      eventId: 'session-1:-1',
      resumeApi: 'http://assistant.test/assistant/resume',
    })) {
      yielded.push(nextMessage);
    }

    expect(fetch).toHaveBeenCalledWith(
      'http://assistant.test/assistant/resume',
      expect.objectContaining({
        headers: expect.any(Headers),
        method: 'GET',
      })
    );
    expect(capturedInit).not.toHaveProperty('body');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('Last-Event-ID')).toBe('session-1:-1');
    expect(headers.get('X-Brainstrike-Assistant-Token')).toBe('secret');
    expect(body).not.toHaveBeenCalled();
    expect(onResponse).not.toHaveBeenCalled();
    expect(yielded.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ text: 'Finished after reload', type: 'text' }),
      ]),
      status: { reason: 'stop', type: 'complete' },
    });
  });

  it('reports replay-only transport failures to the bounded retry controller', async () => {
    const replayFailure = new TypeError('loopback connection reset');
    globalThis.fetch = vi.fn(async () => {
      throw replayFailure;
    }) as typeof fetch;
    const onError = vi.fn();
    const onReplayError = vi.fn();
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/assistant',
      onError,
      onReplayError,
    });
    const consumeReplay = async (): Promise<void> => {
      for await (const _message of adapter.resume(runOptions(), {
        eventId: 'session-1:-1',
        resumeApi: 'http://assistant.test/assistant/resume',
      })) {
        // A failed replay must not yield a partial assistant message.
      }
    };

    await expect(consumeReplay()).rejects.toBe(replayFailure);
    expect(onReplayError).toHaveBeenCalledWith(replayFailure);
    expect(onError).toHaveBeenCalledWith(replayFailure);
  });
});

describe('approval action echo exclusion (transport seam)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes a history approval action message from a memory-backed normal turn', async () => {
    const requestBody = await captureRequestBody(
      {
        messages: [
          message('real-user', 'user'),
          message('assistant-1', 'assistant'),
          approvalActionMessage('approval-user'),
          message('assistant-2', 'assistant'),
          message('next-user', 'user'),
        ],
      },
      { ...MEMORY_BODY }
    );

    expect(JSON.stringify(requestBody['messages'])).not.toContain('Approved shell.tool.');
    expect(JSON.stringify(requestBody['messages'])).toContain('next-user');
  });

  it('excludes a history approval action message from a NON-memory-backed turn (full history resend)', async () => {
    const requestBody = await captureRequestBody({
      messages: [
        message('real-user', 'user'),
        message('assistant-1', 'assistant'),
        approvalActionMessage('approval-user'),
        message('assistant-2', 'assistant'),
        message('next-user', 'user'),
      ],
    });

    // Full history is resent on non-memory transports — the approval echo must
    // not ride along as model-visible conversation.
    expect(JSON.stringify(requestBody['messages'])).not.toContain('Approved shell.tool.');
    expect(JSON.stringify(requestBody['messages'])).toContain('real-user');
    expect(JSON.stringify(requestBody['messages'])).toContain('next-user');
  });

  it('anchors a regenerate-after-approval turn on the previous REAL user message (memory-backed)', async () => {
    // Regenerating the post-approval response: the approval echo is the LAST
    // user message and the runConfig carries no approval action. Without
    // exclusion, the memory compaction anchors ON the echo and the model's
    // "current turn" becomes "Approved shell.tool." — the wrong prompt.
    const requestBody = await captureRequestBody(
      {
        messages: [
          message('real-user', 'user'),
          message('assistant-1', 'assistant'),
          approvalActionMessage('approval-user'),
        ],
      },
      { ...MEMORY_BODY }
    );

    expect(JSON.stringify(requestBody['messages'])).not.toContain('Approved shell.tool.');
    expect(JSON.stringify(requestBody['messages'])).toContain('real-user');
  });

  it('ships EMPTY messages on the approval action leg itself (runConfig carries the approval key)', async () => {
    const requestBody = await captureRequestBody(
      {
        messages: [
          message('real-user', 'user'),
          message('assistant-1', 'assistant'),
          approvalActionMessage('approval-user'),
        ],
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
              action: 'approve',
              runId: 'run-echo-1',
              toolCallId: 'call-echo-1',
              toolName: 'shell.tool',
            },
          },
        },
      },
      { ...MEMORY_BODY }
    );

    // Both resume routes read the action from runConfig and ignore messages —
    // the echo must not reach the server at all.
    expect(requestBody['messages']).toEqual([]);
    expect(requestBody).toHaveProperty('runConfig');
  });

  it('excludes a history suspend action message ("Approved the plan.") — same echo class, same seam', async () => {
    const requestBody = await captureRequestBody({
      messages: [
        message('real-user', 'user'),
        message('assistant-1', 'assistant'),
        suspendActionMessage('plan-user'),
        message('assistant-2', 'assistant'),
        message('next-user', 'user'),
      ],
    });

    expect(JSON.stringify(requestBody['messages'])).not.toContain('Approved the plan.');
    expect(JSON.stringify(requestBody['messages'])).toContain('next-user');
  });

  it('ships EMPTY messages on the suspend resume leg (runConfig carries the suspend key)', async () => {
    const requestBody = await captureRequestBody(
      {
        messages: [
          message('real-user', 'user'),
          message('assistant-1', 'assistant'),
          suspendActionMessage('plan-user'),
        ],
        runConfig: {
          custom: {
            [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
              resumeData: { action: 'approved' },
              runId: 'run-plan-1',
              toolCallId: 'call-plan-1',
              toolName: 'brainstrike.submitPlan',
            },
          },
        },
      },
      { ...MEMORY_BODY }
    );

    expect(requestBody['messages']).toEqual([]);
    expect(requestBody).toHaveProperty('runConfig');
  });

  it('keeps an ordinary user message with unrelated custom metadata on the wire', async () => {
    const unrelated = {
      ...message('custom-user', 'user'),
      metadata: { custom: { somethingElse: { note: true } } },
    } as ThreadMessage;
    const requestBody = await captureRequestBody({
      messages: [unrelated],
    });

    expect(JSON.stringify(requestBody['messages'])).toContain('custom-user');
  });

  it('keeps a record-but-INVALID suspend marker on the wire (it renders as a bubble, not a chip)', async () => {
    // Defense-in-depth: the transport recognizer must agree with the chip
    // recognizer on what an action message IS. A `custom` marker that is a
    // RECORD but structurally invalid (empty object — no runId/toolCallId, no
    // resumeData key) is NOT a valid action: the chip recognizer returns null so
    // it renders as an ordinary prompt bubble. The transport therefore MUST keep
    // it on the wire — stripping a user-visible prompt would be a silent drop.
    const invalidSuspend = {
      ...message('invalid-suspend-user', 'user'),
      metadata: { custom: { [TOOL_SUSPEND_RUN_CONFIG_KEY]: {} } },
    } as unknown as ThreadMessage;

    // The chip recognizer already treats it as a bubble (returns null)…
    expect(readApprovalActionChipProps(invalidSuspend)).toBeNull();

    // …so the transport must NOT strip it from the outbound wire.
    const requestBody = await captureRequestBody({ messages: [invalidSuspend] });
    expect(JSON.stringify(requestBody['messages'])).toContain('invalid-suspend-user');
  });

  it('keeps a record-but-INVALID approval marker on the wire (agrees with the chip recognizer)', async () => {
    // Same divergence for the approval key: `{ action: 'approve' }` with no
    // runId/toolCallId fails the strict contract guard, so it renders as a bubble
    // and must stay on the wire.
    const invalidApproval = {
      ...message('invalid-approval-user', 'user'),
      metadata: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: { action: 'approve' } } },
    } as unknown as ThreadMessage;

    expect(readApprovalActionChipProps(invalidApproval)).toBeNull();

    const requestBody = await captureRequestBody({ messages: [invalidApproval] });
    expect(JSON.stringify(requestBody['messages'])).toContain('invalid-approval-user');
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

const MEGABYTE = 1024 * 1024;

function imageDataUrl(decodedBytes: number, mediaType = 'image/png'): string {
  return `data:${mediaType};base64,${Buffer.alloc(decodedBytes, 65).toString('base64')}`;
}

function wireUser(id: string, content: unknown[]): Record<string, unknown> {
  return { content, id, role: 'user' };
}

function wireFilePart(dataUrl: string, mediaType = 'image/png'): Record<string, unknown> {
  return { data: dataUrl, mediaType, type: 'file' };
}

function wireImageBytes(wireMessages: readonly unknown[]): number {
  let total = 0;
  for (const wireMessage of wireMessages) {
    const content = (wireMessage as { content?: unknown[] }).content ?? [];
    for (const part of content) {
      const record = part as { data?: unknown; type?: unknown };
      if (record.type === 'file' && typeof record.data === 'string') {
        const body = record.data.slice(record.data.indexOf(';base64,') + ';base64,'.length);
        total += Math.floor((body.length * 3) / 4);
      }
    }
  }
  return total;
}

describe('boundResentImageHistory', () => {
  it('returns the same messages and no elision when history images fit the shared budget', () => {
    const messages = [
      wireUser('old-user', [{ text: 'earlier' }, wireFilePart(imageDataUrl(2 * MEGABYTE))]),
      { content: [{ text: 'reply' }], role: 'assistant' },
      wireUser('current-user', [{ text: 'now' }, wireFilePart(imageDataUrl(3 * MEGABYTE))]),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toBeUndefined();
    expect(result.messages).toBe(messages);
  });

  it('elides all history image bodies when the current turn consumes the whole budget', () => {
    const historyImage = wireFilePart(imageDataUrl(MEGABYTE), 'image/jpeg');
    const maxedCurrentTurn = [
      wireFilePart(imageDataUrl(5 * MEGABYTE)),
      wireFilePart(imageDataUrl(5 * MEGABYTE)),
    ];
    const messages = [
      wireUser('old-user', [{ text: 'earlier' }, historyImage]),
      wireUser('current-user', maxedCurrentTurn),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toEqual({
      elidedImageBytes: MEGABYTE,
      elidedImageCount: 1,
      keptImageBytes: ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
      strategy: 'newest-first-combined-image-budget',
    });
    const historyContent = (result.messages[0] as { content: unknown[] }).content;
    expect(historyContent[0]).toEqual({ text: 'earlier' });
    expect(historyContent[1]).toEqual({
      text: expect.stringContaining('image/jpeg'),
    });
    expect((historyContent[1] as { text: string }).text).toContain('omitted');
    // The current turn's own attachments are never elided.
    expect((result.messages[1] as { content: unknown[] }).content).toEqual(maxedCurrentTurn);
    expect(JSON.stringify(result.messages[0])).not.toContain(';base64,');
  });

  it('keeps the newest history images and elides older ones past the budget', () => {
    const messages = [
      wireUser('oldest-user', [wireFilePart(imageDataUrl(4 * MEGABYTE))]),
      wireUser('middle-user', [wireFilePart(imageDataUrl(4 * MEGABYTE))]),
      wireUser('newest-history-user', [wireFilePart(imageDataUrl(4 * MEGABYTE))]),
      wireUser('current-user', [{ text: 'no image this turn' }]),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toEqual({
      elidedImageBytes: 4 * MEGABYTE,
      elidedImageCount: 1,
      keptImageBytes: 8 * MEGABYTE,
      strategy: 'newest-first-combined-image-budget',
    });
    expect(JSON.stringify(result.messages[0])).not.toContain(';base64,');
    expect(JSON.stringify(result.messages[1])).toContain(';base64,');
    expect(JSON.stringify(result.messages[2])).toContain(';base64,');
    expect(wireImageBytes(result.messages)).toBeLessThanOrEqual(
      ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES
    );
  });

  it('elides every image older than the first one that does not fit', () => {
    const messages = [
      // Would fit the leftover budget on its own, but sits past the cutoff.
      wireUser('oldest-user', [wireFilePart(imageDataUrl(MEGABYTE))]),
      wireUser('newer-user', [wireFilePart(imageDataUrl(5 * MEGABYTE))]),
      wireUser('current-user', [
        wireFilePart(imageDataUrl(3 * MEGABYTE)),
        wireFilePart(imageDataUrl(3 * MEGABYTE)),
      ]),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toEqual({
      elidedImageBytes: 6 * MEGABYTE,
      elidedImageCount: 2,
      keptImageBytes: 6 * MEGABYTE,
      strategy: 'newest-first-combined-image-budget',
    });
    expect(JSON.stringify(result.messages[0])).not.toContain(';base64,');
    expect(JSON.stringify(result.messages[1])).not.toContain(';base64,');
  });

  it('writes distinguishable notes for sibling attachments elided from one message', () => {
    const messages = [
      wireUser('old-user', [
        wireFilePart(imageDataUrl(4 * MEGABYTE)),
        wireFilePart(imageDataUrl(4 * MEGABYTE)),
      ]),
      wireUser('current-user', [
        wireFilePart(imageDataUrl(4 * MEGABYTE)),
        wireFilePart(imageDataUrl(4 * MEGABYTE)),
      ]),
    ];

    const result = boundResentImageHistory(messages);

    const [firstNote, secondNote] = (result.messages[0] as { content: { text: string }[] }).content;
    expect(firstNote?.text).toContain('1 of 2');
    expect(secondNote?.text).toContain('2 of 2');
    expect(firstNote?.text).not.toEqual(secondNote?.text);
  });

  it('elides an unmeasurable history file part with a visible note instead of failing the turn', () => {
    const messages = [
      wireUser('old-user', [{ data: 'https://example.test/image.png', type: 'file' }]),
      wireUser('current-user', [{ text: 'hello' }]),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toEqual({
      elidedImageBytes: 0,
      elidedImageCount: 1,
      keptImageBytes: 0,
      strategy: 'newest-first-combined-image-budget',
      unmeasurableImageCount: 1,
    });
    const note = (result.messages[0] as { content: { text?: string }[] }).content[0];
    expect(note?.text).toContain('omitted');
    expect(note?.text).toContain('not an inline base64 data URL');
  });

  it('does not let an unmeasurable history part consume budget or trigger the cutoff', () => {
    const messages = [
      wireUser('oldest-user', [wireFilePart(imageDataUrl(4 * MEGABYTE))]),
      wireUser('newer-user', [{ data: 'https://example.test/image.png', type: 'file' }]),
      wireUser('current-user', [{ text: 'no image this turn' }]),
    ];

    const result = boundResentImageHistory(messages);

    expect(result.elision).toEqual({
      elidedImageBytes: 0,
      elidedImageCount: 1,
      keptImageBytes: 4 * MEGABYTE,
      strategy: 'newest-first-combined-image-budget',
      unmeasurableImageCount: 1,
    });
    // The measurable older image still fits and ships.
    expect(JSON.stringify(result.messages[0])).toContain(';base64,');
    expect(JSON.stringify(result.messages[1])).not.toContain('example.test');
  });

  it('throws loudly on an unmeasurable current-turn file part instead of guessing', () => {
    const messages = [
      wireUser('old-user', [{ text: 'earlier' }]),
      wireUser('current-user', [{ data: 'https://example.test/image.png', type: 'file' }]),
    ];

    expect(() => boundResentImageHistory(messages)).toThrow(AssistantAttachmentValidationError);
  });
});

describe('assistant-stream integration', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects an oversized serialized request before fetch', async () => {
    const onError = vi.fn();
    globalThis.fetch = vi.fn() as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: '/api/assistant',
      onError,
      requestBodyLimitBytes: 128,
    });

    await expect(async () => {
      for await (const _message of adapter.run(
        runOptions({ messages: [message('x'.repeat(256), 'user')] })
      )) {
        // The request fails before yielding.
      }
    }).rejects.toThrow('Assistant request body exceeds the 128-byte transport limit.');

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Assistant request body exceeds the 128-byte transport limit.',
      })
    );
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
        id: 'file-user',
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

  it('bounds resent history images on the wire and attaches elision metadata', async () => {
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
      body: { data: { model: 'test-model' } },
    });
    const historyDataUrl = imageDataUrl(5 * MEGABYTE);
    const historyUserMessage = {
      ...message('history-user', 'user'),
      content: [
        { text: 'first image', type: 'text' },
        { data: historyDataUrl, mimeType: 'image/png', type: 'file' },
      ],
    } as unknown as ThreadMessage;
    const currentUserMessage = {
      ...message('current-user', 'user'),
      content: [
        { data: imageDataUrl(3 * MEGABYTE), mimeType: 'image/png', type: 'file' },
        { data: imageDataUrl(3 * MEGABYTE), mimeType: 'image/png', type: 'file' },
      ],
    } as unknown as ThreadMessage;

    for await (const _message of adapter.run(
      runOptions({
        messages: [historyUserMessage, message('assistant-reply', 'assistant'), currentUserMessage],
      })
    )) {
      // Consume the response so the request is fully exercised.
    }

    expect(requestBody?.['data']).toEqual({
      model: 'test-model',
      transportImageElision: {
        elidedImageBytes: 5 * MEGABYTE,
        elidedImageCount: 1,
        keptImageBytes: 6 * MEGABYTE,
        strategy: 'newest-first-combined-image-budget',
      },
    });
    const wireMessages = requestBody?.['messages'] as {
      content: { data?: string; text?: string }[];
      role: string;
    }[];
    expect(wireMessages[0]?.content[0]).toEqual({ text: 'first image' });
    expect(wireMessages[0]?.content[1]?.text).toContain('omitted');
    expect(JSON.stringify(wireMessages[0])).not.toContain(';base64,');
    expect(wireMessages[2]?.content).toHaveLength(2);
    expect(wireMessages[2]?.content[0]?.data).toContain(';base64,');
    // The elision is wire-only: the thread's own message record keeps the body.
    expect((historyUserMessage.content[1] as unknown as { data: string }).data).toBe(
      historyDataUrl
    );
  });

  it('sends only the exact Brainstrike server request envelope', async () => {
    const requestBody = await captureRequestBody(
      {
        runConfig: { custom: { action: 'resume' } },
        unstable_assistantMessageId: 'assistant-message',
        unstable_parentId: null,
        unstable_threadId: 'assistant-ui-thread',
      },
      MEMORY_BODY
    );

    expect(Object.keys(requestBody).sort()).toEqual([
      'data',
      'messages',
      'runConfig',
      'unstable_assistantMessageId',
    ]);
  });

  it('fails visibly before fetch for unsupported assistant-ui model context or state', async () => {
    const onError = vi.fn();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onError,
    });

    await expect(async () => {
      for await (const _message of adapter.run(
        runOptions({
          context: {
            callSettings: { temperature: 0.2 },
            config: { apiKey: 'must-not-cross-the-wire' },
            system: 'unsupported client system prompt',
            tools: {
              client_tool: {
                description: 'unsupported client tool',
                parameters: { type: 'object' },
              },
            },
          },
          unstable_getMessage: () =>
            ({
              ...message('assistant-state', 'assistant'),
              metadata: { unstable_state: { private: 'state' } },
            }) as unknown as ThreadMessage,
        })
      )) {
        // Unsupported context must fail before a request is issued.
      }
    }).rejects.toThrow(
      'Brainstrike assistant transport does not support assistant-ui field(s): callSettings, config, state, system, tools'
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Brainstrike assistant transport does not support assistant-ui field(s): callSettings, config, state, system, tools.',
      })
    );
  });

  it('rejects non-empty call settings instead of forwarding transport/model fields', async () => {
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
        // The request fails before fetch because the custom server does not consume call settings.
      }
    }).rejects.toThrow(
      'Brainstrike assistant transport does not support assistant-ui field(s): callSettings.'
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Brainstrike assistant transport does not support assistant-ui field(s): callSettings.',
      })
    );
  });

  it('rejects non-empty model config instead of forwarding provider secrets', async () => {
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
        // The request fails before fetch because the custom server does not consume model config.
      }
    }).rejects.toThrow(
      'Brainstrike assistant transport does not support assistant-ui field(s): config.'
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Brainstrike assistant transport does not support assistant-ui field(s): config.',
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
    const runConfig = { maxTokens: 128 } as unknown as Parameters<
      BrainstrikeDataStreamRuntimeAdapter['run']
    >[0]['runConfig'];

    for await (const _message of adapter.run(
      runOptions({
        context: {
          callSettings: {},
          config: {},
          tools: {},
        },
        messages: [oldUser, currentUser],
        runConfig,
        unstable_assistantMessageId: 'assistant-message',
        unstable_getMessage: () => finishMessage,
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
    expect(requestBody).toEqual({
      data: {
        memory: { resourceId: 'workspace', threadId: 'thread' },
        transportCompaction: {
          originalMessageCount: 2,
          sentMessageCount: 1,
          strategy: 'mastra-memory-current-turn',
        },
      },
      messages: [
        {
          content: [{ text: 'current-user' }],
          id: 'current-user',
          role: 'user',
        },
      ],
      runConfig: { maxTokens: 128 },
      unstable_assistantMessageId: 'assistant-message',
    });
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
    // The run session decides from these whether a pause may have been
    // cancelled with the turn: the prior messages plus the live message.
    expect(onCancel).toHaveBeenCalledWith({
      messages: [message('user', 'user'), message('message-id', 'assistant')],
    });

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

  it('separates billed run totals from the latest provider-effective context', async () => {
    const usageEvents: Array<{
      contextInputTokens?: number;
      contextOutputTokens?: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-context"}',
            '0:"Done"',
            'd:{"finishReason":"stop","usage":{"inputTokens":138800,"outputTokens":4100,"contextInputTokens":28400,"contextOutputTokens":900},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage: (usage) => {
        usageEvents.push(usage);
      },
    });

    for await (const nextMessage of adapter.run({
      abortSignal: new AbortController().signal,
      context: {
        callSettings: {},
        config: {},
        tools: {},
      },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      void nextMessage;
    }

    expect(usageEvents).toEqual([
      {
        contextInputTokens: 28_400,
        contextOutputTokens: 900,
        inputTokens: 138_800,
        outputTokens: 4100,
      },
    ]);
  });

  it('forwards Anthropic cache token counts with token usage', async () => {
    const usageEvents: Array<{
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Hello"',
            'd:{"finishReason":"stop","usage":{"inputTokens":123,"outputTokens":45,"cacheReadInputTokens":40,"cacheCreationInputTokens":60},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage: (usage) => {
        usageEvents.push(usage);
      },
    });

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
      void nextMessage;
    }

    expect(usageEvents).toEqual([
      {
        cacheCreationInputTokens: 60,
        cacheReadInputTokens: 40,
        inputTokens: 123,
        outputTokens: 45,
      },
    ]);
  });

  it('forwards provider-reported billed cost with token usage', async () => {
    const usageEvents: Array<{
      billedCostUsd?: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-cost"}',
            '0:"Hello"',
            'd:{"finishReason":"stop","usage":{"inputTokens":123,"outputTokens":45},"billedCostUsd":0.0042,"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage: (usage) => usageEvents.push(usage),
    });

    for await (const _message of adapter.run({
      abortSignal: new AbortController().signal,
      context: { callSettings: {}, config: {}, tools: {} },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      // drain
    }

    expect(usageEvents).toEqual([{ billedCostUsd: 0.0042, inputTokens: 123, outputTokens: 45 }]);
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

  it('fires onContextBreakdown with the RAW payload of a context-breakdown data part', async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            'aui-data:{"name":"brainstrike.context-breakdown","data":{"attachmentsCount":0,"historyMessagesTokens":9,"provenance":"heuristic","systemInstructionsTokens":1200,"taskListTokens":40}}',
            // A DIFFERENT data part must not trigger the callback.
            'aui-data:{"name":"brainstrike.shell-output","data":{"chunk":"x","stream":"stdout","toolCallId":"c1"}}',
            '0:"Hello"',
            'd:{"finishReason":"stop","usage":{"inputTokens":123,"outputTokens":45},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onContextBreakdown: (data) => payloads.push(data),
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

    // Tap is pass-through: the stream still completes normally.
    expect(yielded.length).toBeGreaterThan(0);
    const lastMessage = yielded.at(-1) as { status?: { type?: string } };
    expect(lastMessage.status).toMatchObject({ type: 'complete' });
    // Raw payload forwarded exactly once (shell-output part ignored).
    expect(payloads).toEqual([
      {
        attachmentsCount: 0,
        historyMessagesTokens: 9,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        taskListTokens: 40,
      },
    ]);
  });

  it('forwards a malformed context-breakdown payload verbatim (consumer parses via contract guard)', async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            'aui-data:{"name":"brainstrike.context-breakdown","data":{"bogus":true}}',
            '0:"Hello"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onContextBreakdown: (data) => payloads.push(data),
    });

    for await (const _message of adapter.run({
      abortSignal: new AbortController().signal,
      context: { callSettings: {}, config: {}, tools: {} },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      // drain
    }

    // The tap never validates or coerces — the contract guard downstream turns
    // this into { invalid: true } for the popover.
    expect(payloads).toEqual([{ bogus: true }]);
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

  it('forwards a cost-only zero-token finish when the transport supplies one', async () => {
    const onUsage = vi.fn();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-cost-pause"}',
            'd:{"finishReason":"tool-calls","usage":{"inputTokens":0,"outputTokens":0},"billedCostUsd":0.00125,"path":[]}',
          ])
        )
    ) as typeof fetch;
    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
      onUsage,
    });

    for await (const _message of adapter.run({
      abortSignal: new AbortController().signal,
      context: { callSettings: {}, config: {}, tools: {} },
      messages: [message('user', 'user')],
      runConfig: undefined,
      unstable_getMessage: () => ({ metadata: {} }),
    } as unknown as Parameters<typeof adapter.run>[0])) {
      // drain
    }

    expect(onUsage).toHaveBeenCalledWith({
      billedCostUsd: 0.001_25,
      inputTokens: 0,
      outputTokens: 0,
    });
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
