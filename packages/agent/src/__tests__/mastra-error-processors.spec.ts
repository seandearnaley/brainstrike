/**
 * End-to-end coverage for the Mastra ERROR-PROCESSOR layer wired into the REAL
 * agent loop (LIVE-LOOP MANDATE — this touches the agent loop; mocked stream
 * parts are not sufficient, see docs/agents/assistant-runtime.md ASSISTANT RESILIENCE).
 *
 * Like mastra-tool-execution.spec.ts this does NOT mock the Mastra agent loop.
 * It substitutes only model construction with a scripted fake so no
 * network/provider key is needed, and wraps `Agent` in a TRANSPARENT recording
 * subclass (it still calls `super`, so the real Mastra Agent + real loop run) to
 * capture the constructor config + per-call stream options. This proves:
 *  (a) a transient mid-stream error (ECONNRESET) is retried and the run completes,
 *  (b) a reloaded-thread assistant-prefill rejection recovers,
 *  (c) the per-call TokenLimiter STILL trims history with the processors present
 *      (the clobber-guard regression) and ProviderHistoryCompat rides the SAME
 *      per-call input array (placement resolution),
 *  (d) `maxProcessorRetries` is the pinned value (3), not Mastra's default 10,
 *  (e) a persistently-failing retryable error is BOUNDED then terminal (no
 *      infinite loop; the watchdog/UI still see a real failure).
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import type {
  AgentConfig,
  AgentExecutionOptionsBase,
  Agent as MastraAgent,
} from '@mastra/core/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../types';

const { modelHolder, agentConfigs, streamOptionsLog } = vi.hoisted(() => ({
  agentConfigs: [] as Record<string, unknown>[],
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
  streamOptionsLog: [] as unknown[],
}));

vi.mock('../providers/provider-factory', async (importActual) => {
  const actual = await importActual<typeof import('../providers/provider-factory')>();
  return {
    ...actual,
    createProvider: () => {
      if (!modelHolder.current) {
        throw new Error('test fake model was not configured');
      }
      return modelHolder.current;
    },
    getDefaultModel: () => 'fake-model',
  };
});

// Transparent recording subclass: super() runs the REAL Mastra Agent, so the
// real loop / real processors execute. We only observe the config + stream args.
// Typing constraint: `extends actual.Agent` instantiates the Agent generics
// with their DEFAULTS (TOutput = undefined), while ConstructorParameters /
// InstanceType inference resolves them to `unknown` — so only bare
// `AgentConfig` / `MastraAgent` references match what super() expects. And
// because `stream` is overloaded, no single method signature satisfies every
// overload; a field typed as the base member type is the one override-safe shape.
vi.mock('@mastra/core/agent', async (importActual) => {
  const actual = await importActual<typeof import('@mastra/core/agent')>();
  class RecordingAgent extends actual.Agent {
    constructor(config: AgentConfig) {
      super(config);
      agentConfigs.push(config as Record<string, unknown>);
    }
    // The trailing `as MastraAgent['stream']` cast is load-bearing: it bridges
    // the single-signature arrow back to the base's overload set.
    override stream: MastraAgent['stream'] = ((
      messages: Parameters<MastraAgent['stream']>[0],
      options?: AgentExecutionOptionsBase<unknown> & { structuredOutput?: never }
    ) => {
      streamOptionsLog.push(options);
      return options === undefined ? super.stream(messages) : super.stream(messages, options);
    }) as MastraAgent['stream'];
  }
  return { ...actual, Agent: RecordingAgent };
});

const { streamMastraAgent } = await import('../mastra/agent-runtime');
const { ASSISTANT_MAX_PROCESSOR_RETRIES } = await import('../mastra/error-processors');

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

const enqueue = (parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> =>
  new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });

const successParts = (text: string): LanguageModelV2StreamPart[] => {
  const id = 'text-final';
  return [
    { type: 'stream-start', warnings: [] },
    { id, type: 'text-start' },
    { delta: text, id, type: 'text-delta' },
    { id, type: 'text-end' },
    { finishReason: 'stop', type: 'finish', usage: USAGE },
  ];
};

const errorParts = (error: unknown): LanguageModelV2StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { error, type: 'error' },
];

/**
 * A scripted model that runs a queue of per-attempt behaviors: each `doStream`
 * call shifts the next behavior. `finalText` is emitted once the queue is
 * exhausted (or when a behavior says `success`). Captures every outbound prompt.
 */
