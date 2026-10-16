import {
  MODEL_STEP_DATA_NAME,
  MODEL_STREAM_PART_DATA_NAME,
} from '@brainstrike/assistant-contract/model-step';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, StreamChunk } from '../../types';
import { createStatelessAssistantDataStreamResponse } from '../data-stream';
import { streamHostedWebTurn } from '../hosted-web-turn';

// The v4 provider usage DTO, as the host's own model fixtures declare it.
const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 11, total: 11 },
  outputTokens: { reasoning: 0, text: 7, total: 7 },
} as const;

function userMessage(text: string): AgentMessage {
  return { id: 'm1', parts: [{ text, type: 'text' }], role: 'user' };
}

/** A model that streams `parts` verbatim, recording what the SDK sent it. */
function scriptedModel(
  parts: readonly unknown[],
  headers?: Record<string, string>
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      ...(headers ? { response: { headers } } : {}),
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: parts as never,
        initialDelayInMs: null,
      }),
    }),
  });
}

function textStream(deltas: readonly string[], finishReason = 'stop'): readonly unknown[] {
  return [
    { type: 'stream-start', warnings: [] },
    { id: 't1', type: 'text-start' },
    ...deltas.map((delta) => ({ delta, id: 't1', type: 'text-delta' })),
    { id: 't1', type: 'text-end' },
    { finishReason: { raw: finishReason, unified: finishReason }, type: 'finish', usage: USAGE },
  ];
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('a turn that records its steps (BST-1940)', () => {
  it('returns its completed step before the finish, as the host commits it as model.step', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['Hel', 'lo'])),
        recordSteps: true,
      })
    );

    const reduced = chunks.filter((chunk) => chunk.type !== 'model-stream-part');
    expect(reduced.map((chunk) => chunk.type)).toEqual([
      'text-delta',
      'text-delta',
      'model-step',
      'message-finish',
    ]);
    expect(reduced[2]).toEqual({
      messages: [{ content: [{ text: 'Hello', type: 'text' }], role: 'assistant' }],
      model: { modelId: 'mock-model-id', provider: 'mock-provider' },
      stepNumber: 0,
      type: 'model-step',
      usage: expect.objectContaining({ inputTokens: 11, outputTokens: 7 }),
    });
  });

  it("returns each stream part as it arrives, as the host's run loop consumes it, without the provider's headers", async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['Hel', 'lo']), { 'x-provider-account': 'acme' }),
        recordSteps: true,
      })
    );
    const parts = chunks.flatMap((chunk) =>
      chunk.type === 'model-stream-part' ? [chunk.part] : []
    );

    expect(parts.map((part) => part.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
    expect(parts[3]).toEqual({ id: 't1', text: 'Hel', type: 'text-delta' });
    // Each text part arrives before the turn's own text chunk for it: live, not at the step's end.
    expect(chunks.map((chunk) => chunk.type).slice(3, 7)).toEqual([
      'model-stream-part',
      'text-delta',
      'model-stream-part',
      'text-delta',
    ]);
    // The completed step comes ahead of its finish-step part, as the host commits them.
    // (The SDK can complete a step while its text parts are still queued; that text is telemetry.)
    const order = chunks.map((chunk) =>
      chunk.type === 'model-stream-part' ? `part:${chunk.part.type}` : chunk.type
    );
    expect(order.indexOf('model-step')).toBeGreaterThan(order.indexOf('part:start-step'));
    expect(order.indexOf('model-step')).toBeLessThan(order.indexOf('part:finish-step'));
    const finishStep = parts.find((part) => part.type === 'finish-step');
    expect(finishStep).toMatchObject({
      finishReason: 'stop',
      response: { modelId: 'mock-model-id' },
    });
    expect(finishStep?.['response']).not.toHaveProperty('headers');
    expect(JSON.stringify(parts)).not.toContain('acme');
  });

  it('returns no step and no stream part to a client that keeps its own transcript', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['hi'])),
      })
    );

    expect(
      chunks.some((chunk) => chunk.type === 'model-step' || chunk.type === 'model-stream-part')
    ).toBe(false);
  });

  it('carries each stream part on the wire as an out-of-band data frame, between the text it streams', async () => {
    const response = createStatelessAssistantDataStreamResponse(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['Hel', 'lo'])),
        recordSteps: true,
      }),
      { messageId: 'recorded', sessionId: 'recorded' }
    );
    const lines = (await response.text()).split('\n').filter((line) => line.length > 0);
    const frames = lines.map((line) => {
      const separator = line.indexOf(':');
      return { code: line.slice(0, separator), value: JSON.parse(line.slice(separator + 1)) };
    });
    const partFrame = (text: string) =>
      frames.findIndex(
        (frame) =>
          frame.code === '2' &&
          (frame.value as { data: { text?: string }; name: string }[])[0]?.name ===
            MODEL_STREAM_PART_DATA_NAME &&
          (frame.value as { data: { text?: string } }[])[0]?.data.text === text
      );
    const textFrame = (text: string) =>
      frames.findIndex((frame) => frame.code === '0' && frame.value === text);

    expect(partFrame('Hel')).toBeGreaterThan(-1);
    // Live while the text is open, not deferred to its end: each part precedes its text frame.
    expect(partFrame('Hel')).toBeLessThan(textFrame('Hel'));
    expect(partFrame('lo')).toBeGreaterThan(textFrame('Hel'));
    expect(partFrame('lo')).toBeLessThan(textFrame('lo'));
    // The text itself is not sliced by the parts.
    expect(frames.filter((frame) => frame.code === '0').map((frame) => frame.value)).toEqual([
      'Hel',
      'lo',
    ]);
  });

  it('carries the step on the wire as an out-of-band data frame, ahead of its finish-step part', async () => {
    const response = createStatelessAssistantDataStreamResponse(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['hi'])),
        recordSteps: true,
      }),
      { messageId: 'recorded', sessionId: 'recorded' }
    );
    const lines = (await response.text()).split('\n').filter((line) => line.length > 0);
    const step = lines.findIndex((line) => line.includes(MODEL_STEP_DATA_NAME));
    const finishStep = lines.findIndex(
      (line) => line.includes(MODEL_STREAM_PART_DATA_NAME) && line.includes('"type":"finish-step"')
    );

    expect(step).toBeGreaterThan(-1);
    // As the host commits them: the step before its finish-step part.
    expect(step).toBeLessThan(finishStep);
    const [code, ...value] = (lines[step] ?? '').split(':');
    expect(code).toBe('2');
    expect(JSON.parse(value.join(':'))).toMatchObject([
      {
        data: {
          messages: [{ content: [{ text: 'hi', type: 'text' }], role: 'assistant' }],
          stepNumber: 0,
        },
        name: MODEL_STEP_DATA_NAME,
      },
    ]);
  });
});

