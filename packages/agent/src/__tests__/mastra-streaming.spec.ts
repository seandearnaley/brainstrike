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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { streamMastraAgent } from '../mastra/agent-streaming';
import { MastraAgentError } from '../mastra/mastra-agent-error';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';
import {
  agentInstances,
  expectLeadingContextBreakdown,
  expectMastraAgentError,
  mastraInstances,
  mcpInstances,
  resetMastraStreamHarness,
  setMcpToolsets,
  setMockStreamParts,
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
      modelSettings: { maxOutputTokens: 32_000 },
    });

    const drain = async () => {
      for await (const _chunk of iterator) {
        // drain
      }
    };
    await expect(drain()).rejects.toThrow(/OpenRouter.*billed cost/i);
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
      'tool-call-filter',
      'provider-history-compat',
      'openai-tool-search-history-compat',
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

  it.each([
    { originalToolId: 'search_tools', sanitizedToolId: 'search_tools' },
    { originalToolId: 'search.tools', sanitizedToolId: 'search_tools' },
  ])('rejects reserved catalog meta-tool collision for $originalToolId before agent construction', async ({
    originalToolId,
    sanitizedToolId,
  }) => {
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
        reservedToolId: 'search_tools',
        sanitizedToolId,
      },
    });
    expect(agentInstances).toHaveLength(0);
  });

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

  it.each([
    'load_tool',
    'load.tool',
  ])('preserves caller-owned %s when auto-load catalog discovery is installed', async (originalToolId) => {
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'key', provider: 'openai' },
      tools: {
        'brainstrike.listWorkspaceContext': {
          description: 'List the current workspace context.',
          id: 'brainstrike.listWorkspaceContext',
        },
        [originalToolId]: {
          description: 'Caller-owned load helper.',
          id: originalToolId,
        },
      },
    });

    expect(agentInstances[0]?.config.tools).toHaveProperty('load_tool');
    expect(runtime.toolSearchProcessor).toBeDefined();
  });

  it('rejects a deferred MCP tool whose canonical id collides with search_tools', async () => {
    setMcpToolsets({
      search: {
        tools: { description: 'Caller-owned MCP tool.', id: 'tools' },
      },
    });

    await expect(
      createMastraAgentRuntime({
        mcpConfig: {
          servers: [{ command: 'echo', name: 'search', transport: 'stdio' }],
        },
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
