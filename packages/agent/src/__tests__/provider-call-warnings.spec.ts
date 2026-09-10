/**
 * BST-1701: the provider `warnings` channel is READ.
 *
 * Two halves, both in the UNIT lane (stubbed fetch only, no Mastra loop, no
 * PGlite, no wall clock - the same call the `bedrock-prompt-caching-wire`
 * spec's header makes):
 *
 * 1. The REAL `@ai-sdk/anthropic` adapter, built through the production
 *    `createProvider`, streaming against a keyless HTTP fixture. This is the
 *    fixture-shape half: the capture has to read what the installed adapter
 *    actually emits (`{type:'stream-start', warnings:[...]}` as the first
 *    stream part), not a hand-written idea of it.
 * 2. The sink's own rules - dedupe, bound, unreadable shapes - against the
 *    four warning shapes the provider spec declares.
 */
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { MAX_RUN_EVENT_REASON_CHARS } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderCallWarningSink,
  MAX_PROVIDER_CALL_WARNINGS,
  readProviderCallWarning,
  UNRECOGNIZED_PROVIDER_WARNING_TYPE,
  wrapModelWithCallWarningCapture,
} from '../providers/provider-call-warnings';
import { createProvider } from '../providers/provider-factory';

/** An Anthropic model whose adapter entry declares no sampling-param support. */
const SAMPLING_REJECTING_ANTHROPIC_MODEL = 'claude-opus-5';

const DEFAULT_PROMPT: LanguageModelV2Prompt = [
  { content: [{ text: 'hi', type: 'text' }], role: 'user' },
];

