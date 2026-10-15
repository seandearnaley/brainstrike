import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, StreamChunk } from '../../types';
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
function scriptedModel(parts: readonly unknown[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
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
