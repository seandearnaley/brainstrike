import { ReadableStream } from 'node:stream/web';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMastraAgentRuntime,
  streamMastraAgent,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from '../mastra/agent-runtime';
import { MastraAgentError, type MastraAgentErrorCode } from '../mastra/mastra-agent-error';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';

const agentInstances: Array<{
  approveToolCallCalls: unknown[];
  config: { instructions?: string; memory?: unknown; tools: Record<string, unknown> };
  declineToolCallCalls: unknown[];
  registeredMastra?: unknown;
  resumeStreamCalls: Array<{ options: unknown; resumeData: unknown }>;
  streamCalls: Array<{ input: unknown; options: unknown }>;
  tools: Record<string, unknown>;
}> = [];
const mcpInstances: unknown[] = [];
const mastraInstances: Array<{ config: unknown; shutdownCalls: number }> = [];
let mcpToolsets: Record<string, Record<string, { description: string; id: string }>> = {
  filesystem: {
    'remote tool': { description: 'remote', id: 'remote tool' },
  },
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
    approveToolCallCalls: unknown[] = [];
    declineToolCallCalls: unknown[] = [];
    registeredMastra?: unknown;
    resumeStreamCalls: Array<{ options: unknown; resumeData: unknown }> = [];
    streamCalls: Array<{ input: unknown; options: unknown }> = [];
    tools: Record<string, unknown>;
    memory?: unknown;
    model?:
      | {
          apiKey?: string;
          id?: string;
          modelId?: string;
          provider?: string;
          specificationVersion?: string;
        }
      | undefined;

    constructor(config: {
      instructions?: string;
      memory?: unknown;
      tools?: Record<string, unknown>;
      model?:
        | {
            apiKey?: string;
            id?: string;
            modelId?: string;
            provider?: string;
            specificationVersion?: string;
          }
        | undefined;
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
      return createMockMastraOutput();
    }

    async approveToolCall(options: unknown) {
      this.approveToolCallCalls.push(options);
      return createMockMastraOutput();
    }

    async declineToolCall(options: unknown) {
      this.declineToolCallCalls.push(options);
      return createMockMastraOutput();
    }

    async resumeStream(resumeData: unknown, options: unknown) {
      this.resumeStreamCalls.push({ options, resumeData });
      return createMockMastraOutput();
    }

    __setTools(tools: Record<string, unknown>) {
      this.tools = tools;
    }

    __registerMastra(mastra: unknown) {
      this.registeredMastra = mastra;
    }
  },
}));

