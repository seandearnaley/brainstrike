// @vitest-environment node

import { providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedEmbeddingError } from '../hosted-embedding-error';
import { generateHostedEmbeddings } from '../hosted-embeddings';

const storedKey = vi.hoisted(() => ({ value: 'test-key' as string | null }));
vi.mock('../secrets', () => ({
  getSecretsService: () => ({ getKey: async () => storedKey.value }),
}));
const existing = [
  { dimensions: 1536, modelId: 'text-embedding-3-small', provider: 'openai' },
  { dimensions: 3072, modelId: 'gemini-embedding-001', provider: 'google' },
  { dimensions: 1024, modelId: 'embed-english-v3.0', provider: 'cohere' },
  { dimensions: 1024, modelId: 'voyage-2', provider: 'voyage' },
] as const satisfies readonly {
  provider: EmbeddingProviderType;
  modelId: string;
  dimensions: number;
}[];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  storedKey.value = 'test-key';
});
describe.each(existing)('existing $provider dispatch', (selected) => {
  it.each(['document'] as const)(
    'preserves %s semantics, identity, dimensions and complete batch',
    async (purpose) => {
      const texts = ['document one', 'document two'];
      const vectors = texts.map((_, index) =>
        Array.from({ length: selected.dimensions }, () => index + 0.25)
      );
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const payload =
          selected.provider === 'google'
            ? { embeddings: vectors.map((values) => ({ values })) }
            : selected.provider === 'cohere'
              ? { embeddings: { float: vectors }, meta: { billed_units: { input_tokens: 1 } } }
              : { data: vectors.map((embedding, index) => ({ embedding, index })) };
        expect(init?.signal).toBe(signal);
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      });
      vi.stubGlobal('fetch', fetch);
      const signal = new AbortController().signal;
      expect(await generateHostedEmbeddings({ ...selected, purpose, signal, texts })).toEqual(
        vectors
      );
      expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      if (selected.provider === 'cohere') {
        expect(body['input_type']).toBe('search_document');
        expect(body['texts']).toEqual(texts);
      }
      if (selected.provider === 'voyage') {
        expect(body['input_type']).toBe(purpose);
      }
      // A tunable model is asked for the index's size; a fixed one is not.
      const requested =
        selected.provider === 'google'
          ? ((body['requests'] as Record<string, unknown>[] | undefined)?.[0] ?? body)[
              'outputDimensionality'
            ]
          : (body['dimensions'] ?? body['output_dimension']);
      expect(requested).toBe(
        selected.provider === 'openai' || selected.provider === 'google'
          ? selected.dimensions
          : undefined
      );
    }
  );
});

it('preserves a provider failure that settles independently after cancellation', async () => {
  const controller = new AbortController();
  const failure = new Error('Independent transport failure');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      controller.abort(new DOMException('Canceled', 'AbortError'));
      throw failure;
    })
  );
  await expect(
    generateHostedEmbeddings({
      dimensions: 1536,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
      purpose: 'document',
      signal: controller.signal,
      texts: ['document'],
    })
  ).rejects.toBe(failure);
});
it('preserves the exact owned cancellation after provider settlement', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Canceled', 'AbortError');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      controller.abort(reason);
      throw controller.signal.reason;
    })
  );
  await expect(
    generateHostedEmbeddings({
      dimensions: 1536,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
      purpose: 'document',
      signal: controller.signal,
      texts: ['document'],
    })
  ).rejects.toBe(reason);
});

// BST-1994: hosted refusals reach BST-1996's mapping as one typed error. The fixture
// responses are documented shapes, not live recordings: no provider is called.
describe('typed hosted embedding refusals', () => {
  const request = {
    dimensions: 1536,
    modelId: 'text-embedding-3-small',
    provider: 'openai',
    purpose: 'document',
    texts: ['document'],
  } as const;
  async function refusal(): Promise<unknown> {
    return await generateHostedEmbeddings({
      ...request,
      signal: new AbortController().signal,
    }).then(
      () => {
        throw new Error('Expected a refusal');
      },
      (error: unknown) => error
    );
  }

  it.each([
    [429, 'rate-limit'],
    [413, 'input-too-long'],
    [400, 'provider-status'],
    [503, 'provider-status'],
  ] as const)('maps HTTP %s to %s with a model-safe message', async (status, kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'raw detail for sk-live-secret' } }), {
            headers: { 'content-type': 'application/json' },
            status,
          })
      )
    );
    const error = await refusal();
    expect(error).toBeInstanceOf(HostedEmbeddingError);
    expect(error).toMatchObject({ kind, name: 'HostedEmbeddingError' });
    expect((error as Error).message).not.toContain('sk-live-secret');
  });

  it('maps a transport failure to network and keeps the provider error as its cause', async () => {
    const failure = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND api.openai.com'),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw failure;
      })
    );
    const error = await refusal();
    expect(error).toBeInstanceOf(HostedEmbeddingError);
    expect(error).toMatchObject({ kind: 'network' });
    expect(JSON.stringify((error as Error).cause)).toContain('getaddrinfo ENOTFOUND');
  });

  it.each(['google', 'cohere', 'voyage'] as const)(
    'refuses %s without a key as missing-key',
    async (provider) => {
      for (const name of providerEnvKeys(provider)) {
        vi.stubEnv(name, '');
      }
      storedKey.value = null;
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        generateHostedEmbeddings({
          dimensions: 768,
          modelId: 'model',
          provider,
          purpose: 'document',
          signal: new AbortController().signal,
          texts: ['document'],
        })
      ).rejects.toMatchObject({ kind: 'missing-key', name: 'HostedEmbeddingError' });
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
