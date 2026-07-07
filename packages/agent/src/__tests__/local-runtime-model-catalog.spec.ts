import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRuntimeModelCatalogService } from '../providers/local-runtime-model-catalog';

type FetchMockInput = string | URL | Request;
type FetchMock = (input: FetchMockInput, init?: RequestInit) => Promise<Response>;

function getRequestUrl(input: FetchMockInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json',
    },
    status,
  });
}

describe('local-runtime-model-catalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists and normalizes Ollama models from /api/tags with family hints', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/tags')) {
        return jsonResponse({
          models: [
            {
              details: { families: ['nomic-bert'] },
              name: 'nomic-embed-text:latest',
            },
            {
              details: { families: ['qwen2'] },
              name: 'qwen2.5:latest',
            },
          ],
        });
      }
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ models: [] });
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1000,
    });

    const result = await service.listRuntimeModels('ollama', {
      force: true,
      surface: 'desktop',
    });

    expect(result.state).toBe('loaded_non_empty');
    if (result.state !== 'loaded_non_empty') {
      throw new Error('Expected loaded_non_empty state');
    }

    expect(result.endpoint).toBe('http://127.0.0.1:11434/api/tags');
    expect(result.source).toBe('ollama_api_tags');
    expect(result.models.map((model) => model.modelKey)).toEqual([
      'ollama::nomic-embed-text:latest',
      'ollama::qwen2.5:latest',
    ]);
    // `nomic-bert` family is an authoritative embedding hint; `qwen2` is not.
    expect(result.models[0]?.capabilities.embeddings).toBe('supported');
    expect(result.models[0]?.capabilitySource).toBe('provider_reported');
    expect(result.models[0]?.modelType).toBe('embeddings');
    expect(result.models[1]?.capabilities.embeddings).toBe('unsupported');
    expect(result.models[1]?.capabilitySource).toBe('inferred');
  });

  it('falls back to Ollama /v1/models when /api/tags is unavailable', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/tags')) {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/v1/models')) {
        return jsonResponse({
          data: [{ id: 'nomic-embed-text' }, { id: 'qwen2.5:latest' }],
        });
      }
      return jsonResponse({});
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 1500,
    });

    const result = await service.listRuntimeModels('ollama', {
      force: true,
      surface: 'desktop',
    });

    expect(result.state).toBe('loaded_non_empty');
    if (result.state !== 'loaded_non_empty') {
      throw new Error('Expected loaded_non_empty state');
    }

    expect(result.endpoint).toBe('http://127.0.0.1:11434/v1/models');
    expect(result.source).toBe('openai_v1_models');
    // Without a family hint, embedding classification falls back to name regex.
    expect(result.models[0]?.capabilitySource).toBe('inferred');
  });

  it('uses LM Studio native /api/v1/models with authoritative type discriminant', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/v1/models')) {
        return jsonResponse({
          data: [
            {
              id: 'text-embedding-nomic-embed-text-v1.5',
              state: 'loaded',
              type: 'embeddings',
            },
            { id: 'qwen2.5', state: 'not-loaded', type: 'llm' },
          ],
        });
      }
      if (url.endsWith('/v1/models')) {
        return new Response('missing', { status: 404 });
      }
      return jsonResponse({});
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 3000,
    });

    const result = await service.listRuntimeModels('lmstudio', {
      force: true,
      surface: 'desktop',
    });

    expect(result.state).toBe('loaded_non_empty');
    if (result.state !== 'loaded_non_empty') {
      throw new Error('Expected loaded_non_empty state');
    }

    expect(result.source).toBe('lmstudio_api_v1_models');
    expect(result.endpoint).toBe('http://127.0.0.1:1234/api/v1/models');
    expect(result.models.map((model) => model.modelKey)).toEqual([
      'lmstudio::qwen2.5',
      'lmstudio::text-embedding-nomic-embed-text-v1.5',
    ]);

    const embeddingModel = result.models.find(
      (model) => model.modelId === 'text-embedding-nomic-embed-text-v1.5'
    );
    expect(embeddingModel?.modelType).toBe('embeddings');
    expect(embeddingModel?.capabilitySource).toBe('provider_reported');
    expect(embeddingModel?.loaded).toBe(true);

    const llmModel = result.models.find((model) => model.modelId === 'qwen2.5');
    expect(llmModel?.modelType).toBe('llm');
    expect(llmModel?.loaded).toBe(false);
  });

  it('returns stale_cached when model list probing fails after a prior success', async () => {
    let phase: 'ok' | 'fail' = 'ok';

    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/version')) {
        return jsonResponse({ version: '0.6.1' });
      }
      if (url.endsWith('/api/tags')) {
        if (phase === 'ok') {
          return jsonResponse({
            models: [{ details: { families: ['nomic-bert'] }, name: 'nomic-embed-text' }],
          });
        }
        return new Response('down', { status: 503 });
      }
      if (url.endsWith('/v1/models')) {
        if (phase === 'ok') {
          return new Response('missing', { status: 404 });
        }
        // In the failing phase, both catalog endpoints are down; mirror the
        // realistic case so the stale fallback surfaces a useful error message.
        return new Response('down', { status: 503 });
      }
      return jsonResponse({});
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => Date.now(),
      successTtlMs: 1,
    });

    const first = await service.listRuntimeModels('ollama', {
      force: true,
      surface: 'desktop',
    });

    expect(first.state).toBe('loaded_non_empty');

    phase = 'fail';

    const second = await service.listRuntimeModels('ollama', {
      force: true,
      surface: 'desktop',
    });

    expect(second.state).toBe('stale_cached');
    if (second.state !== 'stale_cached') {
      throw new Error('Expected stale_cached state');
    }

    expect(second.models.map((model) => model.modelId)).toEqual(['nomic-embed-text']);
    expect(second.models[0]?.freshness).toBe('stale_cached');
    expect(second.message).toContain('503');
  });

  it('optionally verifies embedding dimensions through /v1/embeddings', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/v1/models')) {
        return jsonResponse({
          data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }],
        });
      }
      if (url.endsWith('/v1/embeddings') && init?.method === 'POST') {
        return jsonResponse({
          data: [
            {
              embedding: Array.from({ length: 768 }, () => 0.1),
            },
          ],
        });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 5000,
    });

    const result = await service.listRuntimeModels('lmstudio', {
      force: true,
      maxVerificationModels: 1,
      surface: 'desktop',
      verifyEmbeddingDimensions: true,
    });

    expect(result.state).toBe('loaded_non_empty');
    if (result.state !== 'loaded_non_empty') {
      throw new Error('Expected loaded_non_empty state');
    }

    const first = result.models[0];
    expect(first?.capabilities.embeddings).toBe('supported');
    expect(first?.dimensionsKnown.state).toBe('known');
    if (first?.dimensionsKnown.state === 'known') {
      expect(first.dimensionsKnown.values).toEqual([768]);
    }
  });

  it('returns failed when runtime is unavailable and no cache exists', async () => {
    const fetchMock = vi
      .fn<FetchMock>()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1234'));

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 6000,
    });

    const result = await service.listRuntimeModels('lmstudio', {
      force: true,
      surface: 'desktop',
    });

    expect(result.state).toBe('failed');
    if (result.state !== 'failed') {
      throw new Error('Expected failed state');
    }
    expect(result.message.toLowerCase()).toContain('econnrefused');
  });

  it('resolves Ollama capabilities via POST /api/show', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/show') && init?.method === 'POST') {
        expect(init.body).toBe(JSON.stringify({ model: 'qwen2.5:latest' }));
        return jsonResponse({
          capabilities: ['completion', 'tools', 'thinking', 'unknown-future'],
        });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 7000,
    });

    const result = await service.resolveOllamaCapabilities('qwen2.5:latest');

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected resolved state');
    }
    expect(result.capabilities).toEqual(['completion', 'tools', 'thinking']);
    expect(result.llm).toBe(true);
    expect(result.embedding).toBe(false);
    expect(result.tools).toBe(true);
    expect(result.thinking).toBe(true);
    expect(result.vision).toBe(false);

    // Second call within TTL should be served from the cache without re-fetching.
    await service.resolveOllamaCapabilities('qwen2.5:latest');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces Ollama /api/show failures with status + message', async () => {
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValue(new Response('not found', { status: 404 }));

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 8000,
    });

    const result = await service.resolveOllamaCapabilities('does-not-exist');

    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') {
      throw new Error('Expected unavailable state');
    }
    expect(result.status).toBe(404);
    expect(result.message).toContain('404');
  });

  it('caps the Ollama capabilities cache so it cannot grow unbounded across a long session', async () => {
    // Reviewer feedback: ollamaCapabilitiesCache had no size bound. A user
    // cycling through many models across multiple baseUrls could grow the
    // Map monotonically until `clearCache()`. Contract: after inserting
    // more than OLLAMA_CAPABILITIES_CACHE_MAX_ENTRIES (200) distinct keys,
    // the cache evicts the oldest entry so size never exceeds the cap.
    const fetchMock = vi.fn<FetchMock>(async () => jsonResponse({ capabilities: ['completion'] }));

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => Date.now(),
    });

    // Push 210 distinct modelIds through; the cap is 200.
    for (let i = 0; i < 210; i += 1) {
      await service.resolveOllamaCapabilities(`model-${i}:latest`);
    }

    // The very first key should have been evicted; a more recent one should
    // still be cached. Inspect via getCachedState-equivalent by re-asking
    // and checking the fetchMock call count is stable when hitting a recent
    // key and grows when hitting the evicted key.
    const callCountBeforeReAsk = fetchMock.mock.calls.length;
    await service.resolveOllamaCapabilities('model-209:latest');
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeReAsk); // cache hit
    await service.resolveOllamaCapabilities('model-0:latest');
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeReAsk + 1); // evicted, refetches
  });

  it('rejects empty Ollama modelId with a clear message and no network call', async () => {
    const fetchMock = vi.fn<FetchMock>();

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 9000,
    });

    const result = await service.resolveOllamaCapabilities('   ');

    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') {
      throw new Error('Expected unavailable state');
    }
    expect(result.message).toBe('modelId is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes probes to the configured baseUrl and attaches bearer token', async () => {
    const observedUrls: string[] = [];
    const observedAuth: (string | null)[] = [];
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      const url = getRequestUrl(input);
      observedUrls.push(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      observedAuth.push(headers.get('authorization'));
      if (url === 'https://gpu.lan:11434/api/tags') {
        return jsonResponse({
          models: [{ details: { families: ['phi4'] }, name: 'phi4:latest' }],
        });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 10_000,
    });

    const result = await service.listRuntimeModels('ollama', {
      endpoint: {
        apiToken: 'tok_abc',
        baseUrl: 'https://gpu.lan:11434/v1/',
      },
      force: true,
      surface: 'desktop',
    });

    expect(result.state).toBe('loaded_non_empty');
    if (result.state !== 'loaded_non_empty') {
      throw new Error('Expected loaded_non_empty state');
    }
    expect(result.endpoint).toBe('https://gpu.lan:11434/api/tags');
    // Every probe targeted the custom origin, none fell back to 127.0.0.1.
    expect(observedUrls.every((url) => url.startsWith('https://gpu.lan:11434'))).toBe(true);
    // Every probe carried the bearer token; no anonymous requests escape.
    expect(observedAuth.every((value) => value === 'Bearer tok_abc')).toBe(true);
  });

  it('routes /api/show capability lookups to the configured baseUrl', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url === 'https://gpu.lan:11434/api/show') {
        return jsonResponse({ capabilities: ['completion', 'embedding'] });
      }
      return new Response('missing', { status: 404 });
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 11_000,
    });

    const result = await service.resolveOllamaCapabilities('bge-m3:latest', {
      endpoint: { apiToken: 'tok_xyz', baseUrl: 'https://gpu.lan:11434' },
    });

    expect(result.state).toBe('resolved');
    if (result.state !== 'resolved') {
      throw new Error('Expected resolved state');
    }
    expect(result.endpoint).toBe('https://gpu.lan:11434/api/show');
    expect(result.embedding).toBe(true);
    expect(result.llm).toBe(true);
  });
});
