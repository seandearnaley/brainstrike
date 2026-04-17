import { beforeEach, describe, expect, it, vi } from 'vitest';

type OpenAiProviderCall = Parameters<typeof import('@ai-sdk/openai').createOpenAI>[0];

const capturedOpenAiCalls: OpenAiProviderCall[] = [];
const fakeProvider = vi.fn(
  (modelId: string) =>
    ({
      specificationVersion: 'v2',
      modelId,
    }) as unknown
);

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (options?: OpenAiProviderCall) => {
    capturedOpenAiCalls.push(options);
    return fakeProvider;
  },
}));

describe('provider-factory local-runtime endpoint overrides', () => {
  beforeEach(() => {
    capturedOpenAiCalls.length = 0;
    fakeProvider.mockClear();
  });

  it('defaults Ollama to 127.0.0.1:11434/v1 with no auth when no overrides are given', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('ollama', undefined, 'qwen3:latest');

    expect(capturedOpenAiCalls).toHaveLength(1);
    expect(capturedOpenAiCalls[0]).toEqual({ baseURL: 'http://127.0.0.1:11434/v1' });
  });

  it('defaults LM Studio to 127.0.0.1:1234/v1 with no auth', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('lmstudio', undefined, 'qwen2.5');

    expect(capturedOpenAiCalls).toHaveLength(1);
    expect(capturedOpenAiCalls[0]).toEqual({ baseURL: 'http://127.0.0.1:1234/v1' });
  });

  it('rewrites Ollama baseURL and forwards apiToken from runtime options', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('ollama', undefined, 'qwen3:latest', {
      providerOptions: {
        ollama: {
          baseUrl: 'https://gpu.lan:11434/v1/',
          apiToken: 'tok_abc',
        },
      },
    });

    expect(capturedOpenAiCalls[0]).toEqual({
      baseURL: 'https://gpu.lan:11434/v1',
      apiKey: 'tok_abc',
    });
  });

  it('prefers explicit apiKey argument over runtime-option apiToken', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('lmstudio', 'from-arg', 'qwen2.5', {
      providerOptions: {
        lmstudio: { apiToken: 'from-runtime' },
      },
    });

    expect(capturedOpenAiCalls[0]).toEqual({
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: 'from-arg',
    });
  });

  it('accepts host:port shorthand and canonicalizes the baseURL', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('ollama', undefined, 'qwen3:latest', {
      providerOptions: {
        ollama: { baseUrl: 'remote.box:11434' },
      },
    });

    expect(capturedOpenAiCalls[0]?.baseURL).toBe('http://remote.box:11434/v1');
  });
});
