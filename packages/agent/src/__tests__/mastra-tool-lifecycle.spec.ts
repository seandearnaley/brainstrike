/**
 * BST-988: the tool-lifecycle slice of the Mastra stream boundary — every
 * behaviour owned by `mastra/tool-lifecycle-processors.ts` (BST-986):
 * `ToolLifecycleState`, `mapToolLifecyclePart`, `mapGenericToolEvent`,
 * `makePendingToolOutputRunEventChunks` and `makeLifecycleStepMetadata`.
 *
 * WHY THESE DRIVE THE FULL STREAM. These are not direct unit tests and were
 * never written as such: the lifecycle mappers are reachable only through the
 * R6 dispatch (`processMastraStreamPart` in `agent-streaming.ts`), and the
 * ORDERING they must produce — started before terminal, terminal-wins-once,
 * pending output-only completions flushed at the right moment — is a property
 * of the dispatch loop, not of any single mapper. Every test here was MOVED
 * unchanged from `mastra-streaming.spec.ts`; the fake Mastra stream comes from
 * the shared harness.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md R6.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { streamMastraAgent } from '../mastra/agent-streaming';
import { resetMastraStreamHarness, setMockStreamParts } from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);

vi.mock(
  '@ai-sdk/anthropic',
  async () => (await import('./fixtures/mastra-stream-harness')).anthropicSdkMock
);

vi.mock(
  '@ai-sdk/google',
  async () => (await import('./fixtures/mastra-stream-harness')).googleSdkMock
);

vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);

vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

vi.mock(
  '../mcp/explicit-stdio-client',
  async () => (await import('./fixtures/mastra-stream-harness')).explicitStdioMcpClientModuleMock
);

describe('mastra streaming: tool lifecycle', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
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

  it('pairs a DECLINED delegation off with a terminal subagent run event', async () => {
    // BST-1282 review. A delegation tool (`agent-<persona>`) can be approval-
    // gated by an explicit global gate, and its `tool-call` already emitted
    // `subagent.started`. The decline is that delegation's ONLY terminal — no
    // later tool-result/tool-error carries the id — so `tool-output-denied`
    // must travel the DELEGATION path, not the generic tool-event path, or the
    // started event is the one delegation lifecycle left without a counterpart.
    setMockStreamParts([
      {
        args: { task: 'find the flag' },
        toolCallId: 'delegation-call-1',
        toolName: 'agent-explore',
        type: 'tool-call',
      },
      {
        payload: {
          approval: { approved: false, id: 'delegation-call-1' },
          args: { task: 'find the flag' },
          toolCallId: 'delegation-call-1',
          toolName: 'agent-explore',
        },
        type: 'tool-output-denied',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'delegate this', type: 'text' }], role: 'user' }],
      {
        personas: [
          {
            allowedToolIds: ['brainstrike.grepSearch'],
            description: 'Explore the workspace and report findings.',
            id: 'explore',
            instructions: 'You are the Explorer subagent.',
            label: 'Explorer',
            maxSteps: 8,
          },
        ],
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': {
            description: 'Search the workspace.',
            id: 'brainstrike.grepSearch',
          },
        },
      }
    );

    const subagentEvents = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event' && chunk.event.kind.startsWith('subagent.')) {
        subagentEvents.push(chunk.event);
      }
    }

    expect(subagentEvents).toMatchObject([
      {
        kind: 'subagent.started',
        metadata: { parentToolCallId: 'delegation-call-1', personaId: 'explore' },
        status: 'running',
      },
      {
        kind: 'subagent.failed',
        label: 'Subagent delegation declined',
        metadata: { parentToolCallId: 'delegation-call-1', personaId: 'explore' },
        // The child never ran and nothing broke: cancelled, not failed.
        status: 'cancelled',
      },
    ]);
  });

  it('emits one failed terminal when a delegation has both error and result parts', async () => {
    setMockStreamParts([
      {
        args: { task: 'inspect' },
        toolCallId: 'worker-call',
        toolName: 'agent-explore',
        type: 'tool-call',
      },
      {
        error: { message: 'worker failed' },
        toolCallId: 'worker-call',
        toolName: 'agent-explore',
        type: 'tool-error',
      },
      {
        result: { text: 'worker failed' },
        toolCallId: 'worker-call',
        toolName: 'agent-explore',
        type: 'tool-result',
      },
      { type: 'finish', usage: { completionTokens: 2, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'delegate this', type: 'text' }], role: 'user' }],
      {
        personas: [
          {
            allowedToolIds: ['brainstrike.grepSearch'],
            description: 'Explore the workspace and report findings.',
            id: 'explore',
            instructions: 'You are the Explorer subagent.',
            label: 'Explorer',
            maxSteps: 8,
          },
        ],
        runtime: { apiKey: 'test-key', provider: 'openai' },
        tools: {
          'brainstrike.grepSearch': {
            description: 'Search the workspace.',
            id: 'brainstrike.grepSearch',
          },
        },
      }
    );

    const terminalEvents = [];
    for await (const chunk of iterator) {
      if (
        chunk.type === 'run-event' &&
        (chunk.event.kind === 'tool.failed' ||
          chunk.event.kind === 'subagent.failed' ||
          chunk.event.kind === 'subagent.finished')
      ) {
        terminalEvents.push(chunk.event.kind);
      }
    }
    expect(terminalEvents).toEqual(['tool.failed', 'subagent.failed']);
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

  it('carries step usage nested under payload.output (the REAL Mastra shape) on run.step.finished', async () => {
    // Production regression caught by live CDT: a real Mastra `step-finish`
    // carries usage under `payload.output.usage`, NOT top-level `usage` — only
    // the fixtures put it there. `makeStepMetadata` read just `p.usage`, so
    // every step event shipped token-free and the renderer's live thread-total
    // tick silently never fired. The candidate chain must match
    // accumulateSteppedUsage / makeFinishChunk.
    setMockStreamParts([
      { messageId: 'msg-1', type: 'start' },
      { messageId: 'msg-1', type: 'step-start' },
      {
        payload: { output: { usage: { inputTokens: 777, outputTokens: 88 } } },
        type: 'step-finish',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 88, promptTokens: 777 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const stepFinished = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'run.step.finished'
    ) as { event: { metadata?: Record<string, unknown> } };
    expect(stepFinished.event.metadata).toMatchObject({
      completionTokens: 88,
      promptTokens: 777,
    });
  });

  it('carries AI-SDK-v2-shaped step usage on run.step.finished metadata (live-tick review fix)', async () => {
    // v2 parts report `inputTokens`/`outputTokens`; the step event must carry
    // BOTH counts or the renderer live tick silently never fires (its reader
    // requires promptTokens AND completionTokens).
    //
    // The usage rides `payload.output` — the shape production actually emits.
    // This fixture originally put it top-level, which no real `step-finish`
    // does, so the guard it advertised was fictitious and stayed green through
    // the outage it was meant to catch (review finding).
    setMockStreamParts([
      { messageId: 'msg-1', type: 'start' },
      { messageId: 'msg-1', type: 'step-start' },
      {
        payload: { output: { usage: { inputTokens: 321, outputTokens: 45 } } },
        type: 'step-finish',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 45, promptTokens: 321 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const stepFinished = chunks.find(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'run.step.finished'
    ) as { event: { metadata?: Record<string, unknown> } };
    expect(stepFinished.event.metadata).toMatchObject({
      completionTokens: 45,
      promptTokens: 321,
    });
  });
});
