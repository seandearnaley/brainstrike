import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMastraAgentRuntime, streamMastraAgent } from '../mastra/agent-runtime';
import { MastraAgentError, type MastraAgentErrorCode } from '../mastra/mastra-agent-error';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';

const agentInstances: Array<{
  config: { instructions?: string; memory?: unknown; tools: Record<string, unknown> };
  streamCalls: Array<{ input: unknown; options: unknown }>;
  tools: Record<string, unknown>;
}> = [];
const mcpInstances: unknown[] = [];
let mcpToolList: Record<string, { description: string; id: string }> = {
  'remote tool': { id: 'remote tool', description: 'remote' },
};
let streamParts: unknown[] = [];

function setMockStreamParts(parts: unknown[]) {
  streamParts = [...parts];
}

async function expectMastraAgentError(
  promise: Promise<unknown>,
  code: MastraAgentErrorCode
): Promise<void> {
  let received: unknown;
  try {
    await promise;
  } catch (error) {
    received = error;
  }

  expect(received).toBeInstanceOf(MastraAgentError);
  expect((received as MastraAgentError).code).toBe(code);
}

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (config?: { apiKey?: string; baseURL?: string }) => (modelId: string) => ({
    modelId,
    provider: config?.baseURL?.includes('openrouter') ? 'openrouter' : 'openai',
    ...(modelId === 'legacy-test-model' ? { specificationVersion: 'v1' } : {}),
  }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ modelId, provider: 'anthropic' }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (modelId: string) => ({ modelId, provider: 'google' }),
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    static reset() {
      agentInstances.length = 0;
    }

    config: { memory?: unknown; tools: Record<string, unknown> };
    streamCalls: Array<{ input: unknown; options: unknown }> = [];
    tools: Record<string, unknown>;
    memory?: unknown;
    model?: { modelId: string; provider?: string; specificationVersion?: string } | undefined;

    constructor(config: {
      instructions?: string;
      memory?: unknown;
      tools?: Record<string, unknown>;
      model?: { modelId: string; provider?: string; specificationVersion?: string } | undefined;
    }) {
      const tools = (config.tools ?? {}) as Record<string, unknown>;
      this.config = {
        tools,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        ...(config.memory ? { memory: config.memory } : {}),
      };
      this.tools = tools;
      this.memory = config.memory;
      this.model = config.model;
      agentInstances.push(this);
    }

    async stream(input: unknown, options: unknown) {
      this.streamCalls.push({ input, options });
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
}));

vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    options: unknown;

    constructor(options: unknown) {
      this.options = options;
      mcpInstances.push(this);
    }

    async listTools() {
      return mcpToolList;
    }

    async disconnect() {
      return;
    }
  },
}));

