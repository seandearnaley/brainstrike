import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, RuntimeData } from '..';
import {
  AssistantAttachmentValidationError,
  convertAssistantUiMessages,
  convertAssistantUiMessagesWithFinalInput,
  toAiSdkStyleStream,
} from '..';
import {
  AssistantMessageValidationError,
  assertAssistantMessageGraphWithinLimits,
  MAX_ASSISTANT_MESSAGE_ARRAY_ITEMS,
  MAX_ASSISTANT_MESSAGE_GRAPH_NODES,
  MAX_ASSISTANT_MESSAGE_STRING_CHARS,
  MAX_ASSISTANT_MESSAGES,
} from '../assistant-message-boundary';
import { buildWorkspaceRootManifestContextMessage } from '../workspace-root-manifest';

const { streamMastraAgentMock } = vi.hoisted(() => ({
  streamMastraAgentMock: vi.fn(),
}));

vi.mock('../mastra/agent-streaming', async () => {
  const actual = await vi.importActual<typeof import('../mastra/agent-streaming')>(
    '../mastra/agent-streaming'
  );
  return {
    ...actual,
    streamMastraAgent: streamMastraAgentMock,
  };
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=';

describe('convertAssistantUiMessages image attachments', () => {
  it('preserves a user image file part alongside the text parts', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [
          { text: 'what is in this screenshot?', type: 'text' },
          { data: PNG_DATA_URL, filename: 'shot.png', mediaType: 'image/png', type: 'file' },
        ],
        id: 'u1',
        role: 'user',
      },
    ]);

    expect(messages).toHaveLength(1);
    const [first] = messages as [AgentMessage];
    expect(first.parts).toEqual([
      { text: 'what is in this screenshot?', type: 'text' },
      { data: PNG_DATA_URL, filename: 'shot.png', mediaType: 'image/png', type: 'file' },
    ]);
  });

  it('never leaks the base64 body or media type into the text walk', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [
          { text: 'describe it', type: 'text' },
          { data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' },
        ],
        id: 'u1',
        role: 'user',
      },
    ]);

    const [first] = messages as [AgentMessage];
    const textJoined = first.parts
      .filter((part): part is { text: string; type: 'text' } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
    expect(textJoined).toBe('describe it');
    expect(textJoined).not.toContain('base64');
    expect(textJoined).not.toContain('image/png');
  });

  it('keeps an image-only user message (no text parts)', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [{ data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' }],
        id: 'u1',
        role: 'user',
      },
    ]);

    expect(messages).toHaveLength(1);
    const [first] = messages as [AgentMessage];
    expect(first.parts).toEqual([{ data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' }]);
  });

  it('tracks whether the final input message converted without rewalking it separately', () => {
    expect(
      convertAssistantUiMessagesWithFinalInput([
        { id: 'u1', parts: [{ text: 'first', type: 'text' }], role: 'user' },
        { id: 'u2', parts: [{ text: '   ', type: 'text' }], role: 'user' },
      ])
    ).toEqual({
      finalInputMessage: null,
      messages: [{ id: 'u1', parts: [{ text: 'first', type: 'text' }], role: 'user' }],
    });
  });

  it('throws loudly on an unsupported attachment media type', () => {
    expect(() =>
      convertAssistantUiMessages([
        {
          content: [
            {
              data: 'data:application/pdf;base64,AAAA',
              mediaType: 'application/pdf',
              type: 'file',
            },
          ],
          id: 'u1',
          role: 'user',
        },
      ])
    ).toThrow(/media type/i);
  });

  it.each([
    [
      'missing media type',
      {
        data: PNG_DATA_URL,
        type: 'file',
      },
    ],
    [
      'non-string data',
      {
        data: 42,
        mediaType: 'image/png',
        type: 'file',
      },
    ],
    [
      'non-string filename',
      {
        data: PNG_DATA_URL,
        filename: 42,
        mediaType: 'image/png',
        type: 'file',
      },
    ],
  ])('rejects a malformed file candidate with %s before text extraction', (_case, part) => {
    let caught: unknown;
    try {
      convertAssistantUiMessages([
        {
          content: [part],
          id: 'u1',
          role: 'user',
        },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AssistantAttachmentValidationError);
    expect(caught).toMatchObject({ reason: 'invalid-file-part' });
  });

  it('collects attachments only from direct user content and parts positions', () => {
    const contentFile = {
      data: PNG_DATA_URL,
      filename: 'content.png',
      mediaType: 'image/png',
      type: 'file',
    };
    const partsFile = {
      data: PNG_DATA_URL,
      filename: 'parts.png',
      mediaType: 'image/png',
      type: 'file',
    };
    const nestedFile = {
      data: PNG_DATA_URL,
      filename: 'nested.png',
      mediaType: 'image/png',
      type: 'file',
    };

    const messages = convertAssistantUiMessages([
      {
        content: [
          { text: 'inspect these', type: 'text' },
          contentFile,
          { data: { attachment: nestedFile }, type: 'data' },
        ],
        id: 'u1',
        parts: [partsFile],
        role: 'user',
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'u1',
        parts: [{ text: 'inspect these', type: 'text' }, contentFile, partsFile],
        role: 'user',
      },
    ]);
  });

  it('keeps tool-result domain objects opaque even when they use type file', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [
          {
            input: { path: '.' },
            toolCallId: 'call-1',
            toolName: 'brainstrike.readWorkspaceDirectory',
            type: 'tool-call',
          },
        ],
        id: 'a1',
        role: 'assistant',
      },
      {
        content: [
          {
            output: {
              entries: [
                { path: 'README.md', type: 'file' },
                { path: 'packages', type: 'directory' },
              ],
            },
            toolCallId: 'call-1',
            toolName: 'brainstrike.readWorkspaceDirectory',
            type: 'tool-result',
          },
        ],
        id: 'tool-1',
        role: 'tool',
      },
      {
        content: [{ text: 'continue', type: 'text' }],
        id: 'u2',
        role: 'user',
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'u2',
        parts: [{ text: 'continue', type: 'text' }],
        role: 'user',
      },
    ]);
  });

  it('does not flatten a near-miss file discriminator into prompt text', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [
          { text: 'describe the safe text', type: 'text' },
          {
            data: PNG_DATA_URL,
            mediaType: 'image/png',
            type: 'file-preview',
          },
        ],
        id: 'u1',
        role: 'user',
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'u1',
        parts: [{ text: 'describe the safe text', type: 'text' }],
        role: 'user',
      },
    ]);
  });

  it('does not exempt hidden file-shaped payloads from the normal string budget', () => {
    const hiddenDataUrl = `data:image/png;base64,${'A'.repeat(
      MAX_ASSISTANT_MESSAGE_STRING_CHARS + 4
    )}`;

    expect(() =>
      convertAssistantUiMessages([
        {
          content: [
            {
              data: {
                data: hiddenDataUrl,
                mediaType: 'image/png',
                type: 'file',
              },
              type: 'data',
            },
          ],
          id: 'u1',
          role: 'user',
        },
      ])
    ).toThrow('Assistant message payload contains an oversized string.');
  });

  it('counts every attachment occurrence even when references share one object', () => {
    const sharedPart = {
      data: PNG_DATA_URL,
      mediaType: 'image/png',
      type: 'file',
    };

    expect(() =>
      convertAssistantUiMessages([
        {
          content: [sharedPart, sharedPart, sharedPart, sharedPart, sharedPart],
          id: 'u1',
          role: 'user',
        },
      ])
    ).toThrow(/5 attachments/i);
  });

  it('throws loudly when a message exceeds the attachment count cap', () => {
    const parts = Array.from({ length: 5 }, () => ({
      data: PNG_DATA_URL,
      mediaType: 'image/png',
      type: 'file',
    }));
    expect(() =>
      convertAssistantUiMessages([
        {
          content: parts,
          id: 'u1',
          role: 'user',
        },
      ])
    ).toThrow(/attachment/i);
  });

  it('checks attachment count before measuring an oversized file', () => {
    const oversizedBody = 'A'.repeat(Math.ceil((6 * 1024 * 1024) / 3) * 4);
    const parts = [
      {
        data: `data:image/png;base64,${oversizedBody}`,
        mediaType: 'image/png',
        type: 'file',
      },
      ...Array.from({ length: 4 }, () => ({
        data: PNG_DATA_URL,
        mediaType: 'image/png',
        type: 'file',
      })),
    ];

    try {
      convertAssistantUiMessages([{ content: parts, id: 'u1', role: 'user' }]);
      expect.unreachable('five attachments must be rejected before per-file measurement');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantAttachmentValidationError);
      expect(error).toMatchObject({ reason: 'too-many-attachments' });
    }
  });

  it('throws loudly when the combined attachment payload exceeds the shared cap', () => {
    // Three ~4MB images: each under the 5MB per-image cap, combined 12MB over
    // the 10MB combined cap.
    const fourMbBody = 'A'.repeat(Math.ceil((4 * 1024 * 1024) / 3) * 4);
    const parts = Array.from({ length: 3 }, () => ({
      data: `data:image/png;base64,${fourMbBody}`,
      mediaType: 'image/png',
      type: 'file',
    }));
    expect(() => convertAssistantUiMessages([{ content: parts, id: 'u1', role: 'user' }])).toThrow(
      /combined/i
    );
  });

  it('ignores file parts on assistant messages without leaking them as text', () => {
    const messages = convertAssistantUiMessages([
      { content: [{ text: 'earlier answer', type: 'text' }], id: 'a1', role: 'assistant' },
      {
        content: [
          { text: 'follow-up', type: 'text' },
          { data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' },
        ],
        id: 'a2',
        role: 'assistant',
      },
    ]);

    const assistantWithFile = messages.find((message) => message.id === 'a2');
    expect(assistantWithFile?.parts).toEqual([{ text: 'follow-up', type: 'text' }]);
  });
});

