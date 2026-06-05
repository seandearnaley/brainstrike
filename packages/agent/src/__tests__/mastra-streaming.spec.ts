import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMastraAgentRuntime,
  streamMastraAgent,
  streamMastraToolApprovalAction,
} from '../mastra/agent-runtime';
import { MastraAgentError, type MastraAgentErrorCode } from '../mastra/mastra-agent-error';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';

const agentInstances: Array<{
  approveToolCallCalls: unknown[];
  config: { instructions?: string; memory?: unknown; tools: Record<string, unknown> };
  declineToolCallCalls: unknown[];
  registeredMastra?: unknown;
  streamCalls: Array<{ input: unknown; options: unknown }>;
  tools: Record<string, unknown>;
}> = [];
const mcpInstances: unknown[] = [];
const mastraInstances: Array<{ config: unknown; shutdownCalls: number }> = [];
let mcpToolsets: Record<string, Record<string, { description: string; id: string }>> = {
  filesystem: {
    'remote tool': { id: 'remote tool', description: 'remote' },
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

vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    options: unknown;

    constructor(options: unknown) {
      this.options = options;
      mcpInstances.push(this);
    }

    async listToolsetsWithErrors() {
      return { toolsets: mcpToolsets, errors: {} };
    }

    async disconnect() {
      return;
    }
  },
}));