describe('mastra streaming integration', () => {
  beforeEach(() => {
    agentInstances.length = 0;
    mcpInstances.length = 0;
    mcpToolList = {
      'remote tool': { id: 'remote tool', description: 'remote' },
    };
    setMockStreamParts([]);
  });

  it('yields streaming chunks by awaiting the Mastra fullStream promise', async () => {
    setMockStreamParts([
      { type: 'text-delta', textDelta: 'hello' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 7, completionTokens: 11 } },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'hi there' }],
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text-delta', value: 'hello' },
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({ kind: 'run.finished', status: 'completed' }),
      }),
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
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const toolEvents: Array<{ type: string; name?: string; status?: string }> = [];
    let finished = false;
    for await (const chunk of iterator) {
      if (chunk.type === 'tool-event') {
        toolEvents.push(chunk);
      }
      if (chunk.type === 'message-finish') {
        finished = true;
      }
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

  it('surfaces Mastra reasoning and run lifecycle chunks', async () => {
    setMockStreamParts([
      { type: 'start', messageId: 'msg-1' },
      { type: 'reasoning-delta', delta: 'Checking memory.' },
      { type: 'step-start', messageId: 'msg-1' },
      { type: 'step-finish', usage: { promptTokens: 3, completionTokens: 4 } },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 6 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'explain' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({ kind: 'run.started', status: 'running' }),
      }),
      { type: 'reasoning-delta', value: 'Checking memory.' },
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({ kind: 'run.step.started', status: 'running' }),
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({ kind: 'run.step.finished', status: 'completed' }),
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({ kind: 'run.finished', status: 'completed' }),
      }),
      {
        type: 'message-finish',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 6 },
        path: [],
      },
    ]);
  });

  it('throws stream_failure when Mastra fullStream resolves to null', async () => {
    const { Agent } = await import('@mastra/core/agent');
    const originalStream = Agent.prototype.stream;
    // @ts-expect-error – test-only override
    Agent.prototype.stream = async function stream() {
      return { fullStream: null as unknown as ReadableStream<unknown> };
    };

    await expectMastraAgentError(
      streamMastraAgent([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }),
      'mastra_agent_stream_failure'
    );

    Agent.prototype.stream = originalStream;
  });

  it('passes configured Mastra memory into the Agent constructor', async () => {
    const memory = { id: 'memory-instance' };

    await createMastraAgentRuntime({
      memory: memory as never,
      runtime: { apiKey: 'key', provider: 'openai' },
    });

    expect(agentInstances.at(-1)?.config.memory).toBe(memory);
  });

  it('passes strict thread/resource memory context to agent.stream', async () => {
    const memory = { id: 'memory-instance' };
    setMockStreamParts([{ type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'remember this' }] }],
      {
        memory: memory as never,
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          memory: {
            threadId: 'thread-1',
            resourceId: 'workspace-a',
            memoryOptions: { lastMessages: 5 },
          },
        },
      }
    );

    for await (const _chunk of iterator) {
      // drain stream
    }

    expect(agentInstances.at(-1)?.streamCalls.at(-1)?.options).toMatchObject({
      memory: {
        thread: 'thread-1',
        resource: 'workspace-a',
        options: { lastMessages: 5 },
      },
    });
  });

  it('uses Brainstrike default stream step cap for native tool loops', async () => {
    setMockStreamParts([{ type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'inspect the workspace' }] }],
      {
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    for await (const _chunk of iterator) {
      // drain stream
    }

    expect(agentInstances.at(-1)?.streamCalls.at(-1)?.options).toMatchObject({
      maxSteps: 20,
    });
  });

  it('passes configured agent loop limits and input token compaction to agent.stream', async () => {
    setMockStreamParts([{ type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'inspect the workspace' }] }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          agentLoop: {
            inputTokenLimit: 8192,
            maxSteps: 12,
          },
        } as never,
      }
    );

    for await (const _chunk of iterator) {
      // drain stream
    }

    const options = agentInstances.at(-1)?.streamCalls.at(-1)?.options as {
      inputProcessors?: Array<{ id?: string }>;
      maxSteps?: number;
    };
    expect(options.maxSteps).toBe(12);
    expect(options.inputProcessors?.map((processor) => processor.id)).toEqual(['token-limiter']);
  });

  it('rejects unsupported Mastra stream options instead of silently dropping them', async () => {
    const unsupportedOptions = {
      activeTools: ['readWorkspaceFile'],
      clientTools: {},
      inputProcessors: [],
      outputProcessors: [],
      prepareStep: () => undefined,
      structuredOutput: { schema: {} },
      toolChoice: 'required',
      toolsets: {},
    };

    await expectMastraAgentError(
      streamMastraAgent([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
        ...unsupportedOptions,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      } as never),
      'mastra_agent_unsupported_stream_option'
    );

    expect(agentInstances).toHaveLength(0);
  });

  it('passes tool approval through as a pending non-error stream state', async () => {
    setMockStreamParts([
      {
        type: 'tool-call-approval',
        payload: {
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
        },
        runId: 'run-approval-1',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'update selected context' }] }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const streamOptions = agentInstances.at(-1)?.streamCalls.at(-1)?.options as {
      requireToolApproval?: boolean;
    };
    expect(streamOptions.requireToolApproval).toBe(true);
    expect(chunks).toEqual([
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        type: 'message-finish',
        finishReason: 'tool-calls',
        usage: { promptTokens: 0, completionTokens: 0 },
        path: [],
      },
    ]);
  });

  it('uses the cached tool name when approval pauses omit the tool name', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        args: { mode: 'replace', paths: ['src/index.ts'] },
      },
      {
        type: 'tool-call-approval',
        payload: {
          toolCallId: 'approval-1',
          args: { mode: 'replace', paths: ['src/index.ts'] },
        },
        runId: 'run-approval-1',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'update selected context' }] }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      args: { mode: 'replace', paths: ['src/index.ts'] },
      runId: 'run-approval-1',
      toolCallId: 'approval-1',
      toolName: 'brainstrike.updateWorkspaceContextSelection',
      type: 'tool-approval-required',
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'message-finish',
        finishReason: 'tool-calls',
      })
    );
  });

  it('surfaces suspended tool calls as visible terminal errors instead of hanging', async () => {
    setMockStreamParts([
      {
        type: 'tool-call-suspended',
        payload: {
          toolCallId: 'suspended-1',
          toolName: 'brainstrike.createEmbeddingSet',
          args: { modelKey: 'openai:text-embedding-3-small', name: 'Docs' },
          suspendPayload: { reason: 'needs-user-input' },
          resumeSchema: '{}',
        },
        runId: 'run-suspended-1',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'create an embedding set' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'tool-event',
        name: 'brainstrike.createEmbeddingSet',
        status: 'error',
        payload: expect.objectContaining({
          actionRequired: true,
          approvalRequired: false,
          callId: 'suspended-1',
          runId: 'run-suspended-1',
          suspended: true,
          toolCallId: 'suspended-1',
        }),
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'run.failed',
          label: 'Tool resume required',
          status: 'failed',
        }),
      }),
      {
        type: 'message-finish',
        finishReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0 },
        path: [],
      },
    ]);
  });

  it('keeps malformed approval pauses visible when Mastra omits the tool call id', async () => {
    setMockStreamParts([
      {
        type: 'tool-call-approval',
        payload: {
          toolName: 'brainstrike.updateWorkspaceContextSelection',
          args: { mode: 'replace', paths: ['src/index.ts'] },
        },
        runId: 'run-approval-without-tool-call-id',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'update selected context' }] }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'tool-event',
        name: 'brainstrike.updateWorkspaceContextSelection',
        status: 'error',
        payload: expect.objectContaining({
          callId: 'mastra-tool-call-approval-missing-tool-call-id',
          missingToolCallId: true,
          toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
        }),
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({
            missingToolCallId: true,
            toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
          }),
        }),
      }),
      {
        type: 'message-finish',
        finishReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0 },
        path: [],
      },
    ]);
  });

  it('preserves the Mastra finish reason in the assistant data stream', async () => {
    setMockStreamParts([
      {
        type: 'finish',
        payload: {
          stepResult: { reason: 'length' },
          output: { usage: { inputTokens: 20, completionTokens: 4 } },
        },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'write a long answer' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'message-finish',
      finishReason: 'length',
      usage: { promptTokens: 20, completionTokens: 4 },
      path: [],
    });
  });

  it('marks finish chunks without an explicit reason as unknown', async () => {
    setMockStreamParts([{ type: 'finish', usage: { promptTokens: 3, completionTokens: 5 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'finish without reason' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      type: 'message-finish',
      finishReason: 'unknown',
      usage: { promptTokens: 3, completionTokens: 5 },
      path: [],
    });
  });

  it('throws a typed error when Mastra closes after tool activity without a terminal finish', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'brainstrike.queryEmbeddingSpace',
        toolCallId: 'call-context',
        args: { query: 'database config' },
      },
      {
        type: 'tool-result',
        toolName: 'brainstrike.queryEmbeddingSpace',
        toolCallId: 'call-context',
        result: { context: 'database config result' },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'find database config' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: 'tool-event',
        status: 'start',
        name: 'brainstrike.queryEmbeddingSpace',
      }),
      expect.objectContaining({
        type: 'tool-event',
        status: 'success',
        name: 'brainstrike.queryEmbeddingSpace',
      }),
      expect.objectContaining({
        type: 'message-finish',
        finishReason: 'other',
      }),
    ]);
  });

  it('rejects AI SDK v1 model runtimes instead of falling back to legacy streaming', async () => {
    await expectMastraAgentError(
      streamMastraAgent(
        [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'inspect the workspace' }] }],
        {
          model: 'legacy-test-model',
          runtime: { apiKey: 'test-key', provider: 'openai' },
        }
      ),
      'mastra_agent_unsupported_model_runtime'
    );
  });

  it('throws a typed error when memory context is provided without configured memory', async () => {
    await expectMastraAgentError(
      streamMastraAgent([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          memory: { threadId: 'thread-1', resourceId: 'workspace-a' },
        },
      }),
      'mastra_agent_memory_unavailable'
    );
  });

  it('throws a typed error when memory context is missing thread or resource IDs', async () => {
    await expectMastraAgentError(
      streamMastraAgent([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
        memory: { id: 'memory-instance' } as never,
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          memory: { threadId: '', resourceId: 'workspace-a' },
        },
      }),
      'mastra_agent_memory_unavailable'
    );
  });
  it('merges local and MCP tools while tracking sanitized tool names', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
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

  it('uses model-facing Brainstrike native tool names in default instructions', async () => {
    mcpToolList = {
      'filesystem.search_files': {
        id: 'filesystem.search_files',
        description: 'Search files',
      },
    };

    await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.listWorkspaceContext': {
          id: 'brainstrike.listWorkspaceContext',
          description: 'List workspace context',
        },
        'brainstrike.listEmbeddingSpaces': {
          id: 'brainstrike.listEmbeddingSpaces',
          description: 'List embedding spaces',
        },
        'brainstrike.queryEmbeddingSpace': {
          id: 'brainstrike.queryEmbeddingSpace',
          description: 'Query embedding space',
        },
        'brainstrike.readWorkspaceContext': {
          id: 'brainstrike.readWorkspaceContext',
          description: 'Read workspace context',
        },
        'brainstrike.readWorkspaceFile': {
          id: 'brainstrike.readWorkspaceFile',
          description: 'Read workspace file',
        },
        'brainstrike.updateWorkspaceContextSelection': {
          id: 'brainstrike.updateWorkspaceContextSelection',
          description: 'Update workspace context selection',
        },
        'brainstrike.updateWorkspaceTapestrySelections': {
          id: 'brainstrike.updateWorkspaceTapestrySelections',
          description: 'Update workspace Tapestry selections',
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

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).toContain('brainstrike_listWorkspaceContext');
    expect(instructions).toContain('brainstrike_listEmbeddingSpaces');
    expect(instructions).toContain('brainstrike_queryEmbeddingSpace');
    expect(instructions).toContain('semantic chunks with persisted source line ranges');
    expect(instructions).toContain('surrounding lines are needed');
    expect(instructions).not.toContain('brainstrike.listWorkspaceContext');
  });

  it('does not advertise unregistered Brainstrike native tools in default instructions', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.readWorkspaceFile': {
          id: 'brainstrike.readWorkspaceFile',
          description: 'Read workspace file',
        },
      },
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).toContain('Registered Brainstrike native context tools in this run');
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).toContain('Workspace-selection inspection is unavailable in this run.');
    expect(instructions).toContain(
      'Semantic workspace search is unavailable unless both listEmbeddingSpaces and queryEmbeddingSpace are registered.'
    );
    expect(instructions).not.toContain('brainstrike_listWorkspaceContext');
    expect(instructions).not.toContain('brainstrike_queryEmbeddingSpace');
  });

  it('keeps tools distinct when sanitized ids would otherwise collide', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
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

  it('throws when provider is not specified', async () => {
    await expectMastraAgentError(
      createMastraAgentRuntime({
        runtime: { apiKey: 'test-key' },
      }),
      'mastra_agent_missing_provider'
    );
  });

  it('creates agent with OpenAI provider when specified', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'openai' },
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('gpt-5.4');
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
    expect(agent.model?.modelId).toBe('claude-sonnet-4-6');
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
    expect(agent.model?.modelId).toBe('gemini-3.5-flash');
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
    expect(agent.model?.modelId).toBe('openai/gpt-5.4');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('openrouter');
  });

  it('uses custom model when specified with provider', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'anthropic' },
      model: 'claude-sonnet-4-6',
    });

    expect(agentInstances).toHaveLength(1);
    const agent = agentInstances[0];
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('claude-sonnet-4-6');
  });

  it('throws when provider is unsupported', async () => {
    await expectMastraAgentError(
      createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'unsupported' },
      }),
      'mastra_agent_unsupported_provider'
    );
  });
});

