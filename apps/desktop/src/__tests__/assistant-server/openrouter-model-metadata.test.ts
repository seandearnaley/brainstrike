import { parseOpenRouterModelMetadataSnapshot } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterModelMetadataService } from '../../assistant-server/openrouter-model-metadata';

const payload = {
  data: {
    context_length: 400_000,
    id: 'openai/gpt-5.4-mini',
    supported_parameters: ['tools', 'reasoning', 'max_tokens'],
    top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
  },
};

describe('OpenRouterModelMetadataService', () => {
  it('fetches and caches one exact model with authenticated Models API metadata', async () => {
    let now = 1000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => now });

    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
      freshness: 'live',
      metadata: {
        checkedAt: 1000,
        contextWindow: 400_000,
        id: 'openai/gpt-5.4-mini',
        maxOutputTokens: 128_000,
      },
    });
    now += 1000;
    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
      freshness: 'fresh-cache',
      metadata: { checkedAt: 1000 },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/model/openai/gpt-5.4-mini',
      expect.objectContaining({
        headers: { accept: 'application/json', authorization: 'Bearer secret-key' },
      })
    );
  });

  it('does not let live metadata widen a catalogued fixed route budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            architecture: {
              input_modalities: ['text', 'image', 'video'],
              output_modalities: ['text'],
            },
            context_length: 2_000_000,
            id: 'qwen/qwen3.8-flash',
            reasoning: {
              default_effort: 'xhigh',
              default_enabled: true,
              mandatory: false,
              supported_efforts: ['xhigh', 'medium', 'low'],
              supports_max_tokens: true,
            },
            supported_parameters: [
              'tools',
              'tool_choice',
              'reasoning',
              'response_format',
              'structured_outputs',
              'max_tokens',
            ],
            top_provider: {
              context_length: 2_000_000,
              max_completion_tokens: 262_144,
            },
          },
        }),
        { status: 200 }
      )
    );
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => 1000 });

    await expect(service.get('qwen/qwen3.8-flash', 'secret-key')).resolves.toMatchObject({
      freshness: 'live',
      metadata: {
        contextWindow: 1_000_000,
        id: 'qwen/qwen3.8-flash',
        maxOutputTokens: 131_072,
        reasoning: {
          defaultEffort: 'xhigh',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['xhigh', 'medium', 'low'],
        },
        supportedParameters: expect.arrayContaining([
          'tools',
          'tool_choice',
          'response_format',
          'structured_outputs',
        ]),
      },
    });
  });

  it('keeps a catalog fallback output ceiling within a narrower live context', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            context_length: 65_536,
            id: 'qwen/qwen3.8-flash',
            supported_parameters: ['tools', 'reasoning', 'max_tokens'],
            top_provider: { context_length: 65_536 },
          },
        }),
        { status: 200 }
      )
    );
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => 1000 });

    const snapshot = await service.get('qwen/qwen3.8-flash', 'secret-key');

    expect(snapshot.metadata).toMatchObject({
      contextWindow: 65_536,
      maxOutputTokens: 65_536,
    });
    expect(() => parseOpenRouterModelMetadataSnapshot(snapshot)).not.toThrow();
  });

  it('deduplicates concurrent refreshes', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => 1000 });

    const first = service.get('openai/gpt-5.4-mini', 'secret-key');
    const second = service.get('openai/gpt-5.4-mini', 'secret-key');
    resolveResponse?.(new Response(JSON.stringify(payload), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not deduplicate concurrent refreshes across different API keys', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => 1000 });

    const first = service.get('openai/gpt-5.4-mini', 'old-key');
    const second = service.get('openai/gpt-5.4-mini', 'new-key');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const resolve of resolvers) {
      resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('returns an explicitly stale snapshot when refresh fails after the TTL', async () => {
    let now = 1000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const service = createOpenRouterModelMetadataService({
      fetchImpl,
      now: () => now,
      successTtlMs: 5000,
    });
    await service.get('openai/gpt-5.4-mini', 'secret-key');
    now = 7000;

    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
      freshness: 'stale-cache',
      metadata: { checkedAt: 1000 },
      warning: 'OpenRouter Models API returned status 503',
    });
  });

  it('fails visibly when no validated snapshot exists', async () => {
    const service = createOpenRouterModelMetadataService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
    });
    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).rejects.toThrow(
      'OpenRouter Models API returned status 503'
    );
  });

  it.each(['', 'gpt-5.4-mini', 'openai/model/extra'])('rejects invalid model id %j', async (id) => {
    const service = createOpenRouterModelMetadataService({
      fetchImpl: vi.fn<typeof fetch>(),
    });
    await expect(service.get(id, 'secret-key')).rejects.toThrow('provider/model');
  });

  it('rejects an unbounded model id before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = createOpenRouterModelMetadataService({ fetchImpl });

    await expect(service.get(`openai/${'m'.repeat(250)}`, 'secret-key')).rejects.toThrow(
      'at most 256'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
