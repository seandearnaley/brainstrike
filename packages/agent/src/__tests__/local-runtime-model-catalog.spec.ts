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

  it('lists and normalizes Ollama models from /v1/models', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/v1/models')) {
        return jsonResponse({
          data: [{ id: 'nomic-embed-text' }, { id: 'qwen2.5:latest' }],
        });
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

    expect(result.endpoint).toBe('http://127.0.0.1:11434/v1/models');
    expect(result.source).toBe('openai_v1_models');
    expect(result.models.map((model) => model.modelKey)).toEqual([
      'ollama::nomic-embed-text',
      'ollama::qwen2.5:latest',
    ]);
    expect(result.models[0]?.capabilities.embeddings).toBe('supported');
    expect(result.models[0]?.dimensionsKnown.state).toBe('needs_verification');
    expect(result.models[1]?.capabilities.embeddings).toBe('unsupported');
  });

  it('falls back to Ollama /api/tags when /v1/models is unavailable', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/version')) {
        return jsonResponse({ version: '0.6.0' });
      }
      if (url.endsWith('/api/tags')) {
        return jsonResponse({
          models: [{ name: 'nomic-embed-text:v1.5' }, { model: 'qwen3:latest' }],
        });
      }
      if (url.endsWith('/v1/models')) {
        return new Response('missing', { status: 404 });
      }
      return jsonResponse({});
    });

    const service = new LocalRuntimeModelCatalogService({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 2000,
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
    expect(result.models.map((model) => model.modelId)).toEqual([
      'nomic-embed-text:v1.5',
      'qwen3:latest',
    ]);
  });

  it('uses LM Studio /api/v1/models fallback and normalizes deterministic keys', async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = getRequestUrl(input);
      if (url.endsWith('/api/v1/models')) {
        return jsonResponse([{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen2.5' }]);
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
    expect(result.models.map((model) => model.modelKey)).toEqual([
      'lmstudio::qwen2.5',
      'lmstudio::text-embedding-nomic-embed-text-v1.5',
    ]);
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
          return jsonResponse({ models: [{ name: 'nomic-embed-text' }] });
        }
        return new Response('down', { status: 503 });
      }
      if (url.endsWith('/v1/models')) {
        return new Response('missing', { status: 404 });
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