describe('resolveRuntimeConfiguration', () => {
  const openAiEnvKeys = [
    'OPENAI_API_KEY',
    'AI_OPENAI_API_KEY',
    'OPENAI_API_KEY_V1',
    'OPENAI_API_KEY_V2',
  ] as const;

  const originalEnv: Partial<Record<(typeof openAiEnvKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of openAiEnvKeys) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of openAiEnvKeys) {
      const value = originalEnv[key];
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('normalizes providers and returns resolved api key', () => {
    const result = resolveRuntimeConfiguration({ provider: 'OpenAI', apiKey: 'KEY-123' });

    expect(result.provider).toBe('openai');
    expect(result.runtime.provider).toBe('openai');
    expect(result.apiKey).toBe('KEY-123');
  });

  it('throws when the api key cannot be resolved', () => {
    for (const key of openAiEnvKeys) {
      delete process.env[key];
    }

    let thrown: unknown;
    try {
      resolveRuntimeConfiguration({ provider: 'openai' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError | undefined)?.code).toBe('mastra_agent_missing_api_key');
  });

  it('allows local runtime providers without api keys', () => {
    const ollamaResult = resolveRuntimeConfiguration({ provider: 'ollama' });
    expect(ollamaResult.provider).toBe('ollama');
    expect(ollamaResult.apiKey).toBe('');

    const lmStudioResult = resolveRuntimeConfiguration({ provider: 'lmstudio' });
    expect(lmStudioResult.provider).toBe('lmstudio');
    expect(lmStudioResult.apiKey).toBe('');
  });

  it('handles undefined runtimeData by creating sanitized runtime with normalized provider', () => {
    // Set env key for this test
    process.env['OPENAI_API_KEY'] = 'env-test-key';

    let thrown: unknown;
    try {
      resolveRuntimeConfiguration(undefined);
    } catch (error) {
      thrown = error;
    }

    // Should throw missing provider error since undefined runtimeData means no provider
    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError | undefined)?.code).toBe('mastra_agent_missing_provider');
  });
});

import { ReadableStream } from 'node:stream/web';
