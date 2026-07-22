import { describe, expect, it, vi } from 'vitest';
import { fetchOpenRouterModelMetadata } from '../openrouter-model-metadata-client';

describe('fetchOpenRouterModelMetadata', () => {
  it('requests the selected model through the authenticated assistant endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          freshness: 'live',
          metadata: {
            checkedAt: 42,
            contextWindow: 1_000_000,
            id: 'anthropic/claude-sonnet-4.6',
            maxOutputTokens: 128_000,
            source: 'openrouter-models-api',
            supportedParameters: ['tools'],
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      fetchOpenRouterModelMetadata({
        authHeaders: { 'x-brainstrike-assistant-token': 'token' },
        baseUrl: 'http://127.0.0.1:1234',
        fetchImpl,
        modelId: 'anthropic/claude-sonnet-4.6',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ metadata: { contextWindow: 1_000_000 } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/assistant/openrouter-model?model=anthropic%2Fclaude-sonnet-4.6',
      {
        headers: { 'x-brainstrike-assistant-token': 'token' },
        signal: expect.any(AbortSignal),
      }
    );
  });

  it('surfaces the assistant-server failure message', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'OpenRouter rejected the selected model' }), {
        status: 502,
      })
    );

    await expect(
      fetchOpenRouterModelMetadata({
        authHeaders: {},
        baseUrl: 'http://127.0.0.1:1234',
        fetchImpl,
        modelId: 'vendor/model',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('OpenRouter rejected the selected model');
  });

  it('rejects successful metadata for a different model', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          freshness: 'live',
          metadata: {
            checkedAt: 42,
            contextWindow: 400_000,
            id: 'other/model',
            source: 'openrouter-models-api',
            supportedParameters: [],
          },
        }),
        { status: 200 }
      )
    );

    await expect(
      fetchOpenRouterModelMetadata({
        authHeaders: {},
        baseUrl: 'http://127.0.0.1:1234',
        fetchImpl,
        modelId: 'vendor/model',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('expected model');
  });
});
