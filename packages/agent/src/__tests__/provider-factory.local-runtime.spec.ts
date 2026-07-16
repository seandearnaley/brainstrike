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

describe('provider-factory local-runtime endpoint overrides', () => {
  beforeEach(() => {
    capturedOpenAiCalls.length = 0;
    fakeProvider.mockClear();
  });

  it('returns Mastra OpenAI-compatible config for Ollama', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('ollama', undefined, 'qwen3:latest');

    expect(capturedOpenAiCalls).toHaveLength(0);
    // The dummy `apiKey: 'ollama'` is intentional: it suppresses the
    // compatible adapter's `OPENAI_API_KEY` env-var fallback so we never leak a real
    // OpenAI key to a (potentially remote) Ollama host.
    expect(model).toEqual({
      apiKey: 'ollama',
      id: 'ollama/qwen3:latest',
      url: 'http://127.0.0.1:11434/v1',
    });
  });

  it('returns Mastra OpenAI-compatible config for LM Studio', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('lmstudio', undefined, 'qwen2.5');

    expect(capturedOpenAiCalls).toHaveLength(0);
    expect(model).toEqual({
      apiKey: 'lmstudio',
      id: 'lmstudio/qwen2.5',
      url: 'http://127.0.0.1:1234/v1',
    });
  });

  it('normalizes the Ollama URL and forwards apiToken from runtime options', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('ollama', undefined, 'qwen3:latest', {
      providerOptions: {
        ollama: {
          apiToken: 'tok_abc',
          baseUrl: 'https://gpu.lan:11434/v1/',
        },
      },
    });

    expect(model).toEqual({
      apiKey: 'tok_abc',
      id: 'ollama/qwen3:latest',
      url: 'https://gpu.lan:11434/v1',
    });
  });

  it('prefers explicit apiKey argument over runtime-option apiToken', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('lmstudio', 'from-arg', 'qwen2.5', {
      providerOptions: {
        lmstudio: { apiToken: 'from-runtime' },
      },
    });

    expect(model).toEqual({
      apiKey: 'from-arg',
      id: 'lmstudio/qwen2.5',
      url: 'http://127.0.0.1:1234/v1',
    });
  });

  it('accepts host:port shorthand and canonicalizes the baseURL', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('ollama', undefined, 'qwen3:latest', {
      providerOptions: {
        ollama: { baseUrl: 'remote.box:11434' },
      },
    });

    expect(model).toEqual({
      apiKey: 'ollama',
      id: 'ollama/qwen3:latest',
      url: 'http://remote.box:11434/v1',
    });
  });

  it('does NOT forward OPENAI_API_KEY env var to a remote Ollama host', async () => {
    // Regression guard for the env-var leak: a user with `OPENAI_API_KEY` set
    // and a remote `baseUrl` configured for Ollama would, prior to this fix,
    // implicitly forward their OpenAI key as a `Bearer` header to the remote
    // host. The dummy `apiKey: 'ollama'` substitution prevents the SDK from
    // ever consulting `process.env.OPENAI_API_KEY`.
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-real-secret-do-not-leak';
    try {
      const { createProvider } = await import('../providers/provider-factory');
      const model = createProvider('ollama', undefined, 'qwen3:latest', {
        providerOptions: { ollama: { baseUrl: 'https://gpu.lan:11434' } },
      });
      expect(model).toEqual({
        apiKey: 'ollama',
        id: 'ollama/qwen3:latest',
        url: 'https://gpu.lan:11434/v1',
      });
    } finally {
      // Restore prior env state. Assigning `undefined` is preferred over
      // `delete` (lint rule `noDelete`); it produces an equivalent
      // `process.env.OPENAI_API_KEY === undefined` for downstream lookups.
      process.env.OPENAI_API_KEY = previousKey;
    }
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

    expect(() => createProvider('lmstudio', 'tok\0evil', 'qwen2.5')).toThrow(/CR\/LF\/NUL/);
    expect(capturedOpenAiCalls).toHaveLength(0);
  });
});
