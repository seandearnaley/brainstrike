// @vitest-environment node

import type { HostedProviderType } from '@brainstrike/embeddings/provider-core';
import { clearHostedProviderApiKeyCache } from '@brainstrike/embeddings/provider-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateHostedEmbeddings } from '../hosted-embeddings';

vi.mock('../secrets', () => ({ getSecretsService: () => ({ getKey: async () => 'test-key' }) }));
const existing = [
  { dimensions: 1536, modelId: 'text-embedding-3-small', provider: 'openai' },
  { dimensions: 3072, modelId: 'gemini-embedding-001', provider: 'google' },
  { dimensions: 1024, modelId: 'embed-english-v3.0', provider: 'cohere' },
  { dimensions: 1024, modelId: 'voyage-2', provider: 'voyage' },
  { dimensions: 768, modelId: 'nomic-embed-text', provider: 'ollama' },
  { dimensions: 768, modelId: 'text-embedding-nomic-embed-text-v1.5', provider: 'lmstudio' },
] as const satisfies readonly {
  provider: HostedProviderType;
  modelId: string;
  dimensions: number;
}[];

afterEach(() => {
  vi.unstubAllGlobals();
  clearHostedProviderApiKeyCache();
});
describe.each(existing)('existing $provider dispatch', (selected) => {
  it.each(['document', 'query'] as const)(
    'preserves %s semantics, identity, dimensions and complete batch',
    async (purpose) => {
      const texts = purpose === 'document' ? ['document one', 'document two'] : ['query'];
      const vectors = texts.map((_, index) =>
        Array.from({ length: selected.dimensions }, () => index + 0.25)
      );
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const payload =
          selected.provider === 'google'
            ? { embeddings: vectors.map((values) => ({ values })) }
            : selected.provider === 'cohere'
              ? { embeddings: { float: vectors } }
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
        expect(body['input_type']).toBe(
          purpose === 'document' ? 'search_document' : 'search_query'
        );
        expect(body['texts']).toEqual(texts);
      }
      if (selected.provider === 'voyage') {
        expect(body['input_type']).toBe(purpose);
      }
      if (selected.provider === 'ollama') {
        expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/v1/embeddings');
      }
      if (selected.provider === 'lmstudio') {
        expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:1234/v1/embeddings');
      }
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
      dimensions: 768,
      modelId: 'saved-model',
      provider: 'ollama',
      purpose: 'query',
      signal: controller.signal,
      texts: ['query'],
    })
  ).rejects.toMatchObject({ cause: { originalError: failure, type: 'network_error' } });
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
      dimensions: 768,
      modelId: 'saved-model',
      provider: 'ollama',
      purpose: 'query',
      signal: controller.signal,
      texts: ['query'],
    })
  ).rejects.toBe(reason);
});

it.each(['ollama', 'lmstudio'] as const)(
  'uses the same saved %s remote endpoint and token for documents and queries',
  async (provider) => {
    const storage = {
      getItem: vi.fn(async () =>
        JSON.stringify({
          state: {
            providerSettings: {
              [provider]: { localRuntimeBaseUrl: 'https://gpu.example.test:8443/runtime/' },
            },
          },
        })
      ),
    };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return new Response(
        JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(1), index: 0 }] }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetch);
    for (const purpose of ['document', 'query'] as const) {
      await generateHostedEmbeddings({
        dimensions: 768,
        modelId: 'remote-model',
        provider,
        purpose,
        signal: new AbortController().signal,
        storage,
        texts: ['text'],
      });
    }
    expect(storage.getItem).toHaveBeenCalledWith('assistant-preferences.v1');
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://gpu.example.test:8443/runtime/v1/embeddings',
      'https://gpu.example.test:8443/runtime/v1/embeddings',
    ]);
  }
);