interface StreamingModelLike {
  doStream: (options: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicSseResponse(): Response {
  const events =
    sseEvent('message_start', {
      message: {
        content: [],
        id: 'msg_bst_1701',
        model: SAMPLING_REJECTING_ANTHROPIC_MODEL,
        role: 'assistant',
        stop_reason: null,
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      type: 'message_start',
    }) + sseEvent('message_stop', { type: 'message_stop' });
  return new Response(events, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

async function drainStream(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream as unknown as AsyncIterable<unknown>) {
    parts.push(part);
  }
  return parts;
}

describe('provider call warnings: the real adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures the unsupported sampling params @ai-sdk/anthropic drops on a stream', async () => {
    const sink = createProviderCallWarningSink();
    const model = createProvider(
      'anthropic',
      {
        apiKey: 'fixture-key',
        fetch: (() =>
          Promise.resolve(anthropicSseResponse())) as unknown as typeof globalThis.fetch,
        kind: 'custom_fetch',
      },
      SAMPLING_REJECTING_ANTHROPIC_MODEL
    ) as unknown as StreamingModelLike;

    const observed = wrapModelWithCallWarningCapture(model as object, sink) as StreamingModelLike;
    const { stream } = await observed.doStream({
      prompt: DEFAULT_PROMPT,
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
    });
    const parts = await drainStream(stream);

    // The user set three sampling params; the adapter forwarded none of them
    // (BST-1699's wire spec) and reported each as a dropped feature here.
    expect(
      sink
        .drain()
        .filter((warning) => warning.type === 'unsupported')
        .map((warning) => warning.subject)
        .sort()
    ).toEqual(['temperature', 'topK', 'topP']);
    // The observer is invisible: the adapter's own parts still arrive.
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((part) => (part as { type?: string }).type === 'stream-start')).toBe(true);
  });

  it('leaves a clean call with nothing to report', async () => {
    const sink = createProviderCallWarningSink();
    const model = createProvider(
      'anthropic',
      {
        apiKey: 'fixture-key',
        fetch: (() =>
          Promise.resolve(anthropicSseResponse())) as unknown as typeof globalThis.fetch,
        kind: 'custom_fetch',
      },
      SAMPLING_REJECTING_ANTHROPIC_MODEL
    ) as unknown as StreamingModelLike;

    const observed = wrapModelWithCallWarningCapture(model as object, sink) as StreamingModelLike;
    const { stream } = await observed.doStream({ prompt: DEFAULT_PROMPT });
    await drainStream(stream);

    expect(sink.drain()).toEqual([]);
  });
});

describe('provider call warnings: reading the channel', () => {
  it.each([
    [
      { details: 'not supported by claude-opus-5', feature: 'temperature', type: 'unsupported' },
      { detail: 'not supported by claude-opus-5', subject: 'temperature', type: 'unsupported' },
    ],
    [
      { details: 'emulated with a system message', feature: 'toolChoice', type: 'compatibility' },
      { detail: 'emulated with a system message', subject: 'toolChoice', type: 'compatibility' },
    ],
    [
      { message: 'use maxOutputTokens instead', setting: 'maxTokens', type: 'deprecated' },
      { detail: 'use maxOutputTokens instead', subject: 'maxTokens', type: 'deprecated' },
    ],
    [
      { message: 'the request was truncated by the gateway', type: 'other' },
      { detail: 'the request was truncated by the gateway', type: 'other' },
    ],
    // A type this build has never seen still reads, because the fields are
    // read by NAME. This is the whole-channel consumer, not an
    // `unsupported`-only patch.
    [
      { details: 'reduced to 4', feature: 'parallelToolCalls', type: 'clamped' },
      { detail: 'reduced to 4', subject: 'parallelToolCalls', type: 'clamped' },
    ],
  ])('normalizes %j', (raw, expected) => {
    expect(readProviderCallWarning(raw)).toEqual(expected);
  });

  it.each([[null], [42], [[]]])(
    'records an unreadable entry (%j) rather than dropping it',
    (raw) => {
      expect(readProviderCallWarning(raw)).toEqual({
        type: UNRECOGNIZED_PROVIDER_WARNING_TYPE,
      });
    }
  );

  it('preserves the explanation in a string-shaped warning', () => {
    expect(readProviderCallWarning('temperature ignored')).toEqual({
      detail: 'temperature ignored',
      type: UNRECOGNIZED_PROVIDER_WARNING_TYPE,
    });
  });

  it('bounds every retained provider-controlled field before deduplication', () => {
    const sink = createProviderCallWarningSink();
    sink.record([{ details: 'd'.repeat(5000), feature: 'f'.repeat(5000), type: 't'.repeat(5000) }]);
    const [warning] = sink.drain();
    expect(warning).toBeDefined();
    for (const value of Object.values(warning ?? {})) {
      expect(Array.from(value)).toHaveLength(MAX_RUN_EVENT_REASON_CHARS);
      expect(value.endsWith('…')).toBe(true);
    }
  });

  it('reports one distinct warning once, however many steps repeat it', () => {
    const sink = createProviderCallWarningSink();
    const warnings = [{ feature: 'temperature', type: 'unsupported' }];
    sink.record(warnings);
    sink.record(warnings);
    expect(sink.drain()).toEqual([{ subject: 'temperature', type: 'unsupported' }]);
    // Already reported: a later step must not re-raise the same row.
    sink.record(warnings);
    expect(sink.drain()).toEqual([]);
  });

  it('keeps genuinely different warnings from the same call', () => {
    const sink = createProviderCallWarningSink();
    sink.record([
      { feature: 'temperature', type: 'unsupported' },
      { feature: 'topP', type: 'unsupported' },
      { message: 'gateway note', type: 'other' },
    ]);
    expect(sink.drain()).toHaveLength(3);
  });

  it.each([[undefined], [null], ['warnings'], [{ length: 1 }]])(
    'ignores a non-array report (%j)',
    (value) => {
      const sink = createProviderCallWarningSink();
      sink.record(value);
      expect(sink.drain()).toEqual([]);
    }
  );

  it('bounds how many distinct warnings one run retains', () => {
    const sink = createProviderCallWarningSink();
    sink.record(
      Array.from({ length: MAX_PROVIDER_CALL_WARNINGS + 5 }, (_unused, index) => ({
        message: `warning ${index}`,
        type: 'other',
      }))
    );
    expect(sink.drain()).toHaveLength(MAX_PROVIDER_CALL_WARNINGS);
  });
});

describe('provider call warnings: the observer is not a transform', () => {
  it('forwards call arguments and stream chunks untouched', async () => {
    const sink = createProviderCallWarningSink();
    const seen: unknown[] = [];
    const chunks = [
      { type: 'stream-start', warnings: [{ feature: 'topP', type: 'unsupported' }] },
      { id: 'a', type: 'text-start' },
      { delta: 'hello', id: 'a', type: 'text-delta' },
    ];
    const model = {
      doStream: (options: unknown) => {
        seen.push(options);
        return Promise.resolve({
          stream: new ReadableStream<unknown>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
        });
      },
      modelId: 'fake-model',
      provider: 'fake',
      specificationVersion: 'v4',
    };

    const observed = wrapModelWithCallWarningCapture(model, sink);
    const options = { prompt: DEFAULT_PROMPT, temperature: 0.7 };
    const { stream } = await observed.doStream(options);

    expect(seen).toEqual([options]);
    expect(await drainStream(stream)).toEqual(chunks);
    expect(sink.drain()).toEqual([{ subject: 'topP', type: 'unsupported' }]);
    // Non-call properties keep delegating.
    expect(observed.modelId).toBe('fake-model');
    expect(observed.specificationVersion).toBe('v4');
  });

  it('survives a model whose getters read #private state', async () => {
    // Mastra's `ModelRouterLanguageModel` and the AI SDK wrapper classes keep
    // their state in `#private` fields. Reading a prototype getter through the
    // proxy with the PROXY as receiver throws `TypeError: Cannot read private
    // member`, and this wrapper is applied to every model the factory returns.
    class PrivateStateModel {
      readonly #modelId = 'private-model';
      get modelId(): string {
        return this.#modelId;
      }
      doStream() {
        return Promise.resolve({
          stream: new ReadableStream<unknown>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.close();
            },
          }),
        });
      }
    }

    const sink = createProviderCallWarningSink();
    const observed = wrapModelWithCallWarningCapture(new PrivateStateModel(), sink);

    expect(observed.modelId).toBe('private-model');
    const { stream } = await observed.doStream();
    expect(await drainStream(stream)).toHaveLength(1);
  });

  it('reads the warnings a doGenerate result reports on itself', async () => {
    const sink = createProviderCallWarningSink();
    const model = {
      doGenerate: () =>
        Promise.resolve({
          content: [],
          warnings: [{ feature: 'seed', type: 'unsupported' }],
        }),
    };

    await wrapModelWithCallWarningCapture(model, sink).doGenerate();

    expect(sink.drain()).toEqual([{ subject: 'seed', type: 'unsupported' }]);
  });

  it('propagates a failing call rather than swallowing it', async () => {
    const sink = createProviderCallWarningSink();
    const model = { doStream: () => Promise.reject(new Error('provider exploded')) };
    await expect(wrapModelWithCallWarningCapture(model, sink).doStream()).rejects.toThrow(
      'provider exploded'
    );
  });

  it('propagates a stream error after the chunks that preceded it', async () => {
    const sink = createProviderCallWarningSink();
    const model = {
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<unknown>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.error(new Error('transport died'));
            },
          }),
        }),
    };
    const { stream } = await wrapModelWithCallWarningCapture(model, sink).doStream();
    await expect(drainStream(stream)).rejects.toThrow('transport died');
  });
});