function createMockMastraOutput() {
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

vi.mock('@mastra/core/mastra', () => ({
  Mastra: class {
    config: unknown;
    shutdownCalls = 0;

    constructor(config: {
      agents?: Record<string, { __registerMastra?: (mastra: unknown) => void }>;
    }) {
      this.config = config;
      mastraInstances.push(this);
      for (const agent of Object.values(config.agents ?? {})) {
        agent.__registerMastra?.(this);
      }
    }

    async shutdown() {
      this.shutdownCalls += 1;
    }
  },
}));

vi.mock('../mcp/explicit-stdio-client', () => ({
  ExplicitStdioMcpClient: class {
    options: unknown;

    constructor(options: { name: string }) {
      this.options = options;
      mcpInstances.push(this);
    }

    async callTool() {
      return { content: [{ text: 'mock MCP output', type: 'text' }] };
    }

    async close() {}

    async listTools() {
      return {
        tools: Object.entries(mcpToolsets[this.options.name] ?? {}).map(([name, tool]) => ({
          description: tool.description,
          inputSchema: { additionalProperties: true, type: 'object' },
          name,
        })),
      };
    }
  },
}));

/**
 * Every initial-turn stream leads with the transient run-start context
 * breakdown (context-ring WS8). Assert it explicitly, then hand back the
 * remaining chunks so each test keeps its original whole-array expectation.
 */
function expectLeadingContextBreakdown(chunks: unknown[]): unknown[] {
  expect(chunks[0]).toMatchObject({
    breakdown: { provenance: 'heuristic' },
    type: 'context-breakdown',
  });
  return chunks.slice(1);
}

describe('mastra streaming integration', () => {
  beforeEach(() => {
    agentInstances.length = 0;
    mastraInstances.length = 0;
    mcpInstances.length = 0;
    mcpToolsets = {
      filesystem: {
        'remote tool': { description: 'remote', id: 'remote tool' },
      },
    };
    setMockStreamParts([]);
  });

  it('yields streaming chunks by awaiting the Mastra fullStream promise', async () => {
    setMockStreamParts([
      { textDelta: 'hello', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 11, promptTokens: 7 } },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-1',
          parts: [{ text: 'hi there', type: 'text' }],
          role: 'user',
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      { type: 'text-delta', value: 'hello' },
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.finished', status: 'completed' }),
        type: 'run-event',
      }),
      {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 11, promptTokens: 7 },
      },
    ]);
  });

  it('records bounded token diagnostics with actual provider prompt usage', async () => {
    setMockStreamParts([
      { textDelta: 'hello', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 11, promptTokens: 7 } },
    ]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-1', parts: [{ text: 'hi there', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            model: 'gpt-5.6-terra',
            provider: 'openai',
          },
        }
      );
      for await (const _chunk of iterator) {
        // Drain the stream so the final diagnostics log is emitted.
      }
    } finally {
      removeLogListener();
    }

    const diagnosticsRecord = logRecords.find((record) =>
      record.args.some(
        (arg) =>
          Boolean(arg && typeof arg === 'object') &&
          (arg as { code?: unknown }).code === 'mastra_agent_token_measurement'
      )
    );
    const diagnosticsFields = diagnosticsRecord?.args.find(
      (arg): arg is Record<string, unknown> =>
        Boolean(arg && typeof arg === 'object') &&
        (arg as { code?: unknown }).code === 'mastra_agent_token_measurement'
    );
    expect(diagnosticsRecord?.level).toBe(LogLevel.INFO);
    expect(diagnosticsRecord?.args[0]).toMatchObject({
      code: 'mastra_agent_token_measurement',
    });
    expect(diagnosticsRecord?.args[1]).toBe('mastra run token measurement recorded');
    expect(diagnosticsFields).toMatchObject({
      measurementMode: 'declared-compatible-reference',
      measurementStatus: 'measured',
      model: 'gpt-5.6-terra',
      modelVisibleProjectionCount: 0,
      provider: 'openai',
      providerReportedPromptTokens: 7,
      tokenizer: 'o200k_base',
      toolDefinitionCount: 0,
    });
  });

  it('carries Anthropic cache token usage through the message-finish chunk', async () => {
    setMockStreamParts([
      { textDelta: 'hello', type: 'text-delta' },
      {
        finishReason: 'stop',
        type: 'finish',
        usage: {
          cacheCreationInputTokens: 60,
          cachedInputTokens: 40,
          completionTokens: 11,
          promptTokens: 107,
        },
      },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-1',
          parts: [{ text: 'hi there', type: 'text' }],
          role: 'user',
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'anthropic' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: {
        cacheCreationInputTokens: 60,
        cacheReadInputTokens: 40,
        completionTokens: 11,
        promptTokens: 107,
      },
    });
  });

  it('drops cache token classes for non-Anthropic providers (their caching is auto-discounted upstream)', async () => {
    setMockStreamParts([
      { textDelta: 'hello', type: 'text-delta' },
      {
        finishReason: 'stop',
        type: 'finish',
        usage: {
          cacheCreationInputTokens: 60,
          cachedInputTokens: 40,
          completionTokens: 11,
          promptTokens: 107,
        },
      },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-1',
          parts: [{ text: 'hi there', type: 'text' }],
          role: 'user',
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 11, promptTokens: 107 },
    });
  });

  it('stops at the next step boundary when steering is requested and marks the run steered', async () => {
    setMockStreamParts([
      { type: 'start' },
      { type: 'step-start' },
      { textDelta: 'first step text', type: 'text-delta' },
      {
        payload: { metadata: {} },
        type: 'step-finish',
        usage: { completionTokens: 2, promptTokens: 10 },
      },
      { type: 'step-start' },
      { textDelta: 'second step text', type: 'text-delta' },
      {
        payload: { metadata: {} },
        type: 'step-finish',
        usage: { completionTokens: 5, promptTokens: 40 },
      },
      { type: 'step-start' },
      { textDelta: 'third step text — must never stream', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 9, promptTokens: 80 } },
    ]);

    // Steer requested AFTER the first boundary: run stops at the SECOND.
    let boundariesSeen = 0;
    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'work on it', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          steering: {
            stopRequested: () => {
              boundariesSeen += 1;
              return boundariesSeen > 1;
            },
          },
        },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const texts = chunks.filter((chunk) => chunk.type === 'text-delta');
    expect(texts.map((chunk) => (chunk as { value?: string }).value)).toEqual([
      'first step text',
      'second step text',
    ]);

    const runEventKinds = chunks
      .filter((chunk) => chunk.type === 'run-event')
      .map((chunk) => (chunk as { event?: { kind?: string } }).event?.kind);
    expect(runEventKinds).toContain('run.steered');
    // run.finished must ALSO be emitted so every terminal-event consumer
    // (timeline status, notifications, hydration) sees the run complete.
    expect(runEventKinds.indexOf('run.steered')).toBeLessThan(
      runEventKinds.indexOf('run.finished')
    );

    const finish = chunks.at(-1) as {
      finishReason?: string;
      type: string;
      usage?: { completionTokens: number; promptTokens: number };
    };
    expect(finish.type).toBe('message-finish');
    expect(finish.finishReason).toBe('stop');
    // Usage is ACCUMULATED across every completed step (10+40 / 2+5), never
    // just the boundary step's own numbers.
    expect(finish.usage).toEqual({ completionTokens: 7, promptTokens: 50 });
  });

  it('flushes pending output-only tool completions before the steered finish', async () => {
    // A tool that terminates via `tool-output` (no later `tool-result`) is
    // parked in outputOnlyToolEvents until a TERMINAL flush. The steered
    // terminal must drain it exactly like the natural finish does, or the
    // run completes while that tool card stays stuck "running" forever.
    setMockStreamParts([
      { type: 'step-start' },
      {
        args: { query: 'local state' },
        toolCallId: 'c-output-only',
        toolName: 'background.lookup',
        type: 'tool-call',
      },
      {
        output: { answer: 'done' },
        toolCallId: 'c-output-only',
        type: 'tool-output',
      },
      {
        payload: { metadata: {} },
        type: 'step-finish',
        usage: { completionTokens: 2, promptTokens: 10 },
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 9, promptTokens: 40 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          steering: { stopRequested: () => true },
        },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const runEventKinds = chunks
      .filter((chunk) => chunk.type === 'run-event')
      .map((chunk) => (chunk as { event?: { kind?: string } }).event?.kind);
    expect(runEventKinds).toContain('tool.completed');
    // Ordering: the pending completion drains BEFORE the terminal markers.
    expect(runEventKinds.indexOf('tool.completed')).toBeLessThan(
      runEventKinds.indexOf('run.steered')
    );
  });

  it('ignores a steering request that never reaches a step boundary before natural finish', async () => {
    setMockStreamParts([
      { textDelta: 'hello', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          provider: 'openai',
          steering: { stopRequested: () => true },
        },
      }
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const steered = chunks.find(
      (chunk) =>
        chunk.type === 'run-event' &&
        (chunk as { event?: { kind?: string } }).event?.kind === 'run.steered'
    );
    expect(steered).toBeUndefined();
    expect((chunks.at(-1) as { type: string }).type).toBe('message-finish');
  });

  it('aggregates provider-reported OpenRouter cost across model steps', async () => {
    setMockStreamParts([
      {
        payload: {
          metadata: {
            providerMetadata: { openrouter: { usage: { cost: 0.001_25 } } },
          },
        },
        type: 'step-finish',
        usage: { completionTokens: 2, promptTokens: 10 },
      },
      {
        payload: {
          metadata: {
            providerMetadata: { openrouter: { usage: { cost: 0.003_75 } } },
          },
        },
        type: 'step-finish',
        usage: { completionTokens: 5, promptTokens: 20 },
      },
      {
        finishReason: 'stop',
        // Mastra repeats the final step's metadata on finish; it must not be
        // double-counted when step-finish parts were observed.
        payload: {
          metadata: {
            providerMetadata: { openrouter: { usage: { cost: 0.003_75 } } },
          },
        },
        type: 'finish',
        usage: { completionTokens: 7, promptTokens: 30 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-cost', parts: [{ text: 'use two model steps', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      billedCostUsd: 0.005,
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 7, promptTokens: 30 },
    });
  });

  it('rejects a cost-less OpenRouter step when finish repeats only the final step cost', async () => {
    setMockStreamParts([
      {
        payload: { metadata: {} },
        type: 'step-finish',
        usage: { completionTokens: 2, promptTokens: 10 },
      },
      {
        payload: {
          metadata: {
            providerMetadata: { openrouter: { usage: { cost: 0.003_75 } } },
          },
        },
        type: 'step-finish',
        usage: { completionTokens: 5, promptTokens: 20 },
      },
      {
        finishReason: 'stop',
        payload: {
          metadata: {
            providerMetadata: { openrouter: { usage: { cost: 0.003_75 } } },
          },
        },
        type: 'finish',
        usage: { completionTokens: 7, promptTokens: 30 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-partial-cost',
          parts: [{ text: 'use two model steps', type: 'text' }],
          role: 'user',
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const drain = async () => {
      for await (const _chunk of iterator) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/OpenRouter model step omitted.*billed cost/i);
  });

  it('rejects malformed provider-reported OpenRouter cost', async () => {
    setMockStreamParts([
      {
        finishReason: 'stop',
        providerMetadata: { openrouter: { usage: { cost: -1 } } },
        type: 'finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-bad-cost', parts: [{ text: 'bad cost', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const drain = async () => {
      for await (const _chunk of iterator) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/OpenRouter.*cost/i);
  });

  it('rejects an OpenRouter completion that omits billed cost', async () => {
    setMockStreamParts([
      {
        finishReason: 'stop',
        type: 'finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-missing-cost', parts: [{ text: 'missing cost', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const drain = async () => {
      for await (const _chunk of iterator) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/OpenRouter.*billed cost/i);
  });

  it('normalizes OpenRouter provider state before applying stream safeguards', async () => {
    setMockStreamParts([
      {
        finishReason: 'stop',
        type: 'finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-normalized-provider', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: ' OpenRouter ' } }
    );

    expect(agentInstances[0]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 4096 },
    });

    const drain = async () => {
      for await (const _chunk of iterator) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/OpenRouter.*billed cost/i);
  });

  it('propagates tool-call events as tool-event chunks', async () => {
    setMockStreamParts([
      { args: { query: 'x' }, toolCallId: 'c1', toolName: 'web.searchDocs', type: 'tool-call' },
      { argsTextDelta: 'que', toolCallId: 'c1', type: 'tool-call-delta' },
      { result: { totalResults: 1 }, toolCallId: 'c1', type: 'tool-result' },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'search', type: 'text' }], role: 'user' }],
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
      name: 'web.searchDocs',
      status: 'start',
      type: 'tool-event',
    });
    expect(toolEvents[1]).toMatchObject({ status: 'progress', type: 'tool-event' });
    expect(toolEvents[2]).toMatchObject({ status: 'success', type: 'tool-event' });
    expect(finished).toBe(true);
  });

  it('emits durable run-events for Mastra tool lifecycle parts without raw payloads', async () => {
    setMockStreamParts([
      {
        args: { query: 'secret search' },
        dynamic: false,
        providerExecuted: true,
        toolCallId: 'c1',
        toolName: 'web.searchDocs',
        type: 'tool-call',
      },
      {
        dynamic: false,
        providerExecuted: true,
        result: { confidential: 'tool output' },
        toolCallId: 'c1',
        type: 'tool-result',
      },
      {
        args: { url: 'https://example.test/private' },
        dynamic: true,
        providerExecuted: false,
        toolCallId: 'c3',
        toolName: 'browser.capture',
        type: 'tool-call',
      },
      {
        dynamic: true,
        output: { snapshot: 'raw page text' },
        providerExecuted: false,
        toolCallId: 'c3',
        type: 'tool-output',
      },
      {
        dynamic: true,
        providerExecuted: false,
        result: { pageTitle: 'safe title' },
        toolCallId: 'c3',
        type: 'tool-result',
      },
      {
        args: { token: 'hidden' },
        toolCallId: 'c2',
        toolName: 'broken.tool',
        type: 'tool-call',
      },
      {
        error: { message: 'boom', token: 'hidden' },
        toolCallId: 'c2',
        type: 'tool-error',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'search', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const runEvents = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event' && chunk.event.kind.startsWith('tool.')) {
        runEvents.push(chunk.event);
      }
    }

    expect(runEvents).toMatchObject([
      {
        kind: 'tool.started',
        label: 'Tool started',
        metadata: {
          dynamic: false,
          providerExecuted: true,
          toolCallId: 'c1',
          toolName: 'web.searchDocs',
        },
        status: 'running',
      },
      {
        kind: 'tool.completed',
        label: 'Tool completed',
        metadata: {
          dynamic: false,
          providerExecuted: true,
          toolCallId: 'c1',
          toolName: 'web.searchDocs',
        },
        status: 'completed',
      },
      {
        kind: 'tool.started',
        label: 'Tool started',
        metadata: {
          dynamic: true,
          providerExecuted: false,
          toolCallId: 'c3',
          toolName: 'browser.capture',
        },
        status: 'running',
      },
      {
        kind: 'tool.completed',
        label: 'Tool completed',
        metadata: {
          dynamic: true,
          providerExecuted: false,
          toolCallId: 'c3',
          toolName: 'browser.capture',
        },
        status: 'completed',
      },
      {
        kind: 'tool.started',
        label: 'Tool started',
        metadata: {
          toolCallId: 'c2',
          toolName: 'broken.tool',
        },
        status: 'running',
      },
      {
        kind: 'tool.failed',
        label: 'Tool failed',
        metadata: {
          toolCallId: 'c2',
          toolName: 'broken.tool',
        },
        status: 'failed',
      },
    ]);
    for (const event of runEvents) {
      expect(event.metadata).not.toHaveProperty('args');
      expect(event.metadata).not.toHaveProperty('error');
      expect(event.metadata).not.toHaveProperty('output');
      expect(event.metadata).not.toHaveProperty('result');
    }
  });

  it('emits a durable completion when Mastra tool-output has no later tool-result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T08:00:00.000Z'));
    setMockStreamParts([
      {
        args: { query: 'local state' },
        toolCallId: 'c-output-only',
        toolName: 'background.lookup',
        type: 'tool-call',
      },
      {
        output: { answer: 'done' },
        toolCallId: 'c-output-only',
        type: 'tool-output',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      const stream = iterator[Symbol.asyncIterator]();
      // Consume the run-start context breakdown so the timed steps below still
      // line up with the tool chunks they assert against.
      expect((await stream.next()).value).toMatchObject({ type: 'context-breakdown' });
      chunks.push((await stream.next()).value);
      chunks.push((await stream.next()).value);
      vi.setSystemTime(new Date('2026-05-30T08:00:05.000Z'));
      chunks.push((await stream.next()).value);
      vi.setSystemTime(new Date('2026-05-30T08:00:30.000Z'));
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      const runEvents: unknown[] = [];
      for (const chunk of chunks) {
        if (
          typeof chunk !== 'object' ||
          chunk === null ||
          !('type' in chunk) ||
          chunk.type !== 'run-event' ||
          !('event' in chunk) ||
          typeof chunk.event !== 'object' ||
          chunk.event === null ||
          !('kind' in chunk.event) ||
          typeof chunk.event.kind !== 'string' ||
          !chunk.event.kind.startsWith('tool.')
        ) {
          continue;
        }
        runEvents.push(chunk.event);
      }

      expect(runEvents).toMatchObject([
        {
          kind: 'tool.started',
          metadata: {
            toolCallId: 'c-output-only',
            toolName: 'background.lookup',
          },
          status: 'running',
        },
        {
          kind: 'tool.completed',
          metadata: {
            toolCallId: 'c-output-only',
            toolName: 'background.lookup',
          },
          status: 'completed',
          timestamp: '2026-05-30T08:00:05.000Z',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses tool-result metadata for completion after an intermediate tool-output', async () => {
    setMockStreamParts([
      {
        args: { url: 'https://example.test' },
        toolCallId: 'c-result',
        toolName: 'browser.capture',
        type: 'tool-call',
      },
      {
        dynamic: true,
        output: { snapshot: 'raw page text' },
        providerExecuted: false,
        toolCallId: 'c-result',
        type: 'tool-output',
      },
      {
        dynamic: false,
        providerExecuted: true,
        result: { pageTitle: 'safe title' },
        toolCallId: 'c-result',
        type: 'tool-result',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'capture', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.completed' || chunk.event.kind === 'tool.failed')
      ) {
        terminalEvents.push(chunk.event);
      }
    }

    expect(terminalEvents).toMatchObject([
      {
        kind: 'tool.completed',
        metadata: {
          dynamic: false,
          providerExecuted: true,
          toolCallId: 'c-result',
          toolName: 'browser.capture',
        },
        status: 'completed',
      },
    ]);
  });

  it('treats Mastra error tool-results as failed durable run-events', async () => {
    setMockStreamParts([
      {
        args: { url: 'https://example.test' },
        toolCallId: 'c-error-result',
        toolName: 'browser.capture',
        type: 'tool-call',
      },
      {
        isError: true,
        providerExecuted: true,
        result: { message: 'capture failed' },
        toolCallId: 'c-error-result',
        type: 'tool-result',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'capture', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.completed' || chunk.event.kind === 'tool.failed')
      ) {
        terminalEvents.push(chunk.event);
      }
    }

    expect(terminalEvents).toMatchObject([
      {
        kind: 'tool.failed',
        metadata: {
          providerExecuted: true,
          toolCallId: 'c-error-result',
          toolName: 'browser.capture',
        },
        status: 'failed',
      },
    ]);
  });

  it('lets a terminal tool-error override an earlier intermediate tool-output', async () => {
    setMockStreamParts([
      {
        args: { query: 'state' },
        toolCallId: 'c-terminal',
        toolName: 'flaky.lookup',
        type: 'tool-call',
      },
      {
        output: { answer: 'done' },
        toolCallId: 'c-terminal',
        type: 'tool-output',
      },
      {
        error: { message: 'late error' },
        toolCallId: 'c-terminal',
        type: 'tool-error',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.completed' || chunk.event.kind === 'tool.failed')
      ) {
        terminalEvents.push(chunk.event);
      }
    }

    expect(terminalEvents).toMatchObject([
      {
        kind: 'tool.failed',
        metadata: {
          toolCallId: 'c-terminal',
          toolName: 'flaky.lookup',
        },
        status: 'failed',
      },
    ]);
  });

  it('keeps the first durable terminal run-event when error precedes success for one tool id', async () => {
    setMockStreamParts([
      {
        args: { query: 'state' },
        toolCallId: 'c-terminal',
        toolName: 'flaky.lookup',
        type: 'tool-call',
      },
      {
        error: { message: 'early error' },
        toolCallId: 'c-terminal',
        type: 'tool-error',
      },
      {
        result: { answer: 'late success' },
        toolCallId: 'c-terminal',
        type: 'tool-result',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.completed' || chunk.event.kind === 'tool.failed')
      ) {
        terminalEvents.push(chunk.event);
      }
    }

    expect(terminalEvents).toMatchObject([
      {
        kind: 'tool.failed',
        metadata: {
          toolCallId: 'c-terminal',
          toolName: 'flaky.lookup',
        },
        status: 'failed',
      },
    ]);
  });

  it('does not emit durable terminal run-events for id-less Mastra tool-result parts', async () => {
    setMockStreamParts([
      {
        result: { answer: 'done' },
        toolName: 'anonymous.lookup',
        type: 'tool-result',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.completed' || chunk.event.kind === 'tool.failed')
      ) {
        terminalEvents.push(chunk.event);
      }
    }

    expect(terminalEvents).toEqual([]);
  });

  it('does not emit durable tool run-events for id-less Mastra tool-call parts', async () => {
    setMockStreamParts([
      {
        args: { query: 'state' },
        toolName: 'anonymous.lookup',
        type: 'tool-call',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const toolRunEvents = [];
    const toolEvents = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'tool-event') {
        toolEvents.push(chunk);
      }
      if (chunk.type === 'run-event' && chunk.event.kind.startsWith('tool.')) {
        toolRunEvents.push(chunk.event);
      }
    }

    expect(toolEvents).toMatchObject([
      {
        name: 'anonymous.lookup',
        status: 'start',
        type: 'tool-event',
      },
    ]);
    expect(toolRunEvents).toEqual([]);
  });

  it('keeps Mastra tool progress parts out of durable run-events', async () => {
    setMockStreamParts([
      { args: { query: 'x' }, toolCallId: 'c1', toolName: 'web.searchDocs', type: 'tool-call' },
      { toolCallId: 'c1', type: 'tool-call-input-streaming-start' },
      { argsTextDelta: 'que', toolCallId: 'c1', type: 'tool-call-delta' },
      { toolCallId: 'c1', type: 'tool-call-input-streaming-end' },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'search', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    let progressEvents = 0;
    let toolRunEvents = 0;
    for await (const chunk of iterator) {
      if (chunk.type === 'tool-event' && chunk.status === 'progress') {
        progressEvents += 1;
      }
      if (chunk.type === 'run-event' && chunk.event.kind.startsWith('tool.')) {
        toolRunEvents += 1;
      }
    }

    expect(progressEvents).toBe(3);
    expect(toolRunEvents).toBe(1);
  });

  it('surfaces Mastra reasoning and run lifecycle chunks', async () => {
    setMockStreamParts([
      { messageId: 'msg-1', type: 'start' },
      { delta: 'Checking memory.', type: 'reasoning-delta' },
      { messageId: 'msg-1', type: 'step-start' },
      { type: 'step-finish', usage: { completionTokens: 4, promptTokens: 3 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 6, promptTokens: 5 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'explain', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.started', status: 'running' }),
        type: 'run-event',
      }),
      { type: 'reasoning-delta', value: 'Checking memory.' },
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.step.started', status: 'running' }),
        type: 'run-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.step.finished', status: 'completed' }),
        type: 'run-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'run.finished', status: 'completed' }),
        type: 'run-event',
      }),
      {
        finishReason: 'stop',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 6, promptTokens: 5 },
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
      streamMastraAgent([{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }], {
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

  it('registers the Agent with a Mastra instance when workflow storage is configured', async () => {
    const memory = { id: 'memory-instance' };
    const storage = { id: 'storage-with-workflows' };

    await createMastraAgentRuntime({
      memory: memory as never,
      runtime: { apiKey: 'key', provider: 'openai' },
      storage: storage as never,
    });

    expect(mastraInstances).toHaveLength(1);
    expect(mastraInstances[0]?.config).toMatchObject({
      agents: { brainstrikeAssistant: agentInstances.at(-1) },
      storage,
    });
    expect(agentInstances.at(-1)?.registeredMastra).toBe(mastraInstances[0]);
  });

  it('surfaces Mastra persisted-message ID context drift before losing the assistant-ui ID', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: {
        apiKey: 'key',
        assistantMessageId: 'assistant-client-id',
        provider: 'openai',
      },
      storage: { id: 'storage-with-workflows' } as never,
    });

    const config = mastraInstances[0]?.config as {
      idGenerator?: (context?: { idType: 'message'; source: 'agent' | 'memory' }) => string;
    };
    expect(config.idGenerator?.({ idType: 'message', source: 'agent' })).not.toBe(
      'assistant-client-id'
    );
    expect(() => runtime.assertAssistantMessageIdPersisted?.()).toThrow(
      'Mastra completed without persisting assistant message ID "assistant-client-id" through its memory ID context.'
    );
    expect(config.idGenerator?.({ idType: 'message', source: 'memory' })).toBe(
      'assistant-client-id'
    );
    expect(() => runtime.assertAssistantMessageIdPersisted?.()).not.toThrow();
  });

  it('shuts down the Mastra instance when disposing a storage-backed runtime', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      storage: { id: 'storage-with-workflows' } as never,
    });

    await runtime.dispose();

    expect(mastraInstances).toHaveLength(1);
    expect(mastraInstances[0]?.shutdownCalls).toBe(1);
  });

  it('passes strict thread/resource memory context to agent.stream', async () => {
    const memory = { id: 'memory-instance' };
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'remember this', type: 'text' }], role: 'user' }],
      {
        memory: memory as never,
        runtime: {
          apiKey: 'test-key',
          memory: {
            memoryOptions: { lastMessages: 5 },
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
      }
    );

    for await (const _chunk of iterator) {
      // drain stream
    }

    expect(agentInstances.at(-1)?.streamCalls.at(-1)?.options).toMatchObject({
      memory: {
        options: { lastMessages: 5 },
        resource: 'workspace-a',
        thread: 'thread-1',
      },
    });
  });

  it('uses the assistant-ui message id for the first persisted assistant message', async () => {
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'remember this', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          assistantMessageId: 'assistant-client-id',
          provider: 'openai',
        } as never,
      }
    );

    for await (const _chunk of iterator) {
      // drain stream
    }

    const options = agentInstances.at(-1)?.streamCalls.at(-1)?.options as {
      experimental_generateMessageId?: () => string;
    };
    expect(options.experimental_generateMessageId).toBeTypeOf('function');
    expect(options.experimental_generateMessageId?.()).toBe('assistant-client-id');
    expect(options.experimental_generateMessageId?.()).not.toBe('assistant-client-id');
  });

  it('uses Brainstrike default stream step cap for native tool loops', async () => {
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'inspect the workspace', type: 'text' }], role: 'user' }],
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
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'inspect the workspace', type: 'text' }], role: 'user' }],
      {
        runtime: {
          agentLoop: {
            inputTokenLimit: 8192,
            maxSteps: 12,
          },
          apiKey: 'test-key',
          provider: 'openai',
          workspaceSkills: {} as never,
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
    // This fixture has no deferred tools, so discovery is omitted rather than
    // injecting an unusable search_tools surface. Token limiting stays LAST.
    expect(options.inputProcessors?.map((processor) => processor.id)).toEqual([
      'skills-processor',
      'provider-history-compat',
      'token-limiter',
    ]);
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
      streamMastraAgent([{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }], {
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
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
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
    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('resolves ask-tool risk metadata when the approval part carries the ORIGINAL dotted name (dual-form lookup)', async () => {
    // askTools is keyed by the SANITIZED registered id; a Mastra upgrade (or any
    // path that surfaces the pause under the ORIGINAL dotted name) must not
    // silently drop the risk metadata — the lookup bridges both name forms.
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-dotted-1',
          // ORIGINAL dotted name, NOT the registered sanitized id.
          toolName: 'brainstrike.runShell',
        },
        runId: 'run-approval-dotted-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-dotted', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          permissionPolicy: {
            policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
            riskByTool: { 'brainstrike.runShell': 'execute' },
            yolo: false,
          },
          provider: 'openai',
        },
        storage: { id: 'workflow-storage' } as never,
        tools: {
          'brainstrike.runShell': { description: 'run shell', id: 'brainstrike.runShell' },
        },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        policyDecision: 'ask',
        riskCategory: 'execute',
        runId: 'run-approval-dotted-1',
        toolCallId: 'approval-dotted-1',
        toolName: 'brainstrike.runShell',
        type: 'tool-approval-required',
      })
    );
  });

  it('logs a LOUD error and omits risk metadata when a policy-driven pause cannot be resolved (never fabricates)', async () => {
    // A policy-driven run (non-empty askTools) that pauses on a tool the
    // metadata lookup cannot resolve under EITHER name form must surface the
    // pause honestly — no riskCategory, no policyDecision — and log an error so
    // the metadata drop is observable (no silent fallback).
    setMockStreamParts([
      {
        payload: {
          args: { command: 'echo hi' },
          toolCallId: 'approval-unresolved-1',
          toolName: 'totally.unknownTool',
        },
        runId: 'run-approval-unresolved-1',
        type: 'tool-call-approval',
      },
    ]);

    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    const chunks: unknown[] = [];
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u-unresolved', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            permissionPolicy: {
              policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
              riskByTool: { 'brainstrike.runShell': 'execute' },
              yolo: false,
            },
            provider: 'openai',
          },
          storage: { id: 'workflow-storage' } as never,
          tools: {
            'brainstrike.runShell': { description: 'run shell', id: 'brainstrike.runShell' },
          },
        }
      );
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    } finally {
      removeLogListener();
    }

    const approvalChunk = chunks.find(
      (chunk): chunk is Record<string, unknown> =>
        Boolean(chunk && typeof chunk === 'object') &&
        (chunk as { type?: unknown }).type === 'tool-approval-required'
    );
    // The pause still surfaces (the user can approve/decline)…
    expect(approvalChunk).toMatchObject({
      toolCallId: 'approval-unresolved-1',
      toolName: 'totally.unknownTool',
    });
    // …but the metadata is honestly omitted, never fabricated.
    expect(approvalChunk).not.toHaveProperty('riskCategory');
    expect(approvalChunk).not.toHaveProperty('policyDecision');
    // And the drop is LOUD.
    const unresolvedLog = logRecords.find(
      (record) =>
        record.level === LogLevel.ERROR &&
        record.args.some(
          (arg) =>
            Boolean(arg && typeof arg === 'object') &&
            (arg as { code?: unknown }).code === 'mastra_agent_approval_metadata_unresolved'
        )
    );
    expect(unresolvedLog).toBeDefined();
  });

  it('keeps an OpenRouter tool approval resumable before Mastra emits step-finish', async () => {
    setMockStreamParts([
      {
        payload: {
          args: { path: 'src/index.ts' },
          toolCallId: 'approval-cost-1',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
        runId: 'run-approval-cost-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-cost-approval', parts: [{ text: 'edit the file', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openrouter' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'tool-calls',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 0, promptTokens: 0 },
    });
  });

  it('flushes output-only tool completions before an approval pause', async () => {
    setMockStreamParts([
      {
        args: { query: 'local state' },
        toolCallId: 'c-output-only-before-approval',
        toolName: 'background.lookup',
        type: 'tool-call',
      },
      {
        output: { answer: 'done' },
        toolCallId: 'c-output-only-before-approval',
        type: 'tool-output',
      },
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'lookup then approve', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'background.lookup',
        status: 'start',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.started',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        name: 'background.lookup',
        status: 'success',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.completed',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
          status: 'completed',
        }),
        type: 'run-event',
      }),
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        resumeSchema: '{}',
        runId: 'run-approval-1',
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-approval-required',
      },
      {
        finishReason: 'tool-calls',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('resumes an approved Mastra tool call through the official approval API', async () => {
    const memory = { id: 'memory-instance' };
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Approved and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 3, promptTokens: 2 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
      },
      {
        memory: memory as never,
        requireToolApproval: true,
        runtime: {
          agentLoop: { inputTokenLimit: 8192 },
          apiKey: 'test-key',
          assistantMessageId: 'assistant-resume-id',
          memory: {
            memoryOptions: { lastMessages: 5 },
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const agent = agentInstances.at(-1);
    const approvalOptions = agent?.approveToolCallCalls[0] as {
      experimental_generateMessageId?: () => string;
      inputProcessors?: Array<{ id?: string }>;
    };
    const mastraConfig = mastraInstances.at(-1)?.config as {
      idGenerator?: () => string;
    };
    expect(approvalOptions.experimental_generateMessageId).toBeTypeOf('function');
    expect(approvalOptions.experimental_generateMessageId?.()).toBe('assistant-resume-id');
    expect(approvalOptions.inputProcessors?.map((processor) => processor.id)).toEqual([
      'provider-history-compat',
      'token-limiter',
    ]);
    expect(mastraConfig.idGenerator?.()).toBe('assistant-resume-id');

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(agent?.approveToolCallCalls).toHaveLength(1);
    expect(agent?.declineToolCallCalls).toHaveLength(0);
    expect(agent?.approveToolCallCalls[0]).toMatchObject({
      maxSteps: 20,
      memory: {
        options: { lastMessages: 5 },
        resource: 'workspace-a',
        thread: 'thread-1',
      },
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
    });
    // This fixture has no permission-policy ask set, so the approval was
    // explicitly global. The resumed leg must keep gating every non-internal
    // follow-up tool while exempting Mastra's memory bookkeeping.
    const approveGate = (
      agent?.approveToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof approveGate).toBe('function');
    expect(approveGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(approveGate({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(true);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Approved and continued.' });
    expect(chunks).toContainEqual({
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 3, promptTokens: 2 },
    });
  });

  it('keeps a suspended-tool resume stream ID independent from its persisted ID', async () => {
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Resumed and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolResumeAction(
      {
        resumeData: { answer: 'Paris' },
        runId: 'run-suspended-1',
        toolCallId: 'tool-call-suspended-1',
      },
      {
        runtime: {
          agentLoop: { inputTokenLimit: 8192 },
          apiKey: 'test-key',
          assistantMessageId: 'assistant-suspend-resume-id',
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const agent = agentInstances.at(-1);
    const resumeOptions = agent?.resumeStreamCalls[0]?.options as {
      experimental_generateMessageId?: () => string;
      inputProcessors?: Array<{ id?: string }>;
    };
    const mastraConfig = mastraInstances.at(-1)?.config as {
      idGenerator?: () => string;
    };
    expect(resumeOptions.experimental_generateMessageId).toBeTypeOf('function');
    expect(resumeOptions.experimental_generateMessageId?.()).toBe('assistant-suspend-resume-id');
    expect(resumeOptions.inputProcessors?.map((processor) => processor.id)).toEqual([
      'provider-history-compat',
      'token-limiter',
    ]);
    expect(mastraConfig.idGenerator?.()).toBe('assistant-suspend-resume-id');

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(agent?.resumeStreamCalls[0]).toMatchObject({
      options: {
        maxSteps: 20,
        runId: 'run-suspended-1',
        toolCallId: 'tool-call-suspended-1',
      },
      resumeData: { answer: 'Paris' },
    });
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Resumed and continued.' });
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'stop', type: 'message-finish' })
    );
  });

  it('resumes a declined Mastra tool call through the official decline API', async () => {
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Declined and continued.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'decline',
        runId: 'run-approval-2',
        toolCallId: 'tool-call-2',
      },
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
        storage: storage as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const agent = agentInstances.at(-1);
    expect(agent?.approveToolCallCalls).toHaveLength(0);
    expect(agent?.declineToolCallCalls).toHaveLength(1);
    expect(agent?.declineToolCallCalls[0]).toMatchObject({
      maxSteps: 20,
      runId: 'run-approval-2',
      toolCallId: 'tool-call-2',
    });
    // The decline resume leg preserves the same explicit global gate.
    const declineGate = (
      agent?.declineToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof declineGate).toBe('function');
    expect(declineGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(declineGate({ toolName: 'shell_tool' })).toBe(true);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Declined and continued.' });
  });

  it('does NOT global-gate the approve resume when a policy allowed everything (empty ask set)', async () => {
    // "Allow all tools this session" grants every category, so the resume's
    // policy snapshot resolves NOTHING to 'ask' (empty askTools). That empty set
    // must read as an ALL-ALLOWED posture (a policy WAS enforced) — NOT a global
    // approval — so the resume gate gates nothing and a later mutation tool is
    // not re-prompted. Contrast the "explicit global" test above (no policy).
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { textDelta: 'Approved with all granted.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'approve',
        runId: 'run-approval-grant-all',
        toolCallId: 'tool-call-grant-all',
        toolName: 'workspace.writeFile',
      },
      {
        requireToolApproval: true,
        runtime: {
          apiKey: 'test-key',
          // enforce:true posture with every category granted → all-allowed.
          permissionPolicy: {
            policies: { edit: 'allow', execute: 'allow', mcp: 'allow', read: 'allow' },
            riskByTool: {},
            yolo: false,
          },
          provider: 'openai',
        },
        storage: storage as never,
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const agent = agentInstances.at(-1);
    const approveGate = (
      agent?.approveToolCallCalls[0] as { requireToolApproval?: unknown } | undefined
    )?.requireToolApproval as (ctx: { toolName: string }) => boolean;
    expect(typeof approveGate).toBe('function');
    // All-allowed posture: NOTHING is gated on the resumed leg — not the mutation
    // tool, not the internal memory tool.
    expect(approveGate({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(false);
    expect(approveGate({ toolName: 'updateWorkingMemory' })).toBe(false);
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Approved with all granted.' });
  });

  it('validates tool approval actions before initializing Mastra runtime resources', async () => {
    await expectMastraAgentError(
      streamMastraToolApprovalAction(
        {
          action: 'approve',
          runId: ' ',
          toolCallId: 'tool-call-1',
          toolName: 'workspace.writeFile',
        },
        {
          mcpConfig: {
            servers: [
              {
                command: 'echo',
                name: 'filesystem',
                transport: 'stdio',
              },
            ],
          },
          runtime: { apiKey: 'test-key', provider: 'openai' },
          storage: { id: 'workflow-storage' } as never,
        }
      ),
      'mastra_agent_runtime_init_failed'
    );

    expect(agentInstances).toHaveLength(0);
    expect(mastraInstances).toHaveLength(0);
    expect(mcpInstances).toHaveLength(0);
  });

  it('uses the cached tool name when approval pauses omit the tool name', async () => {
    setMockStreamParts([
      {
        args: { mode: 'replace', paths: ['src/index.ts'] },
        toolCallId: 'approval-1',
        toolName: 'brainstrike.updateWorkspaceContextSelection',
        type: 'tool-call',
      },
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          toolCallId: 'approval-1',
        },
        runId: 'run-approval-1',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
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
        finishReason: 'tool-calls',
        type: 'message-finish',
      })
    );
  });

  it('surfaces a well-formed suspended tool call as a resumable tool-suspend-required pause', async () => {
    setMockStreamParts([
      {
        payload: {
          resumeSchema: '{}',
          suspendPayload: { question: 'Which city?' },
          toolCallId: 'suspended-1',
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    // The pause is now a SUPPORTED resumable event (NOT a run.failed / error finish).
    expect(chunks).toContainEqual({
      resumeSchema: '{}',
      runId: 'run-suspended-1',
      suspendPayload: { question: 'Which city?' },
      toolCallId: 'suspended-1',
      toolName: 'brainstrike.askUser',
      type: 'tool-suspend-required',
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'tool-calls', type: 'message-finish' })
    );
    // No run.failed / error finish for a well-formed pause.
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  it('keeps an OpenRouter suspending tool resumable before Mastra emits step-finish', async () => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload: { question: 'Which city?' },
          toolCallId: 'suspended-cost-1',
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-cost-1',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u-cost-suspend', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'tool-calls',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 0, promptTokens: 0 },
    });
  });

  it('keeps a malformed suspend pause (missing tool call id) a visible terminal error', async () => {
    setMockStreamParts([
      {
        payload: {
          suspendPayload: { question: 'Which city?' },
          toolName: 'brainstrike.askUser',
        },
        runId: 'run-suspended-malformed',
        type: 'tool-call-suspended',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'ask me something', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          actionRequired: true,
          missingToolCallId: true,
          suspended: true,
        }),
        status: 'error',
        type: 'tool-event',
      })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ finishReason: 'error', type: 'message-finish' })
    );
  });

  it('keeps malformed approval pauses visible when Mastra omits the tool call id', async () => {
    setMockStreamParts([
      {
        payload: {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          toolName: 'brainstrike.updateWorkspaceContextSelection',
        },
        runId: 'run-approval-without-tool-call-id',
        type: 'tool-call-approval',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'update selected context', type: 'text' }], role: 'user' }],
      {
        requireToolApproval: true,
        runtime: { apiKey: 'test-key', provider: 'openai' },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'brainstrike.updateWorkspaceContextSelection',
        payload: expect.objectContaining({
          callId: 'mastra-tool-call-approval-missing-tool-call-id',
          missingToolCallId: true,
          toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
        }),
        status: 'error',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.failed',
          metadata: expect.objectContaining({
            missingToolCallId: true,
            toolCallId: 'mastra-tool-call-approval-missing-tool-call-id',
          }),
        }),
        type: 'run-event',
      }),
      {
        finishReason: 'error',
        path: [],
        type: 'message-finish',
        usage: { completionTokens: 0, promptTokens: 0 },
      },
    ]);
  });

  it('preserves the Mastra finish reason in the assistant data stream', async () => {
    setMockStreamParts([
      {
        payload: {
          output: { usage: { completionTokens: 4, inputTokens: 20 } },
          stepResult: { reason: 'length' },
        },
        type: 'finish',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'write a long answer', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'length',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 4, promptTokens: 20 },
    });
  });

  it('marks finish chunks without an explicit reason as unknown', async () => {
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 5, promptTokens: 3 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'finish without reason', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      finishReason: 'unknown',
      path: [],
      type: 'message-finish',
      usage: { completionTokens: 5, promptTokens: 3 },
    });
  });

  it('throws a typed error when Mastra closes after tool activity without a terminal finish', async () => {
    setMockStreamParts([
      {
        args: { query: 'database config' },
        toolCallId: 'call-context',
        toolName: 'brainstrike.queryEmbeddingSpace',
        type: 'tool-call',
      },
      {
        result: { context: 'database config result' },
        toolCallId: 'call-context',
        toolName: 'brainstrike.queryEmbeddingSpace',
        type: 'tool-result',
      },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'find database config', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(expectLeadingContextBreakdown(chunks)).toEqual([
      expect.objectContaining({
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'start',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.started',
          status: 'running',
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        name: 'brainstrike.queryEmbeddingSpace',
        status: 'success',
        type: 'tool-event',
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'tool.completed',
          status: 'completed',
        }),
        type: 'run-event',
      }),
      expect.objectContaining({
        finishReason: 'other',
        type: 'message-finish',
      }),
    ]);
  });

  it('rejects AI SDK v1 model runtimes instead of falling back to legacy streaming', async () => {
    await expectMastraAgentError(
      streamMastraAgent(
        [{ id: 'u1', parts: [{ text: 'inspect the workspace', type: 'text' }], role: 'user' }],
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
      streamMastraAgent([{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }], {
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
      }),
      'mastra_agent_memory_unavailable'
    );
  });

  it('throws a typed error when memory context is missing thread or resource IDs', async () => {
    await expectMastraAgentError(
      streamMastraAgent([{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }], {
        memory: { id: 'memory-instance' } as never,
        runtime: {
          apiKey: 'test-key',
          memory: { resourceId: 'workspace-a', threadId: '' },
          provider: 'openai',
        },
      }),
      'mastra_agent_memory_unavailable'
    );
  });
  it('keeps custom local tools eager while deferring post-gate MCP tools', async () => {
    const runtime = await createMastraAgentRuntime({
      mcpConfig: {
        servers: [
          {
            command: 'echo',
            name: 'filesystem',
            transport: 'stdio',
          },
        ],
      },
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'local tool': {
          description: 'local',
          id: 'local tool',
        },
      },
    });

    expect(agentInstances).toHaveLength(1);
    const agentConfig = agentInstances[0]?.config.tools ?? {};

    expect(Object.keys(agentConfig)).toEqual(['local_tool']);

    expect(runtime.toolNameMap.get('local_tool')).toBe('local tool');
    expect(runtime.toolNameMap.get('filesystem_remote_tool')).toBe('filesystem.remote tool');
    expect(runtime.toolDiscovery).toEqual({
      adapter: 'mastra-catalog-search',
      coreToolIds: ['local tool'],
      deferredToolIds: ['filesystem.remote tool'],
      eligibleToolIds: ['filesystem.remote tool', 'local tool'],
    });
  });

  it('constructs hosted agents from critical plus custom tools and defers known noncritical tools', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.listWorkspaceContext': {
          description: 'List workspace context',
          id: 'brainstrike.listWorkspaceContext',
        },
        'brainstrike.readWorkspaceFile': {
          description: 'Read workspace file',
          id: 'brainstrike.readWorkspaceFile',
        },
        customInspector: {
          description: 'Inspect a custom domain',
          id: 'customInspector',
        },
      },
    });

    expect(Object.keys(agentInstances[0]?.config.tools ?? {})).toEqual([
      'brainstrike_readWorkspaceFile',
      'customInspector',
    ]);
    expect(runtime.toolDiscovery).toEqual({
      adapter: 'mastra-catalog-search',
      coreToolIds: ['brainstrike.readWorkspaceFile', 'customInspector'],
      deferredToolIds: ['brainstrike.listWorkspaceContext'],
      eligibleToolIds: [
        'brainstrike.listWorkspaceContext',
        'brainstrike.readWorkspaceFile',
        'customInspector',
      ],
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).not.toContain('brainstrike_listWorkspaceContext');
  });

  it('builds hosted instructions from the actual critical surface, not deferred definitions', async () => {
    mcpToolsets = {
      filesystem: {
        search_files: {
          description: 'Search files',
          id: 'search_files',
        },
      },
    };

    const runtime = await createMastraAgentRuntime({
      mcpConfig: {
        servers: [
          {
            command: 'echo',
            name: 'filesystem',
            transport: 'stdio',
          },
        ],
      },
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.listEmbeddingSpaces': {
          description: 'List embedding spaces',
          id: 'brainstrike.listEmbeddingSpaces',
        },
        'brainstrike.listWorkspaceContext': {
          description: 'List workspace context',
          id: 'brainstrike.listWorkspaceContext',
        },
        'brainstrike.queryEmbeddingSpace': {
          description: 'Query embedding space',
          id: 'brainstrike.queryEmbeddingSpace',
        },
        'brainstrike.readWorkspaceContext': {
          description: 'Read workspace context',
          id: 'brainstrike.readWorkspaceContext',
        },
        'brainstrike.readWorkspaceFile': {
          description: 'Read workspace file',
          id: 'brainstrike.readWorkspaceFile',
        },
        'brainstrike.updateWorkspaceContextSelection': {
          description: 'Update workspace context selection',
          id: 'brainstrike.updateWorkspaceContextSelection',
        },
        'brainstrike.updateWorkspaceTapestrySelections': {
          description: 'Update workspace Tapestry selections',
          id: 'brainstrike.updateWorkspaceTapestrySelections',
        },
      },
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).not.toContain('brainstrike_listWorkspaceContext');
    expect(instructions).not.toContain('brainstrike_listEmbeddingSpaces');
    expect(instructions).not.toContain('brainstrike_queryEmbeddingSpace');
    expect(instructions).not.toContain('brainstrike.listWorkspaceContext');
    expect(runtime.toolDiscovery?.deferredToolIds).toEqual(
      expect.arrayContaining([
        'brainstrike.listEmbeddingSpaces',
        'brainstrike.listWorkspaceContext',
        'brainstrike.queryEmbeddingSpace',
      ])
    );
  });

  it('does not advertise unregistered Brainstrike native tools in default instructions', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.readWorkspaceFile': {
          description: 'Read workspace file',
          id: 'brainstrike.readWorkspaceFile',
        },
      },
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).toContain('If an expected native tool is unavailable, name its ID');
    expect(instructions).not.toContain('Registered Brainstrike native context tools in this run');
    expect(instructions).not.toContain('Workspace-selection inspection is unavailable');
    expect(instructions).not.toContain('Semantic workspace search is unavailable');
    expect(instructions).not.toContain('brainstrike_listWorkspaceContext');
    expect(instructions).not.toContain('brainstrike_queryEmbeddingSpace');
  });

  it('builds plan-mode instructions from the FINAL (plan-filtered) tool map, not the raw tool map', async () => {
    // Plan mode omits edit/execute tools from the map the Agent receives, so the
    // default instructions MUST NOT advertise those filtered tools (name listing
    // OR usage block) — otherwise the model is told to use tools it cannot call.
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', planMode: true, provider: 'openai' },
      tools: {
        'brainstrike.executeCommand': {
          description: 'Execute command',
          id: 'brainstrike.executeCommand',
        },
        'brainstrike.readWorkspaceFile': {
          description: 'Read workspace file',
          id: 'brainstrike.readWorkspaceFile',
        },
        'brainstrike.stringReplaceWorkspaceFile': {
          description: 'String replace',
          id: 'brainstrike.stringReplaceWorkspaceFile',
        },
        'brainstrike.writeWorkspaceFile': {
          description: 'Write workspace file',
          id: 'brainstrike.writeWorkspaceFile',
        },
      },
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    // Plan mode is announced and read-only investigation is still advertised.
    expect(instructions).toContain('PLAN MODE IS ACTIVE');
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    // The plan-filtered mutation tools must NOT appear — neither their model-facing
    // names (in the registered-tools listing) nor their usage instruction blocks.
    expect(instructions).not.toContain('brainstrike_writeWorkspaceFile');
    expect(instructions).not.toContain('brainstrike_stringReplaceWorkspaceFile');
    expect(instructions).not.toContain('brainstrike_executeCommand');
    expect(instructions).not.toContain('ARBITRARY shell command');
    expect(instructions).not.toContain('fully rewrite one');
    expect(runtime.toolDiscovery?.eligibleToolIds).toEqual(['brainstrike.readWorkspaceFile']);
    expect(runtime.toolDiscovery?.deferredToolIds).not.toEqual(
      expect.arrayContaining([
        'brainstrike.executeCommand',
        'brainstrike.stringReplaceWorkspaceFile',
        'brainstrike.writeWorkspaceFile',
      ])
    );
  });

  it('keeps critical execute guidance but defers noncritical edits when plan mode is OFF', async () => {
    await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.executeCommand': {
          description: 'Execute command',
          id: 'brainstrike.executeCommand',
        },
        'brainstrike.readWorkspaceFile': {
          description: 'Read workspace file',
          id: 'brainstrike.readWorkspaceFile',
        },
        'brainstrike.writeWorkspaceFile': {
          description: 'Write workspace file',
          id: 'brainstrike.writeWorkspaceFile',
        },
      },
    });

    const instructions = agentInstances[0]?.config.instructions ?? '';
    expect(instructions).not.toContain('PLAN MODE IS ACTIVE');
    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).not.toContain('brainstrike_writeWorkspaceFile');
    expect(instructions).toContain('brainstrike_executeCommand');
  });

  it('keeps tools distinct when sanitized ids would otherwise collide', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'web.search': {
          description: 'first',
          id: 'web.search',
        },
        'web/search': {
          description: 'second',
          id: 'web/search',
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
    expect(agent.model?.modelId).toBe('gpt-5.6-terra');
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
    expect(agent.model?.modelId).toBe('claude-sonnet-5');
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
    expect(agent.model?.id).toBe('openrouter/openai/gpt-5.6-terra');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.apiKey).toBe('test-key');
  });

  it('bounds OpenRouter output by default while preserving an explicit override', async () => {
    setMockStreamParts([
      {
        providerMetadata: { openrouter: { usage: { cost: 0 } } },
        type: 'finish',
        usage: { completionTokens: 1, promptTokens: 1 },
      },
    ]);
    const defaultIterator = await streamMastraAgent(
      [{ id: 'u-openrouter-default-cap', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openrouter' } }
    );
    for await (const _chunk of defaultIterator) {
      // drain
    }
    expect(agentInstances[0]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 4096 },
    });

    const overrideIterator = await streamMastraAgent(
      [{ id: 'u-openrouter-custom-cap', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          modelSettings: { maxOutputTokens: 512 },
          provider: 'openrouter',
        },
      }
    );
    for await (const _chunk of overrideIterator) {
      // drain
    }
    expect(agentInstances[1]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 512 },
    });

    const partialSettingsIterator = await streamMastraAgent(
      [
        {
          id: 'u-openrouter-partial-settings',
          parts: [{ text: 'hello', type: 'text' }],
          role: 'user',
        },
      ],
      {
        runtime: {
          apiKey: 'test-key',
          modelSettings: { temperature: 0.2 },
          provider: 'openrouter',
        },
      }
    );
    for await (const _chunk of partialSettingsIterator) {
      // drain
    }
    expect(agentInstances[2]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 4096, temperature: 0.2 },
    });
  });

  it('uses custom model when specified with provider', async () => {
    await createMastraAgentRuntime({
      model: 'claude-sonnet-4-6',
      runtime: { apiKey: 'test-key', provider: 'anthropic' },
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
    const result = resolveRuntimeConfiguration({ apiKey: 'KEY-123', provider: 'OpenAI' });

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
