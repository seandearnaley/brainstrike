import { beforeEach, describe, expect, it, vi } from 'vitest';

const doStream = vi.fn().mockResolvedValue({ stream: 'anthropic-stream' });
const doGenerate = vi.fn().mockResolvedValue({ finishReason: 'stop' });

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({
    doGenerate,
    doStream,
    modelId,
    provider: 'anthropic.messages',
    specificationVersion: 'v2',
  })),
}));

import { createProvider } from '../providers/provider-factory';

interface PromptMessageLike {
  content: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  role: string;
}

describe('provider-factory anthropic prompt caching wiring', () => {
  beforeEach(() => {
    doStream.mockClear();
    doGenerate.mockClear();
  });

  it('wraps hosted Anthropic models so doStream carries the tail cache breakpoint', async () => {
    const model = createProvider(
      'anthropic',
      { apiKey: 'test-key', kind: 'api_key' },
      'claude-sonnet-4-6'
    ) as {
      doStream: (params: unknown) => Promise<unknown>;
      modelId: string;
    };

    expect(model.modelId).toBe('claude-sonnet-4-6');

    await model.doStream({
      prompt: [
        { content: 'system prompt', role: 'system' },
        { content: [{ text: 'hello', type: 'text' }], role: 'user' },
      ],
    });

    const forwarded = doStream.mock.calls[0]?.[0] as { prompt: PromptMessageLike[] };
    expect(forwarded.prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(forwarded.prompt.at(0)?.providerOptions).toBeUndefined();
  });
});
