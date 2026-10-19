import { beforeEach, describe, expect, it, vi } from 'vitest';

type OpenAiProviderCall = Parameters<typeof import('@ai-sdk/openai').createOpenAI>[0];

const capturedOpenAiCalls: OpenAiProviderCall[] = [];
const fakeProvider = vi.fn(
  (modelId: string) =>
    ({
      modelId,
      specificationVersion: 'v2',
    }) as unknown
);

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (options?: OpenAiProviderCall) => {
    capturedOpenAiCalls.push(options);
    return fakeProvider;
  },
}));

// Ollama runs on its native /api/chat (BST-754): its endpoint, token and
// environment-key tests live in ollama-chat-model.spec.ts.
describe('provider-factory local-runtime endpoint overrides', () => {
  beforeEach(() => {
    capturedOpenAiCalls.length = 0;
    fakeProvider.mockClear();
  });

  it('returns Mastra OpenAI-compatible config for LM Studio', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('lmstudio', undefined, 'qwen2.5');

    expect(capturedOpenAiCalls).toHaveLength(0);
    expect(model).toEqual({
      apiKey: 'lmstudio',
      modelId: 'qwen2.5',
      providerId: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1',
    });
  });

  it('prefers explicit apiKey argument over runtime-option apiToken', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('lmstudio', { apiKey: 'from-arg', kind: 'api_key' }, 'qwen2.5', {
      providerOptions: {
        lmstudio: { apiToken: 'from-runtime' },
      },
    });

    expect(model).toEqual({
      apiKey: 'from-arg',
      modelId: 'qwen2.5',
      providerId: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1',
    });
  });

  it('rejects Ollama tokens containing CR/LF to prevent header injection', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    expect(() =>
      createProvider('ollama', undefined, 'qwen3:latest', {
        providerOptions: {
          ollama: { apiToken: 'tok_abc\r\nX-Injected: pwned' },
        },
      })
    ).toThrow(/CR\/LF\/NUL/);
    expect(capturedOpenAiCalls).toHaveLength(0);
  });

  it('rejects LM Studio explicit apiKey containing NUL bytes', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    expect(() =>
      createProvider('lmstudio', { apiKey: 'tok\0evil', kind: 'api_key' }, 'qwen2.5')
    ).toThrow(/CR\/LF\/NUL/);
    expect(capturedOpenAiCalls).toHaveLength(0);
  });
});
