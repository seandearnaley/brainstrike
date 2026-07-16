/**
 * Image-attachment input through the REAL Mastra agent loop (LIVE-LOOP
 * MANDATE — this touches the agent loop; mocked stream parts are not
 * sufficient, see docs/agents/assistant-runtime.md ASSISTANT RESILIENCE).
 *
 * Mirrors the mastra-error-processors harness: only model construction is
 * substituted with a scripted fake that CAPTURES the outbound prompt, so the
 * real @mastra/core Agent + loop run. Proves:
 *  (a) convertMessagesToMastra emits an AI-SDK content ARRAY (text + image
 *      part) for a message carrying an image file part, and keeps the exact
 *      legacy string content for text-only messages (prompt stability),
 *  (b) end to end, an image attachment REACHES THE MODEL as a file part with
 *      its media type — not as flattened text, not dropped.
 */
import { ReadableStream } from 'node:stream/web';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as LanguageModelV2 | undefined },
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

const { convertMessagesToMastra, streamMastraAgent } = await import('../mastra/agent-runtime');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=';
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

function createCapturingModel(args: {
  finalText: string;
  onPrompt: (prompt: LanguageModelV2CallOptions['prompt']) => void;
}): LanguageModelV2 {
  const model = {
    doGenerate: () => Promise.reject(new Error('doGenerate is not used by this test')),
    doStream: (options: LanguageModelV2CallOptions) => {
      args.onPrompt(options.prompt);
      const id = 'text-final';
      const parts: LanguageModelV2StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { id, type: 'text-start' },
        { delta: args.finalText, id, type: 'text-delta' },
        { id, type: 'text-end' },
        { finishReason: 'stop', type: 'finish', usage: USAGE },
      ];
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      });
    },
    modelId: 'fake-model',
    provider: 'fake',
    specificationVersion: 'v2' as const,
    supportedUrls: {},
  };
  return model as unknown as LanguageModelV2;
}

async function drain(iterator: AsyncIterable<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of iterator) {
    if (chunk.type === 'text-delta') {
      text += chunk.value;
    }
  }
  return text;
}

describe('convertMessagesToMastra image parts', () => {
  it('emits an AI-SDK content array carrying the image part', () => {
    const converted = convertMessagesToMastra([
      {
        id: 'u1',
        parts: [
          { text: 'look at this', type: 'text' },
          { data: PNG_DATA_URL, filename: 'shot.png', mediaType: 'image/png', type: 'file' },
        ],
        role: 'user',
      },
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toEqual({
      content: [
        { text: 'look at this', type: 'text' },
        { image: PNG_DATA_URL, mediaType: 'image/png', type: 'image' },
      ],
      id: 'u1',
      role: 'user',
    });
  });

  it('keeps the exact legacy string content for text-only messages (prompt stability)', () => {
    const converted = convertMessagesToMastra([
      {
        id: 'u1',
        parts: [
          { text: 'first', type: 'text' },
          { text: 'second', type: 'text' },
        ],
        role: 'user',
      },
    ]);

    expect(converted).toEqual([{ content: 'first\n\nsecond', id: 'u1', role: 'user' }]);
  });

  it('emits an image-only content array when the message has no text', () => {
    const converted = convertMessagesToMastra([
      {
        id: 'u1',
        parts: [{ data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' }],
        role: 'user',
      },
    ]);

    expect(converted).toEqual([
      {
        content: [{ image: PNG_DATA_URL, mediaType: 'image/png', type: 'image' }],
        id: 'u1',
        role: 'user',
      },
    ]);
  });
});

describe('image attachment through the real Mastra loop', () => {
  beforeEach(() => {
    modelHolder.current = undefined;
  });

  it('delivers the image to the model as a file part with its media type', async () => {
    const seenPrompts: LanguageModelV2CallOptions['prompt'][] = [];
    modelHolder.current = createCapturingModel({
      finalText: 'a tiny png',
      onPrompt: (prompt) => {
        seenPrompts.push(prompt);
      },
    });

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u1',
          parts: [
            { text: 'what is in this screenshot?', type: 'text' },
            { data: PNG_DATA_URL, mediaType: 'image/png', type: 'file' },
          ],
          role: 'user',
        },
      ],
      { runtime: { apiKey: 'test-key', provider: 'openai' } }
    );
    const text = await drain(iterator);

    expect(text).toContain('a tiny png');
    expect(seenPrompts).toHaveLength(1);
    const prompt = seenPrompts[0] as unknown as {
      content?: Record<string, unknown>[];
      role: string;
    }[];
    const userEntry = prompt.find((entry) => entry.role === 'user');
    expect(userEntry).toBeDefined();
    const contentParts = userEntry?.content ?? [];
    const filePart = contentParts.find((part) => part['type'] === 'file');
    expect(filePart).toBeDefined();
    expect(filePart?.['mediaType']).toBe('image/png');
    expect(filePart?.['data']).toBeDefined();
    const textPart = contentParts.find((part) => part['type'] === 'text');
    expect(textPart?.['text']).toContain('what is in this screenshot?');
    // The base64 body must not have been flattened into prompt TEXT.
    const allText = contentParts
      .filter((part) => part['type'] === 'text')
      .map((part) => String(part['text']))
      .join(' ');
    expect(allText).not.toContain('base64');
  });
});
