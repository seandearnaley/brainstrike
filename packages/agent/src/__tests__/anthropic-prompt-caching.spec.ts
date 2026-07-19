import { describe, expect, it, vi } from 'vitest';

import {
  applyAnthropicPromptCacheBreakpoint,
  wrapAnthropicModelWithPromptCaching,
} from '../providers/anthropic-prompt-caching';

interface PromptMessageLike {
  content: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  role: string;
}

function makeParams(prompt: PromptMessageLike[]): { prompt: PromptMessageLike[] } {
  return { prompt };
}

describe('applyAnthropicPromptCacheBreakpoint', () => {
  it('adds an ephemeral cacheControl breakpoint to the final prompt message', () => {
    const params = makeParams([
      { content: 'You are helpful.', role: 'system' },
      { content: [{ text: 'hi', type: 'text' }], role: 'user' },
    ]);

    const result = applyAnthropicPromptCacheBreakpoint(params);

    expect(result.prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    expect(result.prompt.at(0)?.providerOptions).toBeUndefined();
  });

  it('merges with existing providerOptions on the final message without clobbering other namespaces', () => {
    const params = makeParams([
      { content: [{ text: 'hi', type: 'text' }], role: 'user' },
      {
        content: [{ text: 'follow-up', type: 'text' }],
        providerOptions: { anthropic: { effort: 'high' }, openai: { store: false } },
        role: 'user',
      },
    ]);

    const result = applyAnthropicPromptCacheBreakpoint(params);

    expect(result.prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' }, effort: 'high' },
      openai: { store: false },
    });
  });

  it('preserves an explicit pre-existing cacheControl on the final message', () => {
    const explicit = { ttl: '1h', type: 'ephemeral' };
    const params = makeParams([
      {
        content: [{ text: 'hi', type: 'text' }],
        providerOptions: { anthropic: { cacheControl: explicit } },
        role: 'user',
      },
    ]);

    const result = applyAnthropicPromptCacheBreakpoint(params);

    expect(result.prompt.at(-1)?.providerOptions?.['anthropic']?.['cacheControl']).toBe(explicit);
  });

  it('returns params unchanged for an empty prompt and never mutates its input', () => {
    const empty = makeParams([]);
    expect(applyAnthropicPromptCacheBreakpoint(empty).prompt).toEqual([]);

    const original = makeParams([
      { content: [{ text: 'hi', type: 'text' }], role: 'user' },
      { content: [{ text: 'bye', type: 'text' }], role: 'user' },
    ]);
    const originalLast = original.prompt.at(-1);

    const result = applyAnthropicPromptCacheBreakpoint(original);

    expect(originalLast?.providerOptions).toBeUndefined();
    expect(result.prompt.at(-1)).not.toBe(originalLast);
    expect(result).not.toBe(original);
  });
});

describe('wrapAnthropicModelWithPromptCaching', () => {
  function makeModelStub(): {
    doGenerate: ReturnType<typeof vi.fn>;
    doStream: ReturnType<typeof vi.fn>;
    modelId: string;
    provider: string;
    specificationVersion: string;
  } {
    return {
      doGenerate: vi.fn().mockResolvedValue({ finishReason: 'stop' }),
      doStream: vi.fn().mockResolvedValue({ stream: 'stream-sentinel' }),
      modelId: 'claude-sonnet-4-6',
      provider: 'anthropic.messages',
      specificationVersion: 'v2',
    };
  }

  it('transforms doStream params to include the tail cache breakpoint', async () => {
    const inner = makeModelStub();
    const wrapped = wrapAnthropicModelWithPromptCaching(inner);

    const result = await (
      wrapped as unknown as {
        doStream: (params: unknown) => Promise<unknown>;
      }
    ).doStream(makeParams([{ content: [{ text: 'hi', type: 'text' }], role: 'user' }]));

    expect(result).toEqual({ stream: 'stream-sentinel' });
    const forwarded = inner.doStream.mock.calls[0]?.[0] as { prompt: PromptMessageLike[] };
    expect(forwarded.prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('transforms doGenerate params the same way', async () => {
    const inner = makeModelStub();
    const wrapped = wrapAnthropicModelWithPromptCaching(inner);

    await (
      wrapped as unknown as {
        doGenerate: (params: unknown) => Promise<unknown>;
      }
    ).doGenerate(makeParams([{ content: [{ text: 'hi', type: 'text' }], role: 'user' }]));

    const forwarded = inner.doGenerate.mock.calls[0]?.[0] as { prompt: PromptMessageLike[] };
    expect(forwarded.prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('passes through non-stream properties untouched', () => {
    const inner = makeModelStub();
    const wrapped = wrapAnthropicModelWithPromptCaching(inner);

    expect(wrapped.modelId).toBe('claude-sonnet-4-6');
    expect(wrapped.provider).toBe('anthropic.messages');
    expect(wrapped.specificationVersion).toBe('v2');
  });
});
