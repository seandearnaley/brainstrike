import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMastraAgentRuntime, streamMastraAgent } from '../mastra/agent-runtime';

const agentInstances: Array<{
  config: { tools?: Record<string, unknown> };
  tools?: Record<string, unknown>;
}> = [];
const mcpInstances: unknown[] = [];
let streamParts: unknown[] = [];

function setMockStreamParts(parts: unknown[]) {
  streamParts = [...parts];
}

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => (modelId: string) => ({ modelId }),
}));

vi.mock('@mastra/core/agent', () => {
  return {
    Agent: class {
      static reset() {
        agentInstances.length = 0;
      }

      config: { tools?: Record<string, unknown> };
      tools?: Record<string, unknown>;

      constructor(config: { tools?: Record<string, unknown> }) {
        this.config = config;
        this.tools = config.tools;
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
});
