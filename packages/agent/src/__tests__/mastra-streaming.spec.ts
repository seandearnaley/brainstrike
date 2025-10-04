import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMastraAgentRuntime, streamMastraAgent } from '../mastra/agent-runtime';

const agentInstances: Array<{
  config: { tools: Record<string, unknown> };
  tools: Record<string, unknown>;
}> = [];
const mcpInstances: unknown[] = [];
let streamParts: unknown[] = [];

function setMockStreamParts(parts: unknown[]) {
  streamParts = [...parts];
}

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (config?: { apiKey?: string; baseURL?: string }) => (modelId: string) => ({
    modelId,
    provider: config?.baseURL?.includes('openrouter') ? 'openrouter' : 'openai',
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ modelId, provider: 'anthropic' }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (modelId: string) => ({ modelId, provider: 'google' }),
}));

vi.mock('@mastra/core/agent', () => {
  return {
    Agent: class {
      static reset() {
        agentInstances.length = 0;
      }

      config: { tools: Record<string, unknown> };
      tools: Record<string, unknown>;
      model?: { modelId: string; provider?: string } | undefined;

      constructor(config: {
        tools?: Record<string, unknown>;
        model?: { modelId: string; provider?: string } | undefined;
      }) {
        const tools = (config.tools ?? {}) as Record<string, unknown>;
        this.config = { tools };
        this.tools = tools;
        this.model = config.model;
        agentInstances.push(this);
      }

      async stream() {
        async function* generator() {
          for (const part of streamParts) {
            yield part;
          }
        }
        return {
          fullStream: Promise.resolve(generator()),
        };
      }

      async streamVNext() {
        const stream = new ReadableStream({
          start(controller) {
            for (const part of streamParts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        });
        return {
          fullStream: stream,
        } as { fullStream: ReadableStream<unknown> };
      }

      __setTools(tools: Record<string, unknown>) {
        this.tools = tools;
      }
    },
  };
});

vi.mock('@mastra/mcp', () => {
  return {
    MCPClient: class {
      options: unknown;

      constructor(options: unknown) {
        this.options = options;
        mcpInstances.push(this);
      }

      async getTools() {
        return {
          'remote tool': { id: 'remote tool', description: 'remote' },
        } satisfies Record<string, { id: string; description: string }>;
      }

      async disconnect() {
        return undefined;
      }
    },
  };
});

describe('mastra streaming integration', () => {
  beforeEach(() => {
    agentInstances.length = 0;
    mcpInstances.length = 0;
    setMockStreamParts([]);
  });

  it('yields streaming chunks by awaiting the Mastra fullStream promise', async () => {
    setMockStreamParts([
      { type: 'text-delta', textDelta: 'hello' },
      { type: 'finish', usage: { promptTokens: 7, completionTokens: 11 } },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'hi there' }],
        },
      ],
      { runtime: { apiKey: 'test-key' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text-delta', value: 'hello' },
      {
        type: 'message-finish',
        finishReason: 'stop',
        usage: { promptTokens: 7, completionTokens: 11 },
        path: [],
      },
    ]);
  });

  it('propagates tool-call events as tool-event chunks', async () => {
    setMockStreamParts([
      { type: 'tool-call', toolName: 'web.searchDocs', toolCallId: 'c1', args: { query: 'x' } },
      { type: 'tool-call-delta', toolCallId: 'c1', argsTextDelta: 'que' },
      { type: 'tool-result', toolCallId: 'c1', result: { totalResults: 1 } },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'search' }] }],
      { runtime: { apiKey: 'test-key' } }
    );

    const toolEvents: Array<{ type: string; name?: string; status?: string }> = [];
    let finished = false;
    for await (const chunk of iterator) {
      if (chunk.type === 'tool-event') toolEvents.push(chunk);
      if (chunk.type === 'message-finish') finished = true;
    }

    expect(toolEvents[0]).toMatchObject({
      type: 'tool-event',
      name: 'web.searchDocs',
      status: 'start',
    });
    expect(toolEvents[1]).toMatchObject({ type: 'tool-event', status: 'progress' });
    expect(toolEvents[2]).toMatchObject({ type: 'tool-event', status: 'success' });
    expect(finished).toBe(true);
  });

  it('throws stream_failure when Mastra fullStream resolves to null', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const originalStreamVNext = Agent.prototype.streamVNext;
    // @ts-expect-error – test-only override
    Agent.prototype.streamVNext = async function streamVNext() {
      return { fullStream: null as unknown as ReadableStream<unknown> };
    };

    await expect(
      streamMastraAgent([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
        runtime: { apiKey: 'test-key' },
      })
    ).rejects.toThrow(/mastra_agent_stream_failure/i);

    Agent.prototype.streamVNext = originalStreamVNext;
  });
  it('merges local and MCP tools while tracking sanitized tool names', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key' },
      tools: {
        'local tool': {
          id: 'local tool',
          description: 'local',
        },
      },
      mcpConfig: {
        servers: [
          {
            transport: 'stdio',
            name: 'filesystem',
            command: 'echo',
          },
        ],
      },
    });

    expect(agentInstances).toHaveLength(1);
    const agentConfig = agentInstances[0]?.config.tools ?? {};

    expect(Object.keys(agentConfig)).toEqual(expect.arrayContaining(['local_tool', 'remote_tool']));

    expect(runtime.toolNameMap.get('local_tool')).toBe('local tool');
    expect(runtime.toolNameMap.get('remote_tool')).toBe('remote tool');
  });

  it('keeps tools distinct when sanitized ids would otherwise collide', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key' },
      tools: {
        'web.search': {
          id: 'web.search',
          description: 'first',
        },
        'web/search': {
          id: 'web/search',
          description: 'second',
        },
      },
    });

    const agentConfig = agentInstances[0]?.config.tools ?? {};
    const sanitizedNames = Object.keys(agentConfig);

    expect(new Set(sanitizedNames).size).toBe(2);
    expect(runtime.toolNameMap.get('web_search')).toBe('web.search');

    const collisionResolvedName = sanitizedNames.find((value) => value !== 'web_search');
    expect(collisionResolvedName).toBeDefined();
    expect(runtime.toolNameMap.get(collisionResolvedName as string)).toBe('web/search');
  });

  it('creates agent with OpenAI provider when no provider specified', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('gpt-4o-mini');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('openai');
  });

  it('creates agent with Anthropic provider when specified', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'anthropic' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('claude-3-5-haiku-latest');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('anthropic');
  });

  it('creates agent with Google provider when specified', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'google' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('gemini-2.5-flash');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('google');
  });

  it('creates agent with OpenRouter provider when specified', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'openrouter' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('gpt-4o-mini');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('openrouter');
  });

  it('uses custom model when specified with provider', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'anthropic' },
      model: 'claude-opus-4-1',
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('claude-opus-4-1');
  });

  it('falls back to OpenAI for unsupported provider', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'unsupported' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('openai');
  });
});

import { ReadableStream } from 'node:stream/web';