describe('convertAssistantUiMessages', () => {
  beforeEach(() => {
    streamMastraAgentMock.mockReset();
  });

  it('extracts unique text segments across nested assistant-ui nodes', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [
          'Hello world',
          { text: 'Additional context' },
          { value: 123 },
          { text: 'Additional context', type: 'text' },
          { payload: { text: 'must stay opaque' }, type: 'data' },
        ],
        id: 42,
        parts: [{ text: 'Parts text', type: 'text' }],
        role: 'User',
        text: '  Hello world  ',
      },
    ]);

    expect(messages).toHaveLength(1);
    const [first] = messages as [AgentMessage];
    expect(first.id).toBe('42');
    expect(first.role).toBe('user');
    expect(first.parts).toEqual([
      { text: 'Hello world', type: 'text' },
      { text: 'Additional context', type: 'text' },
      { text: '123', type: 'text' },
      { text: 'Parts text', type: 'text' },
    ]);
  });

  it('rejects deeply nested message graphs before recursive normalization', () => {
    let nested: Record<string, unknown> = { text: 'hello' };
    for (let depth = 0; depth < 3000; depth += 1) {
      nested = { content: nested };
    }

    expect(() =>
      convertAssistantUiMessages([{ content: nested, id: 'deep-1', role: 'user' }])
    ).toThrow(AssistantMessageValidationError);
    expect(() =>
      convertAssistantUiMessages([{ content: nested, id: 'deep-1', role: 'user' }])
    ).toThrow('Assistant message payload exceeds the nesting depth limit.');
  });

  it('rejects cyclic object graphs but permits repeated JSON-safe values', () => {
    const cyclic: Record<string, unknown> = { text: 'hello' };
    cyclic['self'] = cyclic;

    expect(() =>
      assertAssistantMessageGraphWithinLimits([{ content: cyclic, role: 'user' }])
    ).toThrow('Assistant message payload contains a cyclic object graph.');

    const shared = { text: 'shared' };
    expect(() =>
      assertAssistantMessageGraphWithinLimits([{ children: [shared, shared], role: 'user' }])
    ).not.toThrow();
  });

  it('rejects bigint because it cannot cross the JSON message boundary', () => {
    expect(() =>
      assertAssistantMessageGraphWithinLimits([
        { content: { value: 7n }, id: 'bigint-1', role: 'user' },
      ])
    ).toThrow('Assistant message payload contains an unsupported value.');
  });

  it('bounds message and part array cardinality before normalization', () => {
    expect(() =>
      assertAssistantMessageGraphWithinLimits(
        Array.from({ length: MAX_ASSISTANT_MESSAGES + 1 }, () => null)
      )
    ).toThrow('Assistant message payload exceeds the message count limit.');
    expect(() =>
      assertAssistantMessageGraphWithinLimits([
        {
          parts: Array.from({ length: MAX_ASSISTANT_MESSAGE_ARRAY_ITEMS + 1 }, () => null),
          role: 'user',
        },
      ])
    ).toThrow('Assistant message payload exceeds the array item limit.');
  });

  it('bounds total message graph nodes even when each collection stays under its cap', () => {
    const messages = Array.from({ length: MAX_ASSISTANT_MESSAGES }, () => ({
      parts: Array.from({ length: 25 }, () => ({ text: 'x' })),
      role: 'assistant',
    }));

    expect(messages.length * 53).toBeGreaterThan(MAX_ASSISTANT_MESSAGE_GRAPH_NODES);
    expect(() => assertAssistantMessageGraphWithinLimits(messages)).toThrow(
      'Assistant message payload exceeds the node count limit.'
    );
  });

  it('bounds individual message strings', () => {
    expect(() =>
      assertAssistantMessageGraphWithinLimits([
        { role: 'user', text: 'x'.repeat(MAX_ASSISTANT_MESSAGE_STRING_CHARS + 1) },
      ])
    ).toThrow('Assistant message payload contains an oversized string.');
  });

  it('does not extract assistant-ui part discriminators as prompt text', () => {
    const messages = convertAssistantUiMessages([
      {
        content: [{ text: 'Hello', type: 'text' }],
        id: 'msg-1',
        role: 'user',
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'msg-1',
        parts: [{ text: 'Hello', type: 'text' }],
        role: 'user',
      },
    ]);
  });

  it('never reclassifies unknown or tool roles as a user message', () => {
    const messages = convertAssistantUiMessages([
      { role: 'unknown', text: '' },
      { role: 'assistant-ish', text: 'must not become a user prompt' },
      {
        content: [{ output: { value: 'must stay a tool result' }, type: 'tool-result' }],
        role: 'tool',
      },
    ]);

    expect(messages).toEqual([]);
  });
});

