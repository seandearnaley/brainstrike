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

describe('convertAssistantUiMessages', () => {
  beforeEach(() => {
    streamMastraAgentMock.mockReset();
  });

  it('extracts unique text segments across nested assistant-ui nodes', () => {
    const messages = convertAssistantUiMessages([
      {
        id: 42,
        role: 'User',
        text: '  Hello world  ',
        content: [
          'Hello world',
          { text: 'Additional context' },
          { value: 123 },
          { children: [{ text: 'Nested text' }] },
          { values: [true, false, 'Additional context'] },
        ],
        parts: {
          messages: [{ text: 'Hello world' }, { value: 7n }],
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    const [first] = messages as [AgentMessage];
    expect(first.id).toBe('42');
    expect(first.role).toBe('user');
    expect(first.parts).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'text', text: 'Additional context' },
      { type: 'text', text: '123' },
      { type: 'text', text: 'Nested text' },
      { type: 'text', text: 'true' },
      { type: 'text', text: 'false' },
      { type: 'text', text: '7' },
    ]);
  });

  it('does not extract assistant-ui part discriminators as prompt text', () => {
    const messages = convertAssistantUiMessages([
      {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
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
    expect(fallback.parts).toEqual([{ type: 'text', text: 'needs fallback' }]);
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
      foo: { id: 'foo', description: 'stub' },
    } as unknown as NonNullable<RuntimeData['mastraTools']>;
    const runtime: RuntimeData = {
      model: 'gpt-test',
      mastraTools: toolStub,
      mcpConfig: {
        servers: [
          {
            name: 'stdio-test',
            transport: 'stdio',
            command: 'echo',
          },
        ],
      },
    };
    const messages: AgentMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
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
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'old question' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'current question' }] },
    ];

    await toAiSdkStyleStream(messages, {
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-a',
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
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'old question' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'current question' }] },
      {
        id: '4',
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'tc-1',
              toolName: 'search',
              args: {},
              result: 'done',
            },
          },
        ],
      },
    ];

    await toAiSdkStyleStream(messages, {
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-a',
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
      { id: 'system-1', role: 'system', parts: [{ type: 'text', text: 'Use workspace context.' }] },
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'old question' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'current question' }] },
    ];

    await toAiSdkStyleStream(messages, {
      memory: {
        threadId: 'thread-1',
        resourceId: 'workspace-a',
      },
    });

    expect(streamMastraAgentMock).toHaveBeenCalledTimes(1);
    const [passedMessages] = streamMastraAgentMock.mock.calls[0] as unknown as [AgentMessage[]];
    expect(passedMessages).toEqual([messages[0], messages[3]]);
  });

  it('rejects memory-backed streams without a user turn', async () => {
    const messages: AgentMessage[] = [
      { id: 'system-1', role: 'system', parts: [{ type: 'text', text: 'Use context.' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'No prompt.' }] },
    ];

    await expect(
      toAiSdkStyleStream(messages, {
        memory: {
          threadId: 'thread-1',
          resourceId: 'workspace-a',
        },
      })
    ).rejects.toThrow('Mastra memory requires a current user message');
    expect(streamMastraAgentMock).not.toHaveBeenCalled();
  });
});