describe('mastra streaming integration', () => {
  beforeEach(() => {
    agentInstances.length = 0;
    mastraInstances.length = 0;
    mcpInstances.length = 0;
    mcpToolsets = {
      filesystem: {
        'remote tool': { id: 'remote tool', description: 'remote' },
      },
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

  it('emits durable run-events for Mastra tool lifecycle parts without raw payloads', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'web.searchDocs',
        toolCallId: 'c1',
        args: { query: 'secret search' },
        providerExecuted: true,
        dynamic: false,
      },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        result: { confidential: 'tool output' },
        providerExecuted: true,
        dynamic: false,
      },
      {
        type: 'tool-call',
        toolName: 'browser.capture',
        toolCallId: 'c3',
        args: { url: 'https://example.test/private' },
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: 'tool-output',
        toolCallId: 'c3',
        output: { snapshot: 'raw page text' },
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'c3',
        result: { pageTitle: 'safe title' },
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: 'tool-call',
        toolName: 'broken.tool',
        toolCallId: 'c2',
        args: { token: 'hidden' },
      },
      {
        type: 'tool-error',
        toolCallId: 'c2',
        error: { message: 'boom', token: 'hidden' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'search' }] }],
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
        status: 'running',
        metadata: {
          toolCallId: 'c1',
          toolName: 'web.searchDocs',
          providerExecuted: true,
          dynamic: false,
        },
      },
      {
        kind: 'tool.completed',
        label: 'Tool completed',
        status: 'completed',
        metadata: {
          toolCallId: 'c1',
          toolName: 'web.searchDocs',
          providerExecuted: true,
          dynamic: false,
        },
      },
      {
        kind: 'tool.started',
        label: 'Tool started',
        status: 'running',
        metadata: {
          toolCallId: 'c3',
          toolName: 'browser.capture',
          providerExecuted: false,
          dynamic: true,
        },
      },
      {
        kind: 'tool.completed',
        label: 'Tool completed',
        status: 'completed',
        metadata: {
          toolCallId: 'c3',
          toolName: 'browser.capture',
          providerExecuted: false,
          dynamic: true,
        },
      },
      {
        kind: 'tool.started',
        label: 'Tool started',
        status: 'running',
        metadata: {
          toolCallId: 'c2',
          toolName: 'broken.tool',
        },
      },
      {
        kind: 'tool.failed',
        label: 'Tool failed',
        status: 'failed',
        metadata: {
          toolCallId: 'c2',
          toolName: 'broken.tool',
        },
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
        type: 'tool-call',
        toolName: 'background.lookup',
        toolCallId: 'c-output-only',
        args: { query: 'local state' },
      },
      {
        type: 'tool-output',
        toolCallId: 'c-output-only',
        output: { answer: 'done' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );

      const chunks: unknown[] = [];
      chunks.push((await iterator.next()).value);
      chunks.push((await iterator.next()).value);
      vi.setSystemTime(new Date('2026-05-30T08:00:05.000Z'));
      chunks.push((await iterator.next()).value);
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
          status: 'running',
          metadata: {
            toolCallId: 'c-output-only',
            toolName: 'background.lookup',
          },
        },
        {
          kind: 'tool.completed',
          status: 'completed',
          timestamp: '2026-05-30T08:00:05.000Z',
          metadata: {
            toolCallId: 'c-output-only',
            toolName: 'background.lookup',
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses tool-result metadata for completion after an intermediate tool-output', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'browser.capture',
        toolCallId: 'c-result',
        args: { url: 'https://example.test' },
      },
      {
        type: 'tool-output',
        toolCallId: 'c-result',
        output: { snapshot: 'raw page text' },
        providerExecuted: false,
        dynamic: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'c-result',
        result: { pageTitle: 'safe title' },
        providerExecuted: true,
        dynamic: false,
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'capture' }] }],
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
        status: 'completed',
        metadata: {
          toolCallId: 'c-result',
          toolName: 'browser.capture',
          providerExecuted: true,
          dynamic: false,
        },
      },
    ]);
  });

  it('treats Mastra error tool-results as failed durable run-events', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'browser.capture',
        toolCallId: 'c-error-result',
        args: { url: 'https://example.test' },
      },
      {
        type: 'tool-result',
        toolCallId: 'c-error-result',
        result: { message: 'capture failed' },
        isError: true,
        providerExecuted: true,
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'capture' }] }],
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
        status: 'failed',
        metadata: {
          toolCallId: 'c-error-result',
          toolName: 'browser.capture',
          providerExecuted: true,
        },
      },
    ]);
  });

  it('reclassifies a guarded-error tool-result as tool.failed', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'demo',
        toolCallId: 'g1',
        args: {},
      },
      {
        type: 'tool-result',
        toolCallId: 'g1',
        result: { ok: false, error: { code: 'tool_timeout', message: 'x', toolName: 'demo' } },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'run demo' }] }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event' && chunk.event.kind.startsWith('tool.')) {
        terminalEvents.push(chunk.event);
      }
    }

    const kinds = terminalEvents.map((event) => event.kind);
    expect(kinds).toContain('tool.failed');
    expect(kinds).not.toContain('tool.completed');
    expect(terminalEvents).toMatchObject([
      { kind: 'tool.started', status: 'running', metadata: { toolCallId: 'g1', toolName: 'demo' } },
      { kind: 'tool.failed', status: 'failed', metadata: { toolCallId: 'g1', toolName: 'demo' } },
    ]);
  });

  it('lets a terminal tool-error override an earlier intermediate tool-output', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'flaky.lookup',
        toolCallId: 'c-terminal',
        args: { query: 'state' },
      },
      {
        type: 'tool-output',
        toolCallId: 'c-terminal',
        output: { answer: 'done' },
      },
      {
        type: 'tool-error',
        toolCallId: 'c-terminal',
        error: { message: 'late error' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
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
        status: 'failed',
        metadata: {
          toolCallId: 'c-terminal',
          toolName: 'flaky.lookup',
        },
      },
    ]);
  });

  it('keeps the first durable terminal run-event when error precedes success for one tool id', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'flaky.lookup',
        toolCallId: 'c-terminal',
        args: { query: 'state' },
      },
      {
        type: 'tool-error',
        toolCallId: 'c-terminal',
        error: { message: 'early error' },
      },
      {
        type: 'tool-result',
        toolCallId: 'c-terminal',
        result: { answer: 'late success' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
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
        status: 'failed',
        metadata: {
          toolCallId: 'c-terminal',
          toolName: 'flaky.lookup',
        },
      },
    ]);
  });

  it('does not emit durable terminal run-events for id-less Mastra tool-result parts', async () => {
    setMockStreamParts([
      {
        type: 'tool-result',
        toolName: 'anonymous.lookup',
        result: { answer: 'done' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
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
        type: 'tool-call',
        toolName: 'anonymous.lookup',
        args: { query: 'state' },
      },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
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
        type: 'tool-event',
        name: 'anonymous.lookup',
        status: 'start',
      },
    ]);
    expect(toolRunEvents).toEqual([]);
  });

  it('keeps Mastra tool progress parts out of durable run-events', async () => {
    setMockStreamParts([
      { type: 'tool-call', toolName: 'web.searchDocs', toolCallId: 'c1', args: { query: 'x' } },
      { type: 'tool-call-input-streaming-start', toolCallId: 'c1' },
      { type: 'tool-call-delta', toolCallId: 'c1', argsTextDelta: 'que' },
      { type: 'tool-call-input-streaming-end', toolCallId: 'c1' },
      { type: 'finish', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'search' }] }],
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

  it('registers the Agent with a Mastra instance when workflow storage is configured', async () => {
    const memory = { id: 'memory-instance' };
    const storage = { id: 'storage-with-workflows' };

    await createMastraAgentRuntime({
      memory: memory as never,
      storage: storage as never,
      runtime: { apiKey: 'key', provider: 'openai' },
    });

    expect(mastraInstances).toHaveLength(1);
    expect(mastraInstances[0]?.config).toMatchObject({
      agents: { brainstrikeAssistant: agentInstances.at(-1) },
      storage,
    });
    expect(agentInstances.at(-1)?.registeredMastra).toBe(mastraInstances[0]);
  });

  it('shuts down the Mastra instance when disposing a storage-backed runtime', async () => {
    const runtime = await createMastraAgentRuntime({
      storage: { id: 'storage-with-workflows' } as never,
      runtime: { apiKey: 'key', provider: 'openai' },
    });

    await runtime.dispose();

    expect(mastraInstances).toHaveLength(1);
    expect(mastraInstances[0]?.shutdownCalls).toBe(1);
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

  it('flushes output-only tool completions before an approval pause', async () => {
    setMockStreamParts([
      {
        type: 'tool-call',
        toolName: 'background.lookup',
        toolCallId: 'c-output-only-before-approval',
        args: { query: 'local state' },
      },
      {
        type: 'tool-output',
        toolCallId: 'c-output-only-before-approval',
        output: { answer: 'done' },
      },
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
      [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'lookup then approve' }] }],
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
        name: 'background.lookup',
        status: 'start',
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'tool.started',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
        }),
      }),
      expect.objectContaining({
        type: 'tool-event',
        name: 'background.lookup',
        status: 'success',
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'tool.completed',
          metadata: expect.objectContaining({
            toolCallId: 'c-output-only-before-approval',
            toolName: 'background.lookup',
          }),
          status: 'completed',
        }),
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
        type: 'message-finish',
        finishReason: 'tool-calls',
        usage: { promptTokens: 0, completionTokens: 0 },
        path: [],
      },
    ]);
  });

  it('resumes an approved Mastra tool call through the official approval API', async () => {
    const memory = { id: 'memory-instance' };
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { type: 'text-delta', textDelta: 'Approved and continued.' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 3 } },
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
        storage: storage as never,
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

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const agent = agentInstances.at(-1);
    expect(agent?.approveToolCallCalls).toHaveLength(1);
    expect(agent?.declineToolCallCalls).toHaveLength(0);
    expect(agent?.approveToolCallCalls[0]).toMatchObject({
      runId: 'run-approval-1',
      toolCallId: 'tool-call-1',
      memory: {
        thread: 'thread-1',
        resource: 'workspace-a',
        options: { lastMessages: 5 },
      },
      maxSteps: 20,
      requireToolApproval: true,
    });
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Approved and continued.' });
    expect(chunks).toContainEqual({
      type: 'message-finish',
      finishReason: 'stop',
      usage: { promptTokens: 2, completionTokens: 3 },
      path: [],
    });
  });

  it('resumes a declined Mastra tool call through the official decline API', async () => {
    const storage = { id: 'workflow-storage' };
    setMockStreamParts([
      { type: 'text-delta', textDelta: 'Declined and continued.' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 } },
    ]);

    const iterator = await streamMastraToolApprovalAction(
      {
        action: 'decline',
        runId: 'run-approval-2',
        toolCallId: 'tool-call-2',
      },
      {
        requireToolApproval: true,
        storage: storage as never,
        runtime: { apiKey: 'test-key', provider: 'openai' },
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
      runId: 'run-approval-2',
      toolCallId: 'tool-call-2',
      maxSteps: 20,
      requireToolApproval: true,
    });
    expect(chunks).toContainEqual({ type: 'text-delta', value: 'Declined and continued.' });
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
          storage: { id: 'workflow-storage' } as never,
          runtime: { apiKey: 'test-key', provider: 'openai' },
          mcpConfig: {
            servers: [
              {
                transport: 'stdio',
                name: 'filesystem',
                command: 'echo',
              },
            ],
          },
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
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'tool.started',
          status: 'running',
        }),
      }),
      expect.objectContaining({
        type: 'tool-event',
        status: 'success',
        name: 'brainstrike.queryEmbeddingSpace',
      }),
      expect.objectContaining({
        type: 'run-event',
        event: expect.objectContaining({
          kind: 'tool.completed',
          status: 'completed',
        }),
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

    expect(Object.keys(agentConfig)).toEqual(
      expect.arrayContaining(['local_tool', 'filesystem_remote_tool'])
    );

    expect(runtime.toolNameMap.get('local_tool')).toBe('local tool');
    expect(runtime.toolNameMap.get('filesystem_remote_tool')).toBe('filesystem.remote tool');
  });

  it('uses model-facing Brainstrike native tool names in default instructions', async () => {
    mcpToolsets = {
      filesystem: {
        search_files: {
          id: 'search_files',
          description: 'Search files',
        },
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
