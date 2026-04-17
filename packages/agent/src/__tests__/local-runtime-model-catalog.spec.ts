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
    status,
    headers: {
      'content-type': 'application/json',
    },
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
              name: 'nomic-embed-text:latest',
              details: { families: ['nomic-bert'] },
            },
            {
              name: 'qwen2.5:latest',
              details: { families: ['qwen2'] },
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
      surface: 'desktop',
      force: true,
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
      surface: 'desktop',
      force: true,
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
              type: 'embeddings',
              state: 'loaded',
            },
            { id: 'qwen2.5', type: 'llm', state: 'not-loaded' },
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
      surface: 'desktop',
      force: true,
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
            models: [{ name: 'nomic-embed-text', details: { families: ['nomic-bert'] } }],
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
      surface: 'desktop',
      force: true,
    });

    expect(first.state).toBe('loaded_non_empty');

    phase = 'fail';

    const second = await service.listRuntimeModels('ollama', {
      surface: 'desktop',
      force: true,
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
      surface: 'desktop',
      force: true,
      verifyEmbeddingDimensions: true,
      maxVerificationModels: 1,
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
      surface: 'desktop',
      force: true,
    });

    expect(result.state).toBe('failed');
    if (result.state !== 'failed') {
      throw new Error('Expected failed state');
    }
    expect(result.message.toLowerCase()).toContain('econnrefused');
  });
});
