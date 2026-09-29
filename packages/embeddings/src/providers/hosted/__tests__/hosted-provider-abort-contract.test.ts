import { describe, expect, it, vi } from 'vitest';
import type { IHostedEmbeddingProvider } from '../../../interfaces/provider.js';
import { CohereEmbeddingProvider } from '../cohere-provider.js';
import { GoogleEmbeddingProvider } from '../google-provider.js';
import { OpenAIEmbeddingProvider } from '../openai-provider.js';
import { VoyageEmbeddingProvider } from '../voyage-provider.js';

const providers: Array<{
  name: string;
  modelId: string;
  create: (fetchImpl: typeof fetch) => IHostedEmbeddingProvider;
}> = [
  {
    create: (fetchImpl) =>
      new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        fetch: fetchImpl,
        modelId: 'text-embedding-3-small',
        targetDimensions: 768,
      }),
    modelId: 'text-embedding-3-small',
    name: 'OpenAI',
  },
  {
    create: (fetchImpl) =>
      new OpenAIEmbeddingProvider({
        fetch: fetchImpl,
        modelId: 'nomic-embed-text',
        provider: 'ollama',
        targetDimensions: 768,
      }),
    modelId: 'nomic-embed-text',
    name: 'Ollama',
  },
  {
    create: (fetchImpl) =>
      new OpenAIEmbeddingProvider({
        fetch: fetchImpl,
        modelId: 'local-embedding-model',
        provider: 'lmstudio',
        targetDimensions: 768,
      }),
    modelId: 'local-embedding-model',
    name: 'LM Studio',
  },
  {
    create: (fetchImpl) =>
      new CohereEmbeddingProvider({
        apiKey: 'test-key',
        fetch: fetchImpl,
        modelId: 'embed-english-v3.0',
      }),
    modelId: 'embed-english-v3.0',
    name: 'Cohere',
  },
  {
    create: (fetchImpl) =>
      new GoogleEmbeddingProvider({
        apiKey: 'test-key',
        fetch: fetchImpl,
        modelId: 'gemini-embedding-001',
      }),
    modelId: 'gemini-embedding-001',
    name: 'Google',
  },
  {
    create: (fetchImpl) =>
      new VoyageEmbeddingProvider({
        apiKey: 'test-key',
        fetch: fetchImpl,
        modelId: 'voyage-3',
      }),
    modelId: 'voyage-3',
    name: 'Voyage',
  },
];

describe.each(providers)('$name hosted abort contract', ({ create, modelId }) => {
  it('passes the signal to fetch and preserves its exact abort reason', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error('Embedding fetch did not receive an AbortSignal.'));
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const provider = create(fetchImpl as typeof fetch);

    const resultPromise = provider.embed({
      modelId,
      signal: controller.signal,
      text: 'abort this embedding request',
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (result.ok || result.error.type !== 'network_error') {
      throw new Error('Aborted hosted embedding must return a network error.');
    }
    expect(result.error.originalError).toBe(controller.signal.reason);
  });
});
