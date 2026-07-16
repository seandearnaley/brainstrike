import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage, RuntimeData } from '../index';
import { convertAssistantUiMessages, toAiSdkStyleStream } from '../index';

const { streamMastraAgentMock } = vi.hoisted(() => ({
  streamMastraAgentMock: vi.fn(),
}));

vi.mock('../mastra/agent-runtime', async () => {
  const actual =
    await vi.importActual<typeof import('../mastra/agent-runtime')>('../mastra/agent-runtime');
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
          { children: [{ text: 'Nested text' }] },
          { values: [true, false, 'Additional context'] },
        ],
        id: 42,
        parts: {
          messages: [{ text: 'Hello world' }, { value: 7n }],
        },
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
      { text: 'Nested text', type: 'text' },
      { text: 'true', type: 'text' },
      { text: 'false', type: 'text' },
      { text: '7', type: 'text' },
    ]);
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

  it('falls back to the last message with a default role when conversion produced no entries', () => {
    const fallbackMessages = convertAssistantUiMessages([
      { role: 'unknown', text: '' },
      { role: 'assistant-ish', text: 'needs fallback' },
    ]);

    expect(fallbackMessages).toHaveLength(1);
    const [fallback] = fallbackMessages as [AgentMessage];
    expect(fallback.role).toBe('user');
    expect(fallback.parts).toEqual([{ text: 'needs fallback', type: 'text' }]);
    expect(typeof fallback.id).toBe('string');
    expect(fallback.id.length).toBeGreaterThan(0);
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
    expect(passedMessages).toEqual(messages);
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

    await toAiSdkStyleStream(messages, {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    });

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([messages[2]]);
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
            toolInvocation: {
              args: {},
              result: 'done',
              state: 'result',
              toolCallId: 'tc-1',
              toolName: 'search',
            },
            type: 'tool-invocation',
          },
        ],
        role: 'assistant',
      },
    ];

    await toAiSdkStyleStream(messages, {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    });

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual(messages.slice(2));
  });

  it('preserves system context while trimming history when Mastra memory is active', async () => {
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

    await toAiSdkStyleStream(messages, {
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
    });

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([messages[0], messages[3]]);
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
