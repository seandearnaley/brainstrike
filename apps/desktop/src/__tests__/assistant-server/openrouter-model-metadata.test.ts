import { parseOpenRouterModelMetadataSnapshot } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterModelMetadataService } from '../../assistant-server/openrouter-model-metadata';
import recordedPayload from '../fixtures/openrouter-sonnet-4-6-model-metadata.json';

const payload = {
  data: {
    context_length: 400_000,
    id: 'openai/gpt-5.4-mini',
    supported_parameters: ['tools', 'reasoning', 'max_tokens'],
    top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
  },
};

const recordedMetadata = JSON.stringify(recordedPayload);
const recordedModelId = 'anthropic/claude-sonnet-4.6';

beforeEach(() => {
  vi.stubEnv('OPENROUTER_BASE_URL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenRouterModelMetadataService', () => {
  it.each([
    ['root', 'http://127.0.0.1:38182', 'http://127.0.0.1:38182'],
    ['API prefix', 'http://127.0.0.1:38182/api/v1/', 'http://127.0.0.1:38182/api/v1'],
    [
      'shim prefix',
      'http://127.0.0.1:38182/OPENROUTER_BASE_URL',
      'http://127.0.0.1:38182/OPENROUTER_BASE_URL',
    ],
  ])(
    'uses the configured %s destination for recorded metadata',
    async (_name, baseUrl, expectedBase) => {
      vi.stubEnv('OPENROUTER_BASE_URL', baseUrl);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(recordedMetadata));
      const service = createOpenRouterModelMetadataService({ fetchImpl });

      await expect(service.get(recordedModelId, 'metadata-fixture-key')).resolves.toMatchObject({
        freshness: 'live',
        metadata: { contextWindow: 1_000_000, id: recordedModelId, maxOutputTokens: 128_000 },
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `${expectedBase}/model/anthropic/claude-sonnet-4.6`,
        expect.objectContaining({
          headers: { accept: 'application/json', authorization: 'Bearer metadata-fixture-key' },
        })
      );
    }
  );

  it.each([undefined, ''])(
    'keeps the production default when the override is %s',
    async (baseUrl) => {
      vi.stubEnv('OPENROUTER_BASE_URL', baseUrl);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(recordedMetadata));
      const service = createOpenRouterModelMetadataService({ fetchImpl });

      await expect(service.get(recordedModelId, 'metadata-fixture-key')).resolves.toMatchObject({
        freshness: 'live',
        metadata: { id: recordedModelId },
      });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        'https://openrouter.ai/api/v1/model/anthropic/claude-sonnet-4.6'
      );
    }
  );

  it.each([
    ['relative path', '/api/v1'],
    ['invalid URL', 'not-a-url'],
    ['incomplete URL', 'http://'],
    ['non-HTTP scheme', 'file:///tmp/model-metadata'],
    ['URL credentials', 'http://fixture-user:fixture-password@127.0.0.1:38182'],
    ['query', 'http://127.0.0.1:38182/api/v1?fixture=1'],
    ['fragment', 'http://127.0.0.1:38182/api/v1#fixture'],
    ['empty query', 'http://127.0.0.1:38182/api/v1?'],
    ['empty fragment', 'http://127.0.0.1:38182/api/v1#'],
  ])('rejects a configured %s before fetching', async (_name, baseUrl) => {
    vi.stubEnv('OPENROUTER_BASE_URL', baseUrl);
    const fetchImpl = vi.fn<typeof fetch>();
    const service = createOpenRouterModelMetadataService({ fetchImpl });

    await expect(service.get(recordedModelId, 'metadata-fixture-key')).rejects.toThrow(
      'OPENROUTER_BASE_URL must be an absolute HTTP(S) base URL without credentials, query or fragment'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not hide malformed configuration behind a fresh cached snapshot', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(recordedMetadata));
    const service = createOpenRouterModelMetadataService({ fetchImpl });
    await service.get(recordedModelId, 'metadata-fixture-key');
    vi.stubEnv('OPENROUTER_BASE_URL', 'not-a-url');

    await expect(service.get(recordedModelId, 'metadata-fixture-key')).rejects.toThrow(
      'OPENROUTER_BASE_URL must be an absolute HTTP(S) base URL without credentials, query or fragment'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps cached snapshots and stale fallback within their configured base URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(recordedMetadata))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const service = createOpenRouterModelMetadataService({ fetchImpl, now: () => 1000 });
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:38182/first');
    await service.get(recordedModelId, 'metadata-fixture-key');
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:38182/second');

    await expect(service.get(recordedModelId, 'metadata-fixture-key')).rejects.toThrow(
      'status 503'
    );
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
      'http://127.0.0.1:38182/first/model/anthropic/claude-sonnet-4.6',
      'http://127.0.0.1:38182/second/model/anthropic/claude-sonnet-4.6',
    ]);
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:38182/first/');
    await expect(service.get(recordedModelId, 'metadata-fixture-key')).resolves.toMatchObject({
      freshness: 'fresh-cache',
      metadata: { checkedAt: 1000 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate pending requests across configured origins', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const service = createOpenRouterModelMetadataService({ fetchImpl });
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:38182');
    const first = service.get(recordedModelId, 'metadata-fixture-key');
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:38183');
    const second = service.get(recordedModelId, 'metadata-fixture-key');
    for (const resolve of resolvers) {
      resolve(new Response(recordedMetadata));
    }

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
      'http://127.0.0.1:38182/model/anthropic/claude-sonnet-4.6',
      'http://127.0.0.1:38183/model/anthropic/claude-sonnet-4.6',
    ]);
  });

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

  it('returns stale metadata when body reading stalls past the deadline and ignores abort', async () => {
    vi.useFakeTimers();
    let resolveBody: ((value: unknown) => void) | undefined;
    const stalled = new Response('', { status: 200 });
    vi.spyOn(stalled, 'json').mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveBody = resolve;
        })
    );
    let now = 1000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    const service = createOpenRouterModelMetadataService({
      fetchImpl,
      now: () => now,
      requestTimeoutMs: 5,
      successTtlMs: 10,
    });
    try {
      await service.get('openai/gpt-5.4-mini', 'secret-key');
      now = 2000;

      const refresh = service.get('openai/gpt-5.4-mini', 'secret-key');
      await vi.advanceTimersByTimeAsync(5);
      await expect(refresh).resolves.toMatchObject({
        freshness: 'stale-cache',
        metadata: { checkedAt: 1000 },
        warning: 'OpenRouter Models API request timed out after 5ms',
      });
      expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      now = 3000;
      await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
        freshness: 'live',
        metadata: { checkedAt: 3000 },
      });
      resolveBody?.({ data: { ...payload.data, context_length: 1 } });
      await Promise.resolve();
      await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
        freshness: 'fresh-cache',
        metadata: { checkedAt: 3000, contextWindow: 400_000 },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails visibly when the first fetch ignores abort past its deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const service = createOpenRouterModelMetadataService({ fetchImpl, requestTimeoutMs: 5 });
    try {
      const assertion = expect(service.get('openai/gpt-5.4-mini', 'secret-key')).rejects.toThrow(
        'OpenRouter Models API request timed out after 5ms'
      );
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a body rejection that arrives after timeout', async () => {
    vi.useFakeTimers();
    let rejectBody: ((error: Error) => void) | undefined;
    const response = new Response('', { status: 200 });
    vi.spyOn(response, 'json').mockImplementation(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectBody = reject;
        })
    );
    const service = createOpenRouterModelMetadataService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
      requestTimeoutMs: 5,
    });

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const assertion = expect(service.get('openai/gpt-5.4-mini', 'secret-key')).rejects.toThrow(
        'OpenRouter Models API request timed out after 5ms'
      );
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      rejectBody?.(new Error('late body failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  it('clears the deadline after successful metadata reading', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const service = createOpenRouterModelMetadataService({ fetchImpl, requestTimeoutMs: 20 });

    try {
      await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).resolves.toMatchObject({
        freshness: 'live',
      });
      const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails visibly when no validated snapshot exists', async () => {
    const service = createOpenRouterModelMetadataService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
    });
    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).rejects.toThrow(
      'OpenRouter Models API returned status 503'
    );
  });

  it('preserves the original request error when no snapshot exists', async () => {
    const failure = new TypeError('fetch failed');
    const service = createOpenRouterModelMetadataService({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(failure),
    });

    await expect(service.get('openai/gpt-5.4-mini', 'secret-key')).rejects.toBe(failure);
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