function createScriptedModel(args: {
  attempts: Array<{ kind: 'error'; error: unknown } | { kind: 'success' }>;
  finalText: string;
  onPrompt?: (prompt: LanguageModelV2CallOptions['prompt']) => void;
}): LanguageModelV2 & { calls: number } {
  const model = {
    calls: 0,
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      model.calls += 1;
      args.onPrompt?.(options.prompt);
      const behavior = args.attempts.shift();
      if (behavior && behavior.kind === 'error') {
        return Promise.resolve({ stream: enqueue(errorParts(behavior.error)) });
      }
      return Promise.resolve({ stream: enqueue(successParts(args.finalText)) });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2' as const,
    supportedUrls: {},
  };
  return model as unknown as LanguageModelV2 & { calls: number };
}

async function drain(iterator: AsyncIterable<StreamChunk>): Promise<{
  text: string;
  runEventKinds: string[];
  messageFinishReasons: string[];
}> {
  const runEventKinds: string[] = [];
  const messageFinishReasons: string[] = [];
  let text = '';
  for await (const chunk of iterator) {
    if (chunk.type === 'run-event') {
      runEventKinds.push(chunk.event.kind);
    } else if (chunk.type === 'text-delta') {
      text += chunk.value;
    } else if (chunk.type === 'message-finish') {
      messageFinishReasons.push(chunk.finishReason);
    }
  }
  return { messageFinishReasons, runEventKinds, text };
}

