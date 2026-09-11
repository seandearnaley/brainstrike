/**
 * BST-988: what is LEFT of the Mastra streaming spec after the per-module
 * split — end-to-end stream ORCHESTRATION plus runtime assembly.
 *
 * The three module-owned slices moved out to `mastra-tool-lifecycle.spec.ts`,
 * `mastra-tool-approval-chunks.spec.ts` and `mastra-stream-termination.spec.ts`.
 * What stays here is behaviour no single BST-986 module owns: the async-iterator
 * contract itself, the R6 unknown-chunk diagnostic, token measurement,
 * usage/cost accumulation across model steps, steering, observational-memory
 * chunk handling, memory + stream-option validation, and everything reached
 * through `createMastraAgentRuntime` (tool assembly, deferred-catalog
 * collisions, instruction building, provider selection).
 *
 * The fake Mastra stream lives in `./fixtures/mastra-stream-harness`.
 */

import type { ReadableStream } from 'node:stream/web';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { MastraDBMessage } from '@mastra/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { streamMastraAgent } from '../mastra/agent-streaming';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
} from '../mastra/attempt-legs';
import { createDelegatedConversationBinding } from '../mastra/delegated-conversation-binding';
import { MastraAgentError } from '../mastra/mastra-agent-error';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';
import { RunTokenDiagnostics } from '../mastra/token-measurement';
import {
  agentInstances,
  expectLeadingContextBreakdown,
  expectMastraAgentError,
  mastraInstances,
  mcpHost,
  mcpInstances,
  resetMastraStreamHarness,
  setMcpDiscoveryFailure,
  setMcpToolsets,
  setMockMessageList,
  setMockStreamParts,
  setMockTitleGenerationHandler,
  setMockTitleGenerationResults,
  setMockTitleModel,
  setStreamCompletion,
  setStreamFailure,
  setStreamPartDelayMs,
  setStreamPartFailure,
  setSuspendedRuns,
} from './fixtures/mastra-stream-harness';

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

vi.mock('@brainstrike/agent/mcp-client', async () => {
  const { explicitStdioMcpClientModuleMock } = await import('./fixtures/mastra-stream-harness');
  return {
    ExplicitHttpMcpClient: explicitStdioMcpClientModuleMock.ExplicitStdioMcpClient,
    ...explicitStdioMcpClientModuleMock,
  };
});

function makeTitleMemory(options?: {
  generateTitle?: unknown;
  getThreadById?: ReturnType<typeof vi.fn>;
  saveThread?: ReturnType<typeof vi.fn>;
}) {
  const thread = {
    createdAt: new Date('2026-08-24T12:00:00.000Z'),
    id: 'thread-title-contract',
    resourceId: 'resource-title-contract',
    title: 'New Thread',
    updatedAt: new Date('2026-08-24T12:00:00.000Z'),
  };
  return {
    getMergedThreadConfig: vi.fn(() => ({ generateTitle: options?.generateTitle ?? true })),
    getThreadById: options?.getThreadById ?? vi.fn().mockResolvedValue(thread),
    id: 'memory-title-contract',
    saveThread: options?.saveThread ?? vi.fn(),
    thread,
  };
}

async function startTitleContractTurn(memory: ReturnType<typeof makeTitleMemory>) {
  setMockStreamParts([
    { textDelta: 'The main response succeeded.', type: 'text-delta' },
    { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 8 } },
  ]);
  return await streamMastraAgent(
    [
      {
        id: 'user-title-contract',
        parts: [{ text: 'Name this conversation.', type: 'text' }],
        role: 'user',
      },
    ],
    {
      memory: memory as never,
      runtime: {
        apiKey: 'test-key',
        memory: { resourceId: memory.thread.resourceId, threadId: memory.thread.id },
        model: 'openai/gpt-oss-120b',
        modelSettings: { maxOutputTokens: 321 },
        provider: 'openrouter',
        providerOptions: {
          openrouter: {
            provider: { require_parameters: true },
            reasoning: { effort: 'high' },
          },
        },
      },
    }
  );
}

function findTitleDiagnostic(logRecords: readonly LogRecord[], code: string) {
  return logRecords
    .flatMap((record) => record.args)
    .find(
      (argument): argument is Record<string, unknown> =>
        Boolean(argument && typeof argument === 'object') &&
        (argument as { code?: unknown }).code === code
    );
}