describe('streamHostedWebTurn', () => {
  it('emits the model text as text-delta chunks in order', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['Hel', 'lo ', 'there'])),
      })
    );

    expect(
      chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.value)
    ).toEqual(['Hel', 'lo ', 'there']);
  });

  it('terminates the stream with a message-finish carrying the provider reason and usage', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['hi'])),
      })
    );

    // The DataStreamMapper treats a stream that ends without a finish as a
    // failed run (finalizeOnStreamEnd -> MISSING_FINISH_ERROR_TEXT), so the
    // terminal chunk is load-bearing, not cosmetic.
    expect(chunks.at(-1)).toEqual({
      finishReason: 'stop',
      path: [],
      type: 'message-finish',
      usage: {
        completionTokens: 7,
        contextInputTokens: 11,
        contextOutputTokens: 7,
        promptTokens: 11,
      },
    });
  });

  it('preserves a non-stop finish reason the provider reported', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['cut'], 'length')),
      })
    );

    expect((chunks.at(-1) as { finishReason?: string }).finishReason).toBe('length');
  });

  it('emits reasoning as reasoning-delta chunks', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel([
          { type: 'stream-start', warnings: [] },
          { id: 'r1', type: 'reasoning-start' },
          { delta: 'thinking', id: 'r1', type: 'reasoning-delta' },
          { id: 'r1', type: 'reasoning-end' },
          { id: 't1', type: 'text-start' },
          { delta: 'answer', id: 't1', type: 'text-delta' },
          { id: 't1', type: 'text-end' },
          { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage: USAGE },
        ]),
      })
    );

    expect(
      chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.value)
    ).toEqual(['thinking']);
  });

  it('sends the conversation to the provider with no tools', async () => {
    let sent: Record<string, unknown> | undefined;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        sent = options as unknown as Record<string, unknown>;
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: null,
            chunks: textStream(['ok']) as never,
            initialDelayInMs: null,
          }),
        };
      },
    });

    await collect(await streamHostedWebTurn({ messages: [userMessage('hello')], model }));

    // Hosted Web has an empty tool registry by contract; a tool reaching the
    // provider here would mean the allow-list stopped being the boundary.
    expect(sent?.['tools']).toBeUndefined();
  });

  it('carries Anthropic prompt-cache tokens through to the finish chunk', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel([
          { type: 'stream-start', warnings: [] },
          { id: 't1', type: 'text-start' },
          { delta: 'hi', id: 't1', type: 'text-delta' },
          { id: 't1', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 90, cacheWrite: 10, noCache: 5, total: 105 },
              outputTokens: { reasoning: 0, text: 7, total: 7 },
            },
          },
        ]),
      })
    );

    // BST-587 prompt caching is active on hosted Anthropic, and the shared UI
    // runtime bills cache reads and writes at different rates.
    expect(chunks.at(-1)).toMatchObject({
      usage: { cacheCreationInputTokens: 10, cacheReadInputTokens: 90 },
    });
  });

  it('reports context occupancy for the single step web runs', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['hi'])),
      })
    );

    // packages/assistant-ui reads these to draw context occupancy; a web turn
    // is one provider step, so the step sizes are the run totals.
    expect(chunks.at(-1)).toMatchObject({
      usage: { contextInputTokens: 11, contextOutputTokens: 7 },
    });
  });

  it('sends a system message as provider system content', async () => {
    let sent: { prompt?: unknown } | undefined;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        sent = options as unknown as { prompt?: unknown };
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: null,
            chunks: textStream(['ok']) as never,
            initialDelayInMs: null,
          }),
        };
      },
    });

    // Web injects its workspace root manifest as a leading system message
    // (injectWorkspaceRootManifestContext), so this is the shipped shape.
    await collect(
      await streamHostedWebTurn({
        messages: [
          { id: 's1', parts: [{ text: 'workspace manifest', type: 'text' }], role: 'system' },
          userMessage('hello'),
        ],
        model,
      })
    );

    const prompt = sent?.prompt as { content: unknown; role: string }[];
    // The hosted defaults and the date note precede it; the manifest is the
    // request's own system preamble and must survive in the same system block.
    expect(prompt[0]?.role).toBe('system');
    expect(String(prompt[0]?.content)).toContain('workspace manifest');
    expect(prompt[1]).toEqual({ content: [{ text: 'hello', type: 'text' }], role: 'user' });
  });

  it('refuses a system message that is not part of the leading block', async () => {
    // AI SDK 7 takes system content only via `instructions`, which is
    // positionless. Hoisting a mid-conversation system message would quietly
    // move it ahead of the turns it was written to follow, so refuse it.
    await expect(
      streamHostedWebTurn({
        messages: [
          userMessage('hello'),
          { id: 's1', parts: [{ text: 'new rules', type: 'text' }], role: 'system' },
        ],
        model: scriptedModel(textStream(['ok'])),
      })
    ).rejects.toThrow('system message');
  });

  it('sends the hosted default instructions and the current date', async () => {
    let sent: { prompt?: unknown } | undefined;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        sent = options as unknown as { prompt?: unknown };
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: null,
            chunks: textStream(['ok']) as never,
            initialDelayInMs: null,
          }),
        };
      },
    });

    // Parity: the retired path composed buildDefaultInstructions +
    // buildCurrentDateNote on EVERY hosted turn (agent-runtime.ts:495, :511).
    // Without them the model loses its behaviour rules and its date.
    await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model,
        now: new Date('2026-10-15T12:00:00'),
      })
    );

    const composed = sent?.prompt as { content: unknown }[] | undefined;
    const system = composed?.[0]?.content;
    expect(String(system)).toContain('Answer concisely.');
    expect(String(system)).toContain('Today is 2026-10-15');
  });

  it('sends a user image attachment the provider can see', async () => {
    let sent: { prompt?: unknown } | undefined;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        sent = options as unknown as { prompt?: unknown };
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: null,
            chunks: textStream(['ok']) as never,
            initialDelayInMs: null,
          }),
        };
      },
    });

    await collect(
      await streamHostedWebTurn({
        messages: [
          {
            id: 'm1',
            parts: [
              { text: 'what is this?', type: 'text' },
              { data: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', type: 'file' },
            ],
            role: 'user',
          },
        ],
        model,
      })
    );

    // We send the canonical AI SDK ImagePart, as the retired path did
    // (agent-runtime.ts:440). AI SDK 7 normalizes ImagePart and FilePart to
    // the SAME provider-level file part — verified by building both and
    // comparing the provider prompt — so this asserts the normalized shape the
    // provider actually receives, which is what vision depends on.
    const prompt = sent?.prompt as { content: unknown[] }[] | undefined;
    const content = prompt?.at(-1)?.content;
    expect(content?.at(-1)).toMatchObject({ mediaType: 'image/png', type: 'file' });
  });

  it('forwards the OpenRouter provider-reported billed cost', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel([
          { type: 'stream-start', warnings: [] },
          { id: 't1', type: 'text-start' },
          { delta: 'hi', id: 't1', type: 'text-delta' },
          { id: 't1', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            providerMetadata: { openrouter: { usage: { cost: 0.0042 } } },
            type: 'finish',
            usage: USAGE,
          },
        ]),
      })
    );

    // OpenRouter's exact charge is the whole reason web keeps the Mastra model
    // router; dropping it would silently fall back to catalog estimates.
    expect(chunks.at(-1)).toMatchObject({ billedCostUsd: 0.0042 });
  });

  it('omits billedCostUsd when the provider reported no cost', async () => {
    const chunks = await collect(
      await streamHostedWebTurn({
        messages: [userMessage('hello')],
        model: scriptedModel(textStream(['hi'])),
      })
    );

    // absent and malformed both mean "cost unknown", and unknown is expressed
    // by omitting the field rather than by reporting zero.
    expect(chunks.at(-1)).not.toHaveProperty('billedCostUsd');
  });

  it('surfaces a provider error instead of ending the stream quietly', async () => {
    const stream = await streamHostedWebTurn({
      messages: [userMessage('hello')],
      model: scriptedModel([
        { type: 'stream-start', warnings: [] },
        { error: new Error('provider exploded'), type: 'error' },
      ]),
    });

    await expect(collect(stream)).rejects.toThrow('provider exploded');
  });
});