describe('mastra error processors (real @mastra/core/agent loop)', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
    agentConfigs.length = 0;
    streamOptionsLog.length = 0;
  });

  it('retries a transient ECONNRESET mid-stream error and completes the run', async () => {
    const econnreset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const model = createScriptedModel({
      attempts: [{ error: econnreset, kind: 'error' }],
      finalText: 'recovered after reset',
    });
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const { text } = await drain(iterator);

    // One failed attempt + one retry that succeeds = two model calls.
    expect(model.calls).toBe(2);
    expect(text).toContain('recovered after reset');
  });

  it('recovers a reloaded-thread assistant-prefill rejection', async () => {
    // The REAL Mastra PrefillErrorHandler pattern (confirmed against the compiled
    // processor) requires "does not support assistant message prefill" — NOT the
    // looser phrasing the reference doc's prose implies.
    const prefillError = new Error('This request does not support assistant message prefill.');
    const model = createScriptedModel({
      attempts: [{ error: prefillError, kind: 'error' }],
      finalText: 'continued past prefill',
    });
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [
        { id: 'u1', parts: [{ text: 'summarize', type: 'text' }], role: 'user' },
        { id: 'a1', parts: [{ text: 'Earlier answer.', type: 'text' }], role: 'assistant' },
        { id: 'u2', parts: [{ text: 'continue', type: 'text' }], role: 'user' },
      ],
      { runtime: { apiKey: 'test-key', provider: 'anthropic' } }
    );
    const { text } = await drain(iterator);

    expect(model.calls).toBe(2);
    expect(text).toContain('continued past prefill');
  });

  it('still trims history via the per-call TokenLimiter with processors installed', async () => {
    const seenNonSystemCounts: number[] = [];
    const model = createScriptedModel({
      attempts: [{ kind: 'success' }],
      finalText: 'ok',
      onPrompt: (prompt) => {
        seenNonSystemCounts.push(
          Array.isArray(prompt) ? prompt.filter((message) => message.role !== 'system').length : 0
        );
      },
    });
    modelHolder.current = model;

    // A large history far past the budget. A tiny instructions override keeps the
    // system prompt well under the limit so TokenLimiter trims OLD HISTORY (the
    // regression target) rather than tripwiring on system-only overflow.
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: `m${index}`,
      parts: [
        {
          text: `Message ${index}: several words of filler content used to consume input token budget across the conversation history for this trimming assertion.`,
          type: 'text' as const,
        },
      ],
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'assistant' | 'user',
    }));

    const iterator = await streamMastraAgent(history, {
      instructions: 'You are a concise test assistant.',
      runtime: {
        agentLoop: { inputTokenLimit: 500 },
        apiKey: 'test-key',
        provider: 'openai',
      },
    });
    await drain(iterator);

    // The model WAS called, and the outbound history was trimmed below the 40
    // seeded messages — proof the TokenLimiter still runs with ProviderHistoryCompat
    // composed into the same per-call input array.
    expect(seenNonSystemCounts[0]).toBeGreaterThan(0);
    expect(seenNonSystemCounts[0]).toBeLessThan(40);

    // ProviderHistoryCompat rides the SAME per-call inputProcessors array as the
    // TokenLimiter (placement resolution — no clobber).
    const streamOptions = streamOptionsLog[0] as
      | { inputProcessors?: Array<{ id: string }> }
      | undefined;
    const inputProcessorIds =
      streamOptions?.inputProcessors?.map((processor) => processor.id) ?? [];
    expect(inputProcessorIds).toContain('token-limiter');
    expect(inputProcessorIds).toContain('provider-history-compat');
  });

  it('pins maxProcessorRetries to the bounded value (not the Mastra default 10) and installs the three-processor stack', async () => {
    modelHolder.current = createScriptedModel({ attempts: [{ kind: 'success' }], finalText: 'ok' });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    await drain(iterator);

    const config = agentConfigs[0] as {
      maxProcessorRetries?: number;
      errorProcessors?: Array<{ id: string }>;
    };
    expect(config.maxProcessorRetries).toBe(ASSISTANT_MAX_PROCESSOR_RETRIES);
    expect(config.maxProcessorRetries).not.toBe(10);
    expect(config.errorProcessors?.map((processor) => processor.id)).toEqual([
      'stream-error-retry-processor',
      'prefill-error-handler',
      'provider-history-compat',
    ]);
  });

  it('omits the error stack for the built-in local provider', async () => {
    modelHolder.current = createScriptedModel({ attempts: [{ kind: 'success' }], finalText: 'ok' });

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'hi', type: 'text' }], role: 'user' }],
      { runtime: { provider: 'local' } }
    );
    await drain(iterator);

    const config = agentConfigs[0] as {
      maxProcessorRetries?: number;
      errorProcessors?: unknown;
    };
    expect(config.errorProcessors).toBeUndefined();
    expect(config.maxProcessorRetries).toBeUndefined();
  });

  it('bounds a persistently-failing retryable stream and terminates (no infinite loop)', async () => {
    const econnreset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    // Enough error attempts to exceed any bounded retry budget.
    const model = createScriptedModel({
      attempts: Array.from({ length: 20 }, () => ({ error: econnreset, kind: 'error' as const })),
      finalText: 'never reached',
    });
    modelHolder.current = model;

    const iterator = await streamMastraAgent(
      [{ id: 'u1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const { text } = await drain(iterator);

    // Bounded: nowhere near the Mastra default of 10 retries (would be 11 calls).
    expect(model.calls).toBeGreaterThan(1);
    expect(model.calls).toBeLessThanOrEqual(1 + ASSISTANT_MAX_PROCESSOR_RETRIES);
    // Terminal, not a silent recovery.
    expect(text).not.toContain('never reached');
  });
});