describe('mastra streaming integration', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
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
        usage: {
          completionTokens: 11,
          contextInputTokens: 7,
          contextOutputTokens: 11,
          promptTokens: 7,
        },
      },
    ]);
  });

  it('generates a title when a non-aborted stream ends without a raw finish part', async () => {
    setMockStreamParts([{ textDelta: 'Here is the answer.', type: 'text-delta' }]);
    setMockTitleGenerationResults(['Workspace Review']);
    const thread = {
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      id: 'thread-title-missing-finish',
      resourceId: 'resource-title-missing-finish',
      title: 'New Thread',
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
    };
    const memory = {
      getMergedThreadConfig: vi.fn(() => ({ generateTitle: true })),
      getThreadById: vi.fn(async () => thread),
      id: 'memory-title-missing-finish',
      saveThread: vi.fn(),
    };

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-title-missing-finish',
          parts: [{ text: 'Review this workspace.', type: 'text' }],
          role: 'user',
        },
      ],
      {
        memory: memory as never,
        runtime: {
          apiKey: 'test-key',
          memory: {
            resourceId: thread.resourceId,
            threadId: thread.id,
          },
          provider: 'openai',
        },
      }
    );

    for await (const _chunk of iterator) {
      // drain
    }

    expect(agentInstances[0]?.generateTitleFromUserMessageCalls).toHaveLength(1);
    expect(memory.saveThread).toHaveBeenCalledWith({
      thread: expect.objectContaining({ id: thread.id, title: 'Workspace Review' }),
    });
  });

  it('retries one OpenRouter empty title on the same agent and persists the retry result', async () => {
    setMockStreamParts([
      { textDelta: 'Here is the answer.', type: 'text-delta' },
      {
        finishReason: 'stop',
        providerMetadata: { openrouter: { usage: { cost: 0.001 } } },
        type: 'finish',
        usage: { completionTokens: 2, promptTokens: 8 },
      },
    ]);
    setMockTitleGenerationResults(['', 'Reasoning Route Title']);
    const thread = {
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
      id: 'thread-title-openrouter-empty',
      resourceId: 'resource-title-openrouter-empty',
      title: 'New Thread',
      updatedAt: new Date('2026-08-24T12:00:00.000Z'),
    };
    const memory = {
      getMergedThreadConfig: vi.fn(() => ({ generateTitle: true })),
      getThreadById: vi.fn(async () => thread),
      id: 'memory-title-openrouter-empty',
      saveThread: vi.fn(),
    };

    const iterator = await streamMastraAgent(
      [
        {
          id: 'user-title-openrouter-empty',
          parts: [{ text: 'Explain this reasoning route.', type: 'text' }],
          role: 'user',
        },
      ],
      {
        memory: memory as never,
        runtime: {
          apiKey: 'test-key',
          memory: {
            resourceId: thread.resourceId,
            threadId: thread.id,
          },
          model: 'openai/gpt-5.6-terra',
          provider: 'openrouter',
        },
      }
    );

    for await (const _chunk of iterator) {
      // drain
    }

    const titleCalls = agentInstances[0]?.generateTitleFromUserMessageCalls ?? [];
    expect(titleCalls).toHaveLength(2);
    expect(agentInstances[0]?.getModelCalls).toHaveLength(1);
    expect(titleCalls[1]).toEqual(titleCalls[0]);
    expect(memory.saveThread).toHaveBeenCalledWith({
      thread: expect.objectContaining({ id: thread.id, title: 'Reasoning Route Title' }),
    });
  });

  it('propagates and merges active OpenRouter title routing with its output bound', async () => {
    const forwardedCalls: Record<string, unknown>[] = [];
    const titleModel = {
      doStream: vi.fn((options: Record<string, unknown>) => {
        forwardedCalls.push(options);
        return Promise.resolve({});
      }),
      modelId: 'openai/gpt-oss-120b',
      provider: 'openrouter',
      specificationVersion: 'v2',
    };
    setMockTitleModel(titleModel);
    setMockTitleGenerationHandler(async (options) => {
      const request = options as {
        model?: { doStream?: (input: Record<string, unknown>) => Promise<unknown> };
      };
      await request.model?.doStream?.({
        prompt: [],
        providerOptions: {
          openrouter: { existingTitleOption: true },
          testProvider: { preserved: true },
        },
      });
      return 'Provider-safe title';
    });
    const memory = makeTitleMemory({
      generateTitle: { instructions: 'Use a short title.', model: titleModel },
    });

    const iterator = await startTitleContractTurn(memory);
    for await (const _chunk of iterator) {
      // drain
    }

    expect(agentInstances.at(-1)?.getModelCalls).toEqual([
      expect.objectContaining({ modelConfig: titleModel }),
    ]);
    expect(forwardedCalls).toEqual([
      {
        abortSignal: expect.any(AbortSignal),
        maxOutputTokens: 321,
        prompt: [],
        providerOptions: {
          openrouter: {
            existingTitleOption: true,
            provider: { require_parameters: true },
            reasoning: { effort: 'high' },
          },
          testProvider: { preserved: true },
        },
      },
    ]);
  });

  it('records actionable content-free title provider and invalid-output diagnostics', async () => {
    const providerFailure = Object.assign(new Error('private provider response'), {
      name: 'AI_APICallError',
      statusCode: 429,
    });
    setMockTitleGenerationResults([providerFailure]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      const providerIterator = await startTitleContractTurn(makeTitleMemory());
      for await (const _chunk of providerIterator) {
        // drain
      }
      setMockTitleGenerationResults([' ', '']);
      const emptyIterator = await startTitleContractTurn(makeTitleMemory());
      for await (const _chunk of emptyIterator) {
        // drain
      }
    } finally {
      removeLogListener();
    }

    const providerDiagnostic = findTitleDiagnostic(
      logRecords,
      'mastra_thread_title_provider_failed'
    );
    expect(providerDiagnostic).toMatchObject({
      httpStatus: 429,
      providerErrorCode: 'mastra_agent_stream_provider_error',
      stage: 'provider',
    });
    expect(providerDiagnostic).not.toHaveProperty('error');
    expect(
      logRecords
        .flatMap((record) => record.args)
        .filter(
          (argument) =>
            Boolean(argument && typeof argument === 'object') &&
            (argument as { code?: unknown }).code === 'mastra_thread_title_invalid_output'
        )
    ).toHaveLength(2);
    expect(JSON.stringify(logRecords)).not.toContain('private provider response');
  });

  it('reports malformed title configuration separately from PGlite persistence', async () => {
    const memory = makeTitleMemory();
    memory.getMergedThreadConfig
      .mockImplementationOnce(() => ({ generateTitle: true, readOnly: false }))
      .mockImplementation(() => {
        throw new TypeError('private config detail');
      });
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      const iterator = await startTitleContractTurn(memory);
      for await (const _chunk of iterator) {
        // drain
      }
    } finally {
      removeLogListener();
    }

    expect(findTitleDiagnostic(logRecords, 'mastra_thread_title_config_invalid')).toMatchObject({
      errorName: 'TypeError',
      stage: 'config',
    });
    expect(JSON.stringify(logRecords)).not.toContain('private config detail');
  });

  it('skips title generation without a complete thread scope or textual user input', async () => {
    setMockTitleGenerationResults(['Unreachable title']);
    setMockStreamParts([
      { textDelta: 'The main response succeeded.', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 2, promptTokens: 8 } },
    ]);
    const unscopedMemory = makeTitleMemory();
    const unscopedIterator = await streamMastraAgent(
      [{ id: 'user-unscoped-title', parts: [{ text: 'Name this.', type: 'text' }], role: 'user' }],
      {
        memory: unscopedMemory as never,
        runtime: { apiKey: ['unit', 'test'].join('-'), provider: 'openai' },
      }
    );
    for await (const _chunk of unscopedIterator) {
      // drain
    }

    const noTextMemory = makeTitleMemory();
    const noTextIterator = await streamMastraAgent(
      [{ id: 'user-no-text-title', parts: [], role: 'user' }],
      {
        memory: noTextMemory as never,
        runtime: {
          apiKey: ['unit', 'test'].join('-'),
          memory: {
            resourceId: noTextMemory.thread.resourceId,
            threadId: noTextMemory.thread.id,
          },
          provider: 'openai',
        },
      }
    );
    for await (const _chunk of noTextIterator) {
      // drain
    }

    expect(agentInstances.at(-2)?.generateTitleFromUserMessageCalls).toHaveLength(0);
    expect(agentInstances.at(-1)?.generateTitleFromUserMessageCalls).toHaveLength(0);
    expect(unscopedMemory.saveThread).not.toHaveBeenCalled();
    expect(noTextMemory.saveThread).not.toHaveBeenCalled();
  });

  it('keeps disabled and user-owned thread titles unchanged', async () => {
    setMockTitleGenerationResults(['Unreachable title']);
    const disabledMemory = makeTitleMemory({ generateTitle: false });
    const disabledIterator = await startTitleContractTurn(disabledMemory);
    for await (const _chunk of disabledIterator) {
      // drain
    }

    const userOwnedMemory = makeTitleMemory({
      getThreadById: vi.fn().mockResolvedValue({
        ...makeTitleMemory().thread,
        title: 'My chosen title',
      }),
    });
    const userOwnedIterator = await startTitleContractTurn(userOwnedMemory);
    for await (const _chunk of userOwnedIterator) {
      // drain
    }

    expect(disabledMemory.saveThread).not.toHaveBeenCalled();
    expect(userOwnedMemory.saveThread).not.toHaveBeenCalled();
    expect(agentInstances.at(-2)?.generateTitleFromUserMessageCalls).toHaveLength(0);
    expect(agentInstances.at(-1)?.generateTitleFromUserMessageCalls).toHaveLength(0);
  });

  it('reports title model resolution and PGlite read/write failures by stage', async () => {
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      setMockTitleModel(new Error('private model resolution detail'));
      const modelIterator = await startTitleContractTurn(makeTitleMemory());
      for await (const _chunk of modelIterator) {
        // drain
      }

      setMockTitleModel(undefined);
      const readMemory = makeTitleMemory({
        getThreadById: vi.fn().mockRejectedValue({ code: 'PGLITE_READ_PRIVATE' }),
      });
      const readIterator = await startTitleContractTurn(readMemory);
      for await (const _chunk of readIterator) {
        // drain
      }

      setMockTitleGenerationResults(['Write failure title']);
      const writeMemory = makeTitleMemory({
        saveThread: vi.fn().mockRejectedValue({ code: 'PGLITE_WRITE_PRIVATE' }),
      });
      const writeIterator = await startTitleContractTurn(writeMemory);
      for await (const _chunk of writeIterator) {
        // drain
      }
    } finally {
      removeLogListener();
    }

    expect(findTitleDiagnostic(logRecords, 'mastra_thread_title_provider_failed')).toMatchObject({
      attempt: 1,
      stage: 'provider',
    });
    const persistenceDiagnostics = logRecords
      .flatMap((record) => record.args)
      .filter(
        (argument): argument is Record<string, unknown> =>
          Boolean(argument && typeof argument === 'object') &&
          (argument as { code?: unknown }).code === 'mastra_thread_title_persistence_failed'
      );
    expect(persistenceDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          databaseCode: 'PGLITE_READ_PRIVATE',
          errorName: 'UnknownError',
          stage: 'persistence-read',
        }),
        expect.objectContaining({
          databaseCode: 'PGLITE_WRITE_PRIVATE',
          errorName: 'UnknownError',
          stage: 'persistence-write',
        }),
      ])
    );
    expect(JSON.stringify(logRecords)).not.toContain('private model resolution detail');
  });

  it('aborts the underlying title provider request when the lifecycle expires', async () => {
    vi.useFakeTimers();
    let titleSignal: AbortSignal | undefined;
    const titleModel = {
      doStream: vi.fn((options: { abortSignal?: AbortSignal }) => {
        titleSignal = options.abortSignal;
        return new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason),
            {
              once: true,
            }
          );
        });
      }),
      modelId: 'openai/gpt-oss-120b',
      provider: 'openrouter',
      specificationVersion: 'v2',
    };
    setMockTitleModel(titleModel);
    setMockTitleGenerationHandler(async (options) => {
      const request = options as {
        model?: { doStream?: (input: Record<string, unknown>) => Promise<unknown> };
      };
      await request.model?.doStream?.({ prompt: [] });
      return 'Unreachable title';
    });

    try {
      const iterator = await startTitleContractTurn(
        makeTitleMemory({ generateTitle: { model: titleModel } })
      );
      let sawFinish = false;
      while (!sawFinish) {
        const result = await iterator.next();
        sawFinish =
          Boolean(result.value && typeof result.value === 'object') &&
          (result.value as { type?: unknown }).type === 'message-finish';
      }
      const completion = iterator.next();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(completion).resolves.toMatchObject({ done: true });
    } finally {
      vi.useRealTimers();
    }

    expect(titleSignal?.aborted).toBe(true);
  });

  it('persists a stalled attempt before disposing after continuation construction fails', async () => {
    const previousOpenAiKey = process.env['OPENAI_API_KEY'];
    const previousToolTimeout = process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'];
    const previousFirstOutput = process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'];
    const previousStreamInactivity = process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'];
    const previousStallAttempts = process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '10';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '20';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '20';
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '2';
    setMockStreamParts([{ textDelta: 'late', type: 'text-delta' }]);
    setStreamPartDelayMs(500);
    setStreamFailure(2, new Error('continuation construction failed'));

    const createdAt = new Date('2026-08-21T12:00:00.000Z');
    const userMessage: MastraDBMessage = {
      content: { format: 2, parts: [{ text: 'Use the completed tool.', type: 'text' }] },
      createdAt,
      id: 'user-continuation-failure',
      resourceId: 'resource-continuation-failure',
      role: 'user',
      threadId: 'thread-continuation-failure',
    };
    const assistantMessage: MastraDBMessage = {
      content: {
        format: 2,
        parts: [
          {
            toolInvocation: {
              args: { path: 'completed.ts' },
              result: { text: 'done' },
              state: 'result',
              toolCallId: 'call-continuation-failure',
              toolName: 'read_file',
            },
            type: 'tool-invocation',
          },
        ],
      },
      createdAt,
      id: 'assistant-continuation-failure',
      resourceId: 'resource-continuation-failure',
      role: 'assistant',
      threadId: 'thread-continuation-failure',
    };
    setMockMessageList({
      drainUnsavedMessages: () => [userMessage, assistantMessage],
      get: { response: { db: () => [assistantMessage] } },
    });

    const shutdownCallsAtSave: number[] = [];
    const memory = {
      createThread: vi.fn(),
      getMergedThreadConfig: vi.fn(() => ({ readOnly: false })),
      getThreadById: vi.fn().mockResolvedValue({ id: 'thread-continuation-failure' }),
      saveMessages: vi.fn(async ({ messages }: { messages: MastraDBMessage[] }) => {
        shutdownCallsAtSave.push(mastraInstances[0]?.shutdownCalls ?? -1);
        return { messages };
      }),
    };

    try {
      const iterator = await streamMastraAgent(
        [
          {
            id: 'user-continuation-failure',
            parts: [{ text: 'Use the completed tool.', type: 'text' }],
            role: 'user',
          },
        ],
        {
          memory: memory as never,
          runtime: {
            assistantMessageId: 'assistant-continuation-failure',
            memory: {
              resourceId: 'resource-continuation-failure',
              threadId: 'thread-continuation-failure',
            },
            provider: 'openai',
          },
          storage: { id: 'continuation-failure-storage' } as never,
        }
      );

      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ kind: 'run.failed' }),
          type: 'run-event',
        })
      );
      expect(shutdownCallsAtSave).toEqual([0]);
      expect(mastraInstances[0]?.shutdownCalls).toBe(1);
    } finally {
      if (previousOpenAiKey === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      } else {
        process.env['OPENAI_API_KEY'] = previousOpenAiKey;
      }
      if (previousToolTimeout === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_TOOL_TIMEOUT_MS');
      } else {
        process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = previousToolTimeout;
      }
      if (previousFirstOutput === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = previousFirstOutput;
      }
      if (previousStreamInactivity === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_INACTIVITY_MS');
      } else {
        process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = previousStreamInactivity;
      }
      if (previousStallAttempts === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_STREAM_STALL_ATTEMPTS');
      } else {
        process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = previousStallAttempts;
      }
    }
  }, 30_000);

  it('records one diagnostic per unknown dynamic type and continues streaming', async () => {
    setMockStreamParts([
      { type: 'data-future-mastra-stream-chunk' },
      { type: 'data-future-mastra-stream-chunk' },
      { textDelta: 'still streaming', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-1', parts: [{ text: 'hi there', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: 'text-delta', value: 'still streaming' });
      expect(chunks).toContainEqual(
        expect.objectContaining({ finishReason: 'stop', type: 'message-finish' })
      );
    } finally {
      removeLogListener();
    }

    const diagnosticRecords = logRecords.filter((record) =>
      record.args.some(
        (arg) =>
          Boolean(arg && typeof arg === 'object') &&
          (arg as { code?: unknown }).code === 'mastra_agent_unrecognized_stream_chunk'
      )
    );
    const diagnosticFields = diagnosticRecords[0]?.args.find(
      (arg): arg is Record<string, unknown> =>
        Boolean(arg && typeof arg === 'object') &&
        (arg as { code?: unknown }).code === 'mastra_agent_unrecognized_stream_chunk'
    );
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]?.level).toBe(LogLevel.WARN);
    expect(diagnosticFields).toMatchObject({
      chunkType: 'data-future-mastra-stream-chunk',
      code: 'mastra_agent_unrecognized_stream_chunk',
    });
  });

  it('records bounded token diagnostics with actual accumulated provider prompt usage', async () => {
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
      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
      // Non-vacuity: the consumer really did receive the pre-failure part, so
      // this is a MID-STREAM escape and not a stream that never started.
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks).not.toContainEqual(
        expect.objectContaining({ type: 'token-estimate-calibration' })
      );
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
      // Finish-only stream: the sum comes from Mastra's terminal usage, no
      // step-finish ever ran, and there is no per-request measurement to
      // report — absence is honest, 7-as-latest would be fabricated.
      promptTokensSummedAcrossSteps: 7,
      provider: 'openai',
      stepCount: 0,
      tokenizer: 'o200k_base',
      toolDefinitionCount: 0,
    });
  });

  it('reports the per-request context size and step count honestly, not only the leg sum', async () => {
    // Field confusion (2026-08-23): a 10-step leg logged
    // providerReportedPromptTokens 733,954 — read as a catastrophic context
    // explosion, investigated as one, and disproven: the field stored the SUM
    // of prompt tokens across the leg's steps, while the actual per-request
    // context topped out far lower. The log must carry BOTH numbers under
    // names that cannot be misread, plus the step count that relates them.
    setMockStreamParts([
      { textDelta: 'two-step answer', type: 'text-delta' },
      { type: 'step-finish', usage: { completionTokens: 2, promptTokens: 10 } },
      { type: 'step-finish', usage: { completionTokens: 3, promptTokens: 40 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 5, promptTokens: 50 } },
    ]);
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-1', parts: [{ text: 'two steps', type: 'text' }], role: 'user' }],
        { runtime: { apiKey: 'test-key', provider: 'openai' } }
      );
      for await (const _chunk of iterator) {
        // drain
      }
    } finally {
      removeLogListener();
    }
    const fields = logRecords
      .map((record) => record.args[0] as Record<string, unknown>)
      .find((arg) => arg?.['code'] === 'mastra_agent_token_measurement');
    expect(fields).toMatchObject({
      // The actual size of the LAST request's context — the number that says
      // whether the prompt is growing.
      latestStepPromptTokens: 40,
      // The leg's spend: 10 + 40 (Mastra's terminal usage restates this sum).
      promptTokensSummedAcrossSteps: 50,
      stepCount: 2,
    });
    expect(fields).not.toHaveProperty('providerReportedPromptTokens');
  });

  it('uses the final step prompt and step count for a completed multi-step calibration row', async () => {
    const fieldsSpy = vi.spyOn(RunTokenDiagnostics.prototype, 'toLogFields').mockReturnValue({
      measurementMode: 'declared-compatible-reference',
      measurementStatus: 'measured',
      modelVisibleProjectionBackstopTokens: 8,
      modelVisibleProjectionCount: 1,
      toolDefinitionBackstopTokens: 2,
      toolDefinitionCount: 0,
    });
    setMockStreamParts([
      { textDelta: 'multi-step answer', type: 'text-delta' },
      { type: 'step-finish', usage: { completionTokens: 2, promptTokens: 10 } },
      { type: 'step-finish', usage: { completionTokens: 3, promptTokens: 40 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 5, promptTokens: 50 } },
    ]);

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-1', parts: [{ text: 'use a tool', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            model: 'gpt-5.6-terra',
            provider: 'openai',
          },
        }
      );
      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({
        type: 'token-estimate-calibration',
        value: {
          estimatedPromptTokens: 10,
          finalStepPromptTokens: 40,
          model: 'gpt-5.6-terra',
          modelVisibleProjectionCount: 1,
          occurredAt: expect.any(Number),
          promptBreakdownBaselineTokens: expect.any(Number),
          provider: 'openai',
          resolvedDomainBudgetTokens: 3000,
          resolvedTransportBudgetTokens: 6000,
          stepCount: 2,
        },
      });
      const breakdown = chunks.find(
        (chunk): chunk is { breakdown: Record<string, number>; type: 'context-breakdown' } =>
          Boolean(
            chunk &&
              typeof chunk === 'object' &&
              (chunk as { type?: unknown }).type === 'context-breakdown'
          )
      )?.breakdown;
      const calibration = chunks.find(
        (
          chunk
        ): chunk is {
          type: 'token-estimate-calibration';
          value: { promptBreakdownBaselineTokens: number };
        } =>
          Boolean(
            chunk &&
              typeof chunk === 'object' &&
              (chunk as { type?: unknown }).type === 'token-estimate-calibration'
          )
      );
      expect(calibration?.value.promptBreakdownBaselineTokens).toBe(
        (breakdown?.['systemInstructionsTokens'] ?? 0) +
          (breakdown?.['taskListTokens'] ?? 0) +
          (breakdown?.['toolDefinitionsTokens'] ?? 0)
      );
    } finally {
      fieldsSpy.mockRestore();
    }
  });

  // BST-1232 review (P1): a tool-free chat turn used to be entirely
  // ineligible for this chunk (the old gate required at least one measured
  // tool-output projection), which meant an ordinary chat thread NEVER
  // persisted `promptBreakdownBaselineTokens` — silently starving the next
  // turn's compaction trigger of the one value migration 091 exists to give
  // it. A zero-projection completed run must still emit the chunk whenever a
  // run-start `promptBreakdown` exists to source a baseline from.
  it('still persists a baseline-carrying calibration row when a completed run has no tool outputs', async () => {
    setMockStreamParts([
      { textDelta: 'tool-free answer', type: 'text-delta' },
      { type: 'step-finish', usage: { completionTokens: 1, promptTokens: 7 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 7 } },
    ]);
    const iterator = await streamMastraAgent(
      [{ id: 'user-1', parts: [{ text: 'answer directly', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          model: 'gpt-5.6-terra',
          provider: 'openai',
        },
      }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const calibration = chunks.find(
      (chunk): chunk is { type: 'token-estimate-calibration'; value: Record<string, unknown> } =>
        Boolean(
          chunk &&
            typeof chunk === 'object' &&
            (chunk as { type?: unknown }).type === 'token-estimate-calibration'
        )
    );
    expect(calibration).toBeDefined();
    expect(calibration?.value).toMatchObject({
      modelVisibleProjectionCount: 0,
      promptBreakdownBaselineTokens: expect.any(Number),
    });
    expect((calibration?.value['promptBreakdownBaselineTokens'] as number) > 0).toBe(true);
  });

  it('omits token-estimate calibration when the stream ends without finish', async () => {
    const fieldsSpy = vi.spyOn(RunTokenDiagnostics.prototype, 'toLogFields').mockReturnValue({
      measurementMode: 'declared-compatible-reference',
      measurementStatus: 'measured',
      modelVisibleProjectionBackstopTokens: 8,
      modelVisibleProjectionCount: 1,
      toolDefinitionCount: 0,
    });
    setMockStreamParts([
      { type: 'step-finish', usage: { completionTokens: 1, promptTokens: 7 } },
      { textDelta: 'stream ended early', type: 'text-delta' },
    ]);
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

    try {
      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(chunks).not.toContainEqual(
        expect.objectContaining({ type: 'token-estimate-calibration' })
      );
    } finally {
      fieldsSpy.mockRestore();
    }
  });

  it('omits token-estimate calibration when a non-watchdog stream error escapes', async () => {
    const fieldsSpy = vi.spyOn(RunTokenDiagnostics.prototype, 'toLogFields').mockReturnValue({
      measurementMode: 'declared-compatible-reference',
      measurementStatus: 'measured',
      modelVisibleProjectionBackstopTokens: 8,
      modelVisibleProjectionCount: 1,
      toolDefinitionCount: 0,
    });
    // A genuine escaping stream error, injected through the harness's own seam.
    // This case previously borrowed the malformed-billed-cost THROW as its
    // vehicle; that throw is gone (a broken telemetry field no longer destroys
    // a completed turn), and borrowing an unrelated validation error made the
    // test hostage to that decision anyway.
    setStreamPartFailure(1, new Error('provider transport exploded'));
    setMockStreamParts([
      { type: 'step-finish', usage: { completionTokens: 1, promptTokens: 7 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 7 } },
    ]);
    const chunks: unknown[] = [];

    try {
      const iterator = await streamMastraAgent(
        [{ id: 'user-1', parts: [{ text: 'use a tool', type: 'text' }], role: 'user' }],
        {
          runtime: {
            apiKey: 'test-key',
            model: 'openai/gpt-5.6-terra',
            provider: 'openrouter',
          },
        }
      );
      await expect(async () => {
        for await (const chunk of iterator) {
          chunks.push(chunk);
        }
      }).rejects.toThrow(/provider transport exploded/i);
      expect(chunks).not.toContainEqual(
        expect.objectContaining({ type: 'token-estimate-calibration' })
      );
    } finally {
      fieldsSpy.mockRestore();
    }
  });

  it('omits token-estimate calibration when token measurement failed', async () => {
    const fieldsSpy = vi.spyOn(RunTokenDiagnostics.prototype, 'toLogFields').mockReturnValue({
      latestStepPromptTokens: 7,
      measurementMode: 'declared-compatible-reference',
      measurementStatus: 'failed',
      modelVisibleProjectionBackstopTokens: 0,
      promptTokensSummedAcrossSteps: 7,
      stepCount: 1,
      toolDefinitionCount: 0,
    });
    setMockStreamParts([
      { type: 'step-finish', usage: { completionTokens: 1, promptTokens: 7 } },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 7 } },
    ]);

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
      const chunks: unknown[] = [];
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }

      expect(chunks).not.toContainEqual(
        expect.objectContaining({ type: 'token-estimate-calibration' })
      );
    } finally {
      fieldsSpy.mockRestore();
    }
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
        contextInputTokens: 107,
        contextOutputTokens: 11,
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
      usage: {
        completionTokens: 11,
        contextInputTokens: 107,
        contextOutputTokens: 11,
        promptTokens: 107,
      },
    });
  });

  it('stops at the next step boundary when steering is requested and marks the run steered', async () => {
    const laterNativeWork = vi.fn(async () => ({}));
    setStreamCompletion(laterNativeWork);
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
    expect(laterNativeWork).not.toHaveBeenCalled();
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
      usage?: {
        completionTokens: number;
        contextInputTokens: number;
        contextOutputTokens: number;
        promptTokens: number;
      };
    };
    expect(finish.type).toBe('message-finish');
    expect(finish.finishReason).toBe('stop');
    // Usage is ACCUMULATED across every completed step (10+40 / 2+5), never
    // just the boundary step's own numbers.
    expect(finish.usage).toEqual({
      completionTokens: 7,
      contextInputTokens: 40,
      contextOutputTokens: 5,
      promptTokens: 50,
    });
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
      { textDelta: 'Working answer', type: 'text-delta' },
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
            providerMetadata: {
              openrouter: {
                provider: 'Together',
                usage: {
                  completionTokensDetails: { reasoningTokens: 3 },
                  cost: 0.003_75,
                },
              },
            },
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
      usage: {
        completionTokens: 7,
        contextInputTokens: 20,
        contextOutputTokens: 5,
        promptTokens: 30,
      },
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'run.step.finished',
          metadata: expect.objectContaining({
            firstTextLatencyMs: expect.any(Number),
            openRouterProvider: 'Together',
            reasoningTokens: 3,
          }),
        }),
        type: 'run-event',
      })
    );
  });

  it('COMPLETES a turn whose earlier step reported no cost, recording it unknown', async () => {
    setMockStreamParts([
      { textDelta: 'costed answer', type: 'text-delta' },
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

    // Mastra copies providerMetadata from the FINAL model step only, so the
    // terminal cost cannot repair the earlier step's missing one. The honest
    // result is UNKNOWN — never the partial sum presented as a total — but the
    // assistant's completed answer survives. Throwing here discarded a finished
    // turn over a billing-telemetry gap.
    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'message-finish') as
      | { billedCostUsd?: number; finishReason?: string }
      | undefined;
    expect(finish?.finishReason).toBe('stop');
    expect(finish?.billedCostUsd).toBeUndefined();
  });

  it('COMPLETES the turn on a malformed cost, recording it unknown', async () => {
    // The last member of this bug class. A malformed cost is a broken provider
    // contract someone should fix, and the callers log it at ERROR so it stays
    // impossible to miss — but binning a finished answer over a telemetry field
    // is the same trade that made a MISSING cost fatal for every anonymous
    // OpenRouter route. Loud, never fatal.
    setMockStreamParts([
      { textDelta: 'answer with a malformed cost', type: 'text-delta' },
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

    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'message-finish') as
      | { billedCostUsd?: number; finishReason?: string }
      | undefined;
    expect(finish?.finishReason).toBe('stop');
    // UNKNOWN, never zero — a fabricated zero is the undercount this path
    // exists to avoid, and the one number a malformed value must not become.
    expect(finish?.billedCostUsd).toBeUndefined();
  });

  it('COMPLETES an OpenRouter turn that never reported a cost at all', async () => {
    setMockStreamParts([
      { textDelta: 'answer with no reported cost', type: 'text-delta' },
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

    // The stealth/anonymous-route shape: OpenRouter reports no usage.cost at
    // all (migration 107's "anonymous Ox Alpha route"). Every such turn used to
    // throw here, so the model's completed answer was thrown away.
    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }
    const finish = chunks.find((chunk) => (chunk as { type?: string }).type === 'message-finish') as
      | { billedCostUsd?: number; finishReason?: string }
      | undefined;
    expect(finish?.finishReason).toBe('stop');
    expect(finish?.billedCostUsd).toBeUndefined();
  });

  it('normalizes OpenRouter provider state before applying stream safeguards', async () => {
    setMockStreamParts([
      { textDelta: 'normalized-provider answer', type: 'text-delta' },
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
      modelSettings: { maxOutputTokens: 32_000 },
    });

    // Normalization is proven by an observable only a NORMALIZED provider can
    // produce: `requiresBilledCost` is set from the normalized provider name,
    // and this finish reports no cost, so the unreported-cost warning fires.
    // (It previously proved the same thing with the throw that used to live
    // there — the subject of this test is the normalization, not the throw.)
    const logRecords: LogRecord[] = [];
    const removeLogListener = addLogListener((record) => logRecords.push(record));
    try {
      for await (const _chunk of iterator) {
        // drain
      }
    } finally {
      removeLogListener();
    }
    expect(
      logRecords.some(
        (record) =>
          record.level === LogLevel.WARN &&
          JSON.stringify(record).includes('provider_billed_cost_unreported')
      )
    ).toBe(true);
  });

  it('surfaces observational-memory FAILURE data chunks as visible run events (BST-940 field failure)', async () => {
    // Mastra 1.51 streams OM bookkeeping as dynamic `data-om-*` chunks. The
    // failure variants carried the ONLY runtime evidence of a broken observer
    // in the field (every cycle dying with a model-version error) yet the
    // mapper dropped them as "unrecognized" — a silent degradation. Failures
    // must surface as run events; non-failure bookkeeping stays silent
    // (Mastra persists it itself) without unrecognized-chunk warn spam.
    setMockStreamParts([
      { payload: { phase: 'buffering' }, type: 'data-om-status' },
      { payload: {}, type: 'data-om-buffering-start' },
      {
        payload: {
          error: 'Unsupported model version. AI SDK 4 only supports v1.',
          operationType: 'observation',
        },
        type: 'data-om-buffering-failed',
      },
      { textDelta: 'observed answer', type: 'text-delta' },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'observe', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const runEvents = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === 'run-event'
    ) as { event: { detail?: string; kind: string; status: string } }[];
    const omFailures = runEvents.filter(
      (chunk) => chunk.event.kind === 'memory.observation.failed'
    );
    expect(omFailures).toHaveLength(1);
    expect(omFailures[0]?.event.status).toBe('failed');
    expect(omFailures[0]?.event.detail).toContain('Unsupported model version');
    // Non-failure OM bookkeeping (data-om-status / data-om-buffering-start)
    // produces NO chunks of any kind: after the leading breakdown the stream
    // is exactly the run lifecycle, the ONE om failure event, and the finish.
    expect(runEvents.map((chunk) => chunk.event.kind)).toEqual([
      'memory.observation.failed',
      'run.finished',
    ]);
    expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual([
      'context-breakdown',
      'run-event',
      'text-delta',
      'run-event',
      'message-finish',
    ]);
  });

  it('drops OM cycle-end markers with unrecognized operationType or malformed counts, loudly not defaulted (review fix)', async () => {
    setMockStreamParts([
      // No operationType → must NOT default into the om-observation bucket.
      {
        payload: { bufferedTokens: 400, tokensBuffered: 8000 },
        type: 'data-om-buffering-end',
      },
      // Malformed count → dropped, never coerced to 0-and-kept.
      {
        payload: {
          observationTokens: Number.NaN,
          operationType: 'observation',
          tokensObserved: 5000,
        },
        type: 'data-om-observation-end',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'observe', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(
      chunks.filter((chunk) => (chunk as { type?: string }).type === 'child-run-usage')
    ).toEqual([]);
  });

  it('captures OM observation/reflection cycle sizes as child-run-usage chunks (BST-953)', async () => {
    // The end markers carry Mastra's LOCAL token estimates for the observer
    // call (`tokensObserved` in / `observationTokens` out; buffering uses
    // `tokensBuffered` / `bufferedTokens`). They were previously dropped with
    // the rest of the non-failure OM bookkeeping — the thread-total meter
    // needs them as estimated child usage. Activation is an instant swap (no
    // LLM call) and must never fabricate usage.
    setMockStreamParts([
      { payload: {}, type: 'data-om-observation-start' },
      {
        payload: {
          durationMs: 1200,
          observationTokens: 900,
          operationType: 'observation',
          tokensObserved: 24_000,
        },
        type: 'data-om-observation-end',
      },
      {
        payload: { bufferedTokens: 400, operationType: 'reflection', tokensBuffered: 8000 },
        type: 'data-om-buffering-end',
      },
      {
        payload: { operationType: 'observation', tokensActivated: 5000 },
        type: 'data-om-activation',
      },
      { finishReason: 'stop', type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } },
    ]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'observe', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );

    const chunks: unknown[] = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const usageChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === 'child-run-usage'
    );
    expect(usageChunks).toEqual([
      {
        type: 'child-run-usage',
        value: {
          estimated: true,
          inputTokens: 24_000,
          outputTokens: 900,
          source: 'om-observation',
        },
      },
      {
        type: 'child-run-usage',
        value: { estimated: true, inputTokens: 8000, outputTokens: 400, source: 'om-reflection' },
      },
    ]);
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
        usage: {
          completionTokens: 6,
          contextInputTokens: 3,
          contextOutputTokens: 4,
          promptTokens: 5,
        },
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

  it.each([false, true])(
    'preserves a typed construction failure when cleanup fails=%s',
    async (cleanupFails) => {
      const original = new MastraAgentError(
        'mastra_agent_missing_api_key',
        'Provider key rejected',
        { context: { provider: 'openai' } }
      );
      const cleanupFailure = new Error('decision settlement failed');
      const finishToolActions = vi.fn(async () => {
        if (cleanupFails) {
          throw cleanupFailure;
        }
      });
      const runtime = await createMastraAgentRuntime({
        conversationBinding: {
          ...createDelegatedConversationBinding(async () => undefined),
          finishToolActions,
        },
        runtime: { apiKey: 'key', provider: 'openai' },
      });
      vi.spyOn(runtime.agent, 'stream').mockRejectedValue(original);
      const operation = createStreamIteratorFromRuntime({
        messages: [{ id: 'user', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
        runtime,
      });
      if (cleanupFails) {
        await expect(operation).rejects.toMatchObject({
          cause: { errors: [original, cleanupFailure], name: 'AggregateError' },
          code: original.code,
          context: original.context,
          message: expect.stringContaining('Runtime cleanup did not complete'),
        });
      } else {
        await expect(operation).rejects.toBe(original);
      }
      expect(finishToolActions).toHaveBeenCalledOnce();
    }
  );

  it.each(['initial', 'approve', 'decline', 'resume'] as const)(
    'preserves construction and all settlement errors on the %s leg',
    async (leg) => {
      const constructionFailure = new Error('native construction failed');
      const shutdownFailure = new Error('shutdown failed');
      const settlementFailure = new Error('decision settlement failed');
      const finishToolActions = vi.fn().mockRejectedValue(settlementFailure);
      const runtime = await createMastraAgentRuntime({
        conversationBinding: {
          ...createDelegatedConversationBinding(async () => undefined),
          finishToolActions,
        },
        runtime: { apiKey: 'key', provider: 'openai' },
        storage: { id: 'storage-with-workflows' } as never,
      });
      const mastra = mastraInstances[0];
      if (!mastra) {
        throw new Error('Expected the runtime Mastra instance');
      }
      vi.spyOn(mastra, 'shutdown').mockRejectedValue(shutdownFailure);
      setSuspendedRuns([
        {
          runId: 'run',
          status: 'suspended',
          suspendedAt: new Date(),
          toolCalls: [
            { args: {}, requiresApproval: leg !== 'resume', toolCallId: 'call', toolName: 'read' },
          ],
        },
      ]);
      vi.spyOn(runtime.agent, 'stream').mockRejectedValue(constructionFailure);
      vi.spyOn(runtime.agent, 'approveToolCall').mockRejectedValue(constructionFailure);
      vi.spyOn(runtime.agent, 'declineToolCall').mockRejectedValue(constructionFailure);
      vi.spyOn(runtime.agent, 'resumeStream').mockRejectedValue(constructionFailure);
      const create = () => {
        if (leg === 'initial') {
          return createStreamIteratorFromRuntime({
            messages: [{ id: 'user', parts: [{ text: 'go', type: 'text' }], role: 'user' }],
            runtime,
          });
        }
        if (leg === 'resume') {
          return createToolResumeIteratorFromRuntime({
            action: { resumeData: {}, runId: 'run', toolCallId: 'call' },
            runtime,
          });
        }
        return createToolApprovalIteratorFromRuntime({
          action: { action: leg, runId: 'run', toolCallId: 'call' },
          runtime,
        });
      };
      await expect(create()).rejects.toMatchObject({
        cause: {
          errors: [
            constructionFailure,
            expect.objectContaining({
              errors: [shutdownFailure, settlementFailure],
              name: 'AggregateError',
            }),
          ],
          name: 'AggregateError',
        },
      });
      expect(finishToolActions).toHaveBeenCalledOnce();
    }
  );

  it('preserves shutdown and delegated decision settlement failures together', async () => {
    const shutdownFailure = new Error('shutdown failed');
    const settlementFailure = new Error('decision settlement failed');
    const finishToolActions = vi.fn().mockRejectedValue(settlementFailure);
    const runtime = await createMastraAgentRuntime({
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        finishToolActions,
      },
      runtime: { apiKey: 'key', provider: 'openai' },
      storage: { id: 'storage-with-workflows' } as never,
    });
    const mastra = mastraInstances[0];
    if (!mastra) {
      throw new Error('Expected the runtime Mastra instance');
    }
    vi.spyOn(mastra, 'shutdown').mockRejectedValue(shutdownFailure);

    await expect(runtime.dispose()).rejects.toMatchObject({
      errors: [shutdownFailure, settlementFailure],
      name: 'AggregateError',
    });
    expect(finishToolActions).toHaveBeenCalledOnce();
  });

  it('passes strict thread/resource memory context to agent.stream', async () => {
    const memory = {
      getMergedThreadConfig: () => ({ generateTitle: false }),
      id: 'memory-instance',
    };
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

  it('uses the documented long-running default step cap for native tool loops', async () => {
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
      maxSteps: 100,
    });
  });

  it('passes configured agent loop limits and input token compaction to agent.stream', async () => {
    const memory = {
      getMergedThreadConfig: () => ({ generateTitle: false }),
      id: 'memory-instance',
    };
    setMockStreamParts([{ type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } }]);

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'inspect the workspace', type: 'text' }], role: 'user' }],
      {
        memory: memory as never,
        runtime: {
          agentLoop: {
            inputTokenLimit: 8192,
            maxSteps: 12,
          },
          apiKey: 'test-key',
          compactionOverlayLookup: { listActiveCompactionRanges: async () => [] },
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
          toolProjectionRewriteLookup: { listActiveRewrites: async () => new Map() },
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
      'tool-call-filter',
      'tool-projection-rewrite',
      'compaction-overlay',
      'provider-history-compat',
      'openai-tool-search-history-compat',
      'openai-duplicate-item-compat',
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
      mcpHost,
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

  it.each([
    { originalToolId: 'search_tools', sanitizedToolId: 'search_tools' },
    { originalToolId: 'search.tools', sanitizedToolId: 'search_tools' },
    { originalToolId: 'load_tool', sanitizedToolId: 'load_tool' },
    { originalToolId: 'load.tool', sanitizedToolId: 'load_tool' },
    { originalToolId: 'list_available_tools', sanitizedToolId: 'list_available_tools' },
    { originalToolId: 'list.available.tools', sanitizedToolId: 'list_available_tools' },
  ])(
    'rejects reserved catalog meta-tool collision for $originalToolId before agent construction',
    async ({ originalToolId, sanitizedToolId }) => {
      await expect(
        createMastraAgentRuntime({
          runtime: { apiKey: 'key', provider: 'openai' },
          tools: {
            'brainstrike.listWorkspaceContext': {
              description: 'List the current workspace context.',
              id: 'brainstrike.listWorkspaceContext',
            },
            [originalToolId]: {
              description: 'Caller-owned tool.',
              id: originalToolId,
            },
          },
        })
      ).rejects.toMatchObject({
        code: 'mastra_agent_tool_name_collision',
        context: {
          originalToolId,
          reservedToolId: sanitizedToolId,
          sanitizedToolId,
        },
      });
      expect(agentInstances).toHaveLength(0);
    }
  );

  it('preserves caller-owned search_tools when no deferred catalog is installed', async () => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        search_tools: {
          description: 'Caller-owned tool.',
          id: 'search_tools',
        },
      },
    });

    expect(Object.keys(agentInstances[0]?.config.tools ?? {})).toEqual(['search_tools']);
    expect(runtime.toolSearchProcessor).toBeUndefined();
  });

  it('rejects a deferred MCP tool whose canonical id collides with search_tools', async () => {
    setMcpToolsets({
      search: {
        tools: { description: 'Caller-owned MCP tool.', id: 'tools' },
      },
    });

    await expect(
      createMastraAgentRuntime({
        mcpHost,
        runtime: { apiKey: 'key', provider: 'openai' },
      })
    ).rejects.toMatchObject({
      code: 'mastra_agent_tool_name_collision',
      context: {
        originalToolId: 'search.tools',
        reservedToolId: 'search_tools',
        sanitizedToolId: 'search_tools',
      },
    });
    expect(agentInstances).toHaveLength(0);
    expect(mcpInstances).toEqual([expect.objectContaining({ closeCalls: 1 })]);
  });

  it('always states the current date in the real assembled instructions', async () => {
    // The guard for the runtime supplying its own clock. Asserting
    // buildCurrentDateNote directly would prove only that it renders a date it
    // was handed; the regression to prevent is a runtime that stops handing it
    // one and silently ships dateless prompts again — the exact behaviour that
    // had a model reason "Today's date is unknown but likely later" and then
    // write a fabricated date into durable memory.
    //
    // Time is FROZEN rather than sampled twice: computing the expected date
    // after createMastraAgentRuntime captured its own `new Date()` would fail
    // with a baffling diff whenever the two straddled midnight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 12));
    try {
      await createMastraAgentRuntime({
        runtime: { apiKey: 'key', provider: 'openai' },
        tools: {
          'brainstrike.readWorkspaceFile': {
            description: 'Read workspace file',
            id: 'brainstrike.readWorkspaceFile',
          },
        },
      });
      expect(agentInstances[0]?.config.instructions ?? '').toContain('2026-08-23');
    } finally {
      vi.useRealTimers();
    }
  });

  it('states the date even when a caller supplies its own instructions', async () => {
    // The structural property, asserted where it is testable. Threading the
    // clock through buildDefaultInstructions left BOTH other supported paths —
    // an instructionsOverride caller and the built-in local model — shipping
    // dateless prompts. Composing the note outside that branch covers all
    // three; an override is the one this harness can construct, and it proves
    // the note is not inside the hosted-default branch.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 12));
    try {
      await createMastraAgentRuntime({
        instructions: 'Bespoke caller instructions with no date of their own.',
        runtime: { apiKey: 'key', provider: 'openai' },
        tools: {
          'brainstrike.readWorkspaceFile': {
            description: 'Read workspace file',
            id: 'brainstrike.readWorkspaceFile',
          },
        },
      });
      const instructions = agentInstances[0]?.config.instructions ?? '';
      expect(instructions).toContain('Bespoke caller instructions');
      expect(instructions).toContain('2026-08-23');
    } finally {
      vi.useRealTimers();
    }
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
    setMcpToolsets({
      filesystem: {
        search_files: {
          description: 'Search files',
          id: 'search_files',
        },
      },
    });

    const runtime = await createMastraAgentRuntime({
      mcpHost,
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

  it('keeps create-capable write guidance critical when plan mode is OFF', async () => {
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
    expect(instructions).toContain('brainstrike_writeWorkspaceFile');
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
    // The factory now materializes the router model itself (strict-content
    // gateway wiring) instead of handing Mastra a bare descriptor.
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.provider).toBe('openrouter');
    // @ts-expect-error - accessing model for testing
    expect(agent.model?.modelId).toBe('openai/gpt-5.6-terra');
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
      modelSettings: { maxOutputTokens: 32_000 },
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
      modelSettings: { maxOutputTokens: 32_000, temperature: 0.2 },
    });
  });

  it('sizes the default OpenRouter output window for the reasoning the request makes (BST-1170)', async () => {
    // Kimi K3's reasoning tokens stream into the output window (OpenRouter:
    // reasoning tokens ARE output tokens), so the 32,000 backstop starved
    // thinking+answer and runs died at `finishReason: length`. With reasoning
    // active the backstop must reserve Moonshot's documented 131,072 window.
    const finishPart = {
      providerMetadata: { openrouter: { usage: { cost: 0 } } },
      type: 'finish',
      usage: { completionTokens: 1, promptTokens: 1 },
    } as const;

    setMockStreamParts([finishPart]);
    const explicitEffortIterator = await streamMastraAgent(
      [{ id: 'u-kimi-high', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          model: 'moonshotai/kimi-k3',
          provider: 'openrouter',
          providerOptions: {
            openrouter: {
              provider: { require_parameters: true },
              reasoning: { effort: 'high' },
            },
          },
        },
      }
    );
    for await (const _chunk of explicitEffortIterator) {
      // drain
    }
    expect(agentInstances[0]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 131_072 },
    });

    setMockStreamParts([finishPart]);
    const reasoningOffIterator = await streamMastraAgent(
      [{ id: 'u-kimi-off', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          model: 'moonshotai/kimi-k3',
          provider: 'openrouter',
          providerOptions: {
            openrouter: {
              provider: { require_parameters: true },
              reasoning: { enabled: false },
            },
          },
        },
      }
    );
    for await (const _chunk of reasoningOffIterator) {
      // drain
    }
    expect(agentInstances[1]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 32_000 },
    });

    setMockStreamParts([finishPart]);
    // No reasoning options on the wire: the provider applies Kimi's own
    // default (thinking on), so the window must still be the vendor window.
    const bareIterator = await streamMastraAgent(
      [{ id: 'u-kimi-bare', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        runtime: {
          apiKey: 'test-key',
          model: 'moonshotai/kimi-k3',
          provider: 'openrouter',
        },
      }
    );
    for await (const _chunk of bareIterator) {
      // drain
    }
    expect(agentInstances[2]?.streamCalls[0]?.options).toMatchObject({
      modelSettings: { maxOutputTokens: 131_072 },
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
  const openAiEnvKeys = ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY'] as const;

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

describe('MCP discovery skip rows (BST-1602)', () => {
  beforeEach(() => {
    resetMastraStreamHarness();
  });

  function configureFailingMcpServer(): void {
    setMcpToolsets({
      broken: { 'remote tool': { description: 'remote', id: 'remote tool' } },
    });
    setMcpDiscoveryFailure('broken', 'Connection closed');
  }

  async function streamOneTurn() {
    return await streamMastraAgent(
      [{ id: 'user-mcp-skip', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      {
        mcpHost,
        runtime: { apiKey: 'key', provider: 'openai' },
        storage: { id: 'storage-with-workflows' } as never,
      }
    );
  }

  it('leads the fresh turn with an always-visible mcp.tools.unavailable row', async () => {
    configureFailingMcpServer();

    const iterator = await streamOneTurn();
    const chunks = [];
    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    const skipRows = chunks.filter(
      (chunk) => (chunk as { event?: { kind?: string } }).event?.kind === 'mcp.tools.unavailable'
    );
    expect(skipRows).toHaveLength(1);
    expect(skipRows[0]).toMatchObject({
      event: {
        detail: 'broken skipped for this request — Connection closed',
        status: 'failed',
      },
    });
  });

  it('still disposes the runtime when the consumer stops ON the skip row', async () => {
    // The BST-1602 regression this guards (PR #2938 review): while the rows
    // were yielded by a WRAPPER around `runTurnAttempts`, a consumer that took
    // a skip row and stopped left the turn generator unstarted, so its
    // `finally` — and `runtime.dispose()` — never ran, while `firstAttempt` was
    // already a live stream. `.return()` on an unstarted generator does not run
    // its body, so the rows have to live INSIDE that generator.
    configureFailingMcpServer();

    const iterator = await streamOneTurn();
    for await (const chunk of iterator) {
      expect((chunk as { event?: { kind?: string } }).event?.kind).toBe('mcp.tools.unavailable');
      break;
    }

    expect(mastraInstances).toHaveLength(1);
    expect(mastraInstances[0]?.shutdownCalls).toBe(1);
  });
});