describe('toAiSdkStyleStream', () => {
  const originalEnvValue = process.env['OPENAI_API_KEY'];

  beforeEach(() => {
    streamMastraAgentMock.mockReset();
    process.env['OPENAI_API_KEY'] = 'env-key';
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      process.env['OPENAI_API_KEY'] = undefined;
    } else {
      process.env['OPENAI_API_KEY'] = originalEnvValue;
    }
  });

  it('forwards model, mcp config, and tools to streamMastraAgent', async () => {
    const asyncStream = (async function* () {
      /* noop */
    })();
    streamMastraAgentMock.mockResolvedValue(asyncStream);

    const toolStub = {
      foo: { description: 'stub', id: 'foo' },
    } as unknown as NonNullable<RuntimeData['mastraTools']>;
    const runtime: RuntimeData = {
      mastraTools: toolStub,
      mcpConfig: {
        servers: [
          {
            command: 'echo',
            name: 'stdio-test',
            transport: 'stdio',
          },
        ],
      },
      model: 'gpt-test',
    };
    const messages: AgentMessage[] = [
      { id: '1', parts: [{ text: 'hi', type: 'text' }], role: 'user' },
    ];

    const result = await toAiSdkStyleStream(messages, runtime);

    expect(result).toBe(asyncStream);
    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages, options] = streamMastraAgentMock.mock.calls[0] as unknown as [
      AgentMessage[],
      Record<string, unknown>,
    ];
    expect(passedMessages).toEqual([
      buildWorkspaceRootManifestContextMessage(runtime),
      ...messages,
    ]);
    expect(options['model']).toBe('gpt-test');
    expect((options['mcpConfig'] as RuntimeData['mcpConfig'])?.servers?.[0]?.name).toBe(
      'stdio-test'
    );
    expect(options['tools']).toBe(toolStub);
    expect(options['runtime']).toEqual(runtime);
  });

  it('sends only the current turn when Mastra memory is active', async () => {
    const asyncStream = (async function* () {
      /* noop */
    })();
    streamMastraAgentMock.mockResolvedValue(asyncStream);
    const messages: AgentMessage[] = [
      { id: '1', parts: [{ text: 'old question', type: 'text' }], role: 'user' },
      { id: '2', parts: [{ text: 'old answer', type: 'text' }], role: 'assistant' },
      { id: '3', parts: [{ text: 'current question', type: 'text' }], role: 'user' },
    ];

    const runtime: RuntimeData = {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    };
    await toAiSdkStyleStream(messages, runtime);

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([
      buildWorkspaceRootManifestContextMessage(runtime),
      messages[2],
    ]);
  });

  it('keeps trailing tool messages with the active turn when Mastra memory is active', async () => {
    const asyncStream = (async function* () {
      /* noop */
    })();
    streamMastraAgentMock.mockResolvedValue(asyncStream);
    const messages: AgentMessage[] = [
      { id: '1', parts: [{ text: 'old question', type: 'text' }], role: 'user' },
      { id: '2', parts: [{ text: 'old answer', type: 'text' }], role: 'assistant' },
      { id: '3', parts: [{ text: 'current question', type: 'text' }], role: 'user' },
      {
        id: '4',
        parts: [
          {
            input: {},
            output: 'done',
            state: 'output-available',
            type: 'tool-search',
          },
        ],
        role: 'assistant',
      },
    ];

    const runtime: RuntimeData = {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    };
    await toAiSdkStyleStream(messages, runtime);

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([
      buildWorkspaceRootManifestContextMessage(runtime),
      ...messages.slice(2),
    ]);
  });

  it('preserves leading system-context precedence while trimming memory history', async () => {
    const asyncStream = (async function* () {
      /* noop */
    })();
    streamMastraAgentMock.mockResolvedValue(asyncStream);
    const messages: AgentMessage[] = [
      { id: 'system-1', parts: [{ text: 'Use workspace context.', type: 'text' }], role: 'system' },
      { id: '1', parts: [{ text: 'old question', type: 'text' }], role: 'user' },
      { id: '2', parts: [{ text: 'old answer', type: 'text' }], role: 'assistant' },
      { id: '3', parts: [{ text: 'current question', type: 'text' }], role: 'user' },
    ];

    const runtime: RuntimeData = {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    };
    await toAiSdkStyleStream(messages, runtime);

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([
      messages[0],
      buildWorkspaceRootManifestContextMessage(runtime),
      messages[3],
    ]);
  });

  it('rejects memory-backed streams without a user turn', async () => {
    const messages: AgentMessage[] = [
      { id: 'system-1', parts: [{ text: 'Use context.', type: 'text' }], role: 'system' },
      { id: 'assistant-1', parts: [{ text: 'No prompt.', type: 'text' }], role: 'assistant' },
    ];

    await expect(
      toAiSdkStyleStream(messages, {
        memory: {
          resourceId: 'workspace-a',
          threadId: 'thread-1',
        },
      })
    ).rejects.toThrow('Mastra memory requires a current user message');
    expect(streamMastraAgentMock).not.toHaveBeenCalled();
  });
});
