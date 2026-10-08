import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import { DESKTOP_DEV_RENDERER_URL } from '../../desktop-renderer-url';
import { createRunRequest } from './_harness';

const desktopRendererOrigin = new URL(DESKTOP_DEV_RENDERER_URL).origin;

const mockSecretsService = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  // BST-1352: assistant POST + OpenRouter metadata read the TYPED credential.
  getCredential: vi.fn((_provider: string) =>
    Promise.resolve({ key: 'test-api-key', type: 'api_key' as const })
  ),
  getKey: vi.fn((_provider: string) => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
}));

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: () => mockSecretsService,
  };
});

vi.mock('../../agent-client-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-client-loader')>();
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
});

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local', 'ollama'].includes(provider),
  };
});

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('status endpoint', () => {
  it('should handle status route with API key present', async () => {
    mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);
    mockSecretsService.getKey.mockResolvedValueOnce('test-key');

    const response = await runRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
    expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    const data = JSON.parse(response.body) as { enabled: boolean; providers: string[] };
    // 'local' provider is always available (no API key required)
    expect(data).toEqual({
      enabled: true,
      providerKeySources: [{ provider: 'openai', source: 'stored' }],
      providers: ['openai', 'local'],
    });
  }, 10_000);

  it('reports an unreadable provider key without disabling other providers', async () => {
    const { SecretReadError } = await import('../../secrets');
    mockSecretsService.listProviders.mockResolvedValueOnce(['openrouter']);
    // BST-1352: availability inspection reads the TYPED credential.
    mockSecretsService.getCredential.mockRejectedValueOnce(
      new SecretReadError('encryption_unavailable', 'openrouter')
    );

    const response = await runRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      enabled: true,
      providerErrors: [
        {
          code: 'encryption_unavailable',
          error: 'api_key_unreadable',
          message:
            'Secret for "openrouter" is unreadable: safeStorage encryption is unavailable or insecure on this system. Re-enter the key to repair it.',
          provider: 'openrouter',
        },
      ],
      providerKeySources: [],
      providers: ['local'],
    });
  });

  it('surfaces environment-file failures without partial provider availability', async () => {
    mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
      },
      {
        envFileFailures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message: 'Desktop environment file dev-local is invalid at line 2.',
          },
        ],
      }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      enabled: false,
      envFileFailures: [
        {
          code: 'env_file_invalid',
          file: 'dev-local',
          message: 'Desktop environment file dev-local is invalid at line 2.',
        },
      ],
      error: 'assistant_configuration_invalid',
      message: 'Desktop environment configuration is invalid.',
      providers: [],
    });
    expect(mockSecretsService.listProviders).not.toHaveBeenCalled();
  });

  it('reports deprecated env-var renames computed by desktop main (BST-1361)', async () => {
    mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);
    mockSecretsService.getKey.mockResolvedValueOnce('test-key');

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
      },
      {
        deprecatedEnvVars: [
          { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
      }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      deprecatedEnvVars: [
        { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      ],
      enabled: true,
      providerKeySources: [{ provider: 'openai', source: 'stored' }],
      providers: ['openai', 'local'],
    });
  });

  it('omits the deprecated env-var field entirely when nothing deprecated is set', async () => {
    mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);
    mockSecretsService.getKey.mockResolvedValueOnce('test-key');

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
      },
      { deprecatedEnvVars: [] }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).not.toHaveProperty('deprecatedEnvVars');
  });

  it('keeps deprecated env-var reports on the env-file-failure payload (BST-1361 review 5)', async () => {
    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
      },
      {
        deprecatedEnvVars: [
          { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ],
        envFileFailures: [
          {
            code: 'env_file_invalid',
            file: 'dev-local',
            message: 'Desktop environment file dev-local is invalid at line 2.',
          },
        ],
      }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      deprecatedEnvVars: [
        { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      ],
      enabled: false,
      envFileFailures: [
        {
          code: 'env_file_invalid',
          file: 'dev-local',
          message: 'Desktop environment file dev-local is invalid at line 2.',
        },
      ],
      error: 'assistant_configuration_invalid',
      message: 'Desktop environment configuration is invalid.',
      providers: [],
    });
  });

  it('should handle status route with query parameters', async () => {
    const response = await runRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'GET',
      url: '/assistant/status?source=healthcheck',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
  });

  it('should handle status route with missing API key', async () => {
    mockSecretsService.listProviders.mockResolvedValueOnce([]);

    const response = await runRequest({ method: 'GET', url: '/status' });

    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as { enabled: boolean; providers: string[] };
    // 'local' provider is always available (no API key required)
    expect(data).toEqual({
      enabled: true,
      providerKeySources: [],
      providers: ['local'],
    });
  }, 10_000);

  it('keeps other providers available when the legacy OpenAI key is unreadable', async () => {
    const { SecretReadError } = await import('../../secrets');
    mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);
    // BST-1352: availability inspection reads the TYPED credential.
    mockSecretsService.getCredential.mockRejectedValueOnce(
      new SecretReadError('decrypt_failed', 'openai')
    );

    const response = await runRequest({ method: 'GET', url: '/status' });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      enabled: true,
      providerErrors: [
        {
          error: 'api_key_unreadable',
          provider: 'openai',
        },
      ],
      providerKeySources: [],
      providers: ['local'],
    });
  });

  it('should handle status route errors', async () => {
    mockSecretsService.listProviders.mockRejectedValueOnce(new Error('API key read failed'));

    const response = await runRequest({ method: 'GET', url: '/status' });

    expect(response.status).toBe(500);
    const data = JSON.parse(response.body) as { error: string; message: string };
    expect(data).toEqual({
      error: 'assistant_status_failed',
      message: 'Assistant status unavailable.',
    });
    expect(response.body).not.toContain('API key read failed');
  }, 10_000);
});

describe('OpenRouter model metadata endpoint', () => {
  it('returns selected OpenRouter model metadata from the bounded service', async () => {
    mockSecretsService.getCredential.mockResolvedValueOnce({
      key: 'openrouter-key',
      type: 'api_key',
    });
    const get = vi.fn().mockResolvedValue({
      freshness: 'live',
      metadata: {
        checkedAt: 1000,
        contextWindow: 400_000,
        id: 'openai/gpt-5.4-mini',
        maxOutputTokens: 128_000,
        source: 'openrouter-models-api',
        supportedParameters: ['tools', 'reasoning'],
      },
    });

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/openrouter-model?model=openai%2Fgpt-5.4-mini',
      },
      { openRouterModelMetadataService: { get } }
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toMatchObject({
      freshness: 'live',
      metadata: { id: 'openai/gpt-5.4-mini' },
    });
    expect(get).toHaveBeenCalledWith('openai/gpt-5.4-mini', 'openrouter-key');
  });

  it('surfaces an unreadable OpenRouter key without calling the metadata service', async () => {
    const { SecretReadError } = await import('../../secrets');
    mockSecretsService.getCredential.mockRejectedValueOnce(
      new SecretReadError('decrypt_failed', 'openrouter')
    );
    const get = vi.fn();

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/openrouter-model?model=openai%2Fgpt-5.4-mini',
      },
      { openRouterModelMetadataService: { get } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      message:
        'Secret for "openrouter" is unreadable: stored secret could not be decrypted (the OS keychain entry may have changed). Re-enter the key to repair it.',
      provider: 'openrouter',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects an OpenRouter metadata request without an exact model id', async () => {
    const get = vi.fn();
    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/openrouter-model',
      },
      { openRouterModelMetadataService: { get } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'missing_model',
      message: 'OpenRouter model metadata requires a model query parameter.',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('classifies a malformed OpenRouter model id as a client error', async () => {
    const get = vi.fn();
    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/openrouter-model?model=garbage',
      },
      { openRouterModelMetadataService: { get } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'invalid_model',
      message: 'OpenRouter model id must use the provider/model form',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('surfaces OpenRouter metadata failures without a static silent fallback', async () => {
    mockSecretsService.getCredential.mockResolvedValueOnce({
      key: 'openrouter-key',
      type: 'api_key',
    });
    const get = vi.fn().mockRejectedValue(new Error('OpenRouter Models API returned status 503'));
    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/openrouter-model?model=openai%2Fgpt-5.4-mini',
      },
      { openRouterModelMetadataService: { get } }
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: 'openrouter_model_metadata_failed',
      message: 'OpenRouter Models API returned status 503',
    });
  });
});

describe('verify-provider endpoint', () => {
  it('returns the verification snapshot from the injected service', async () => {
    const verify = vi.fn().mockResolvedValue({
      freshness: 'live',
      result: { checkedAt: '2026-08-18T12:00:00.000Z', status: 'verified' },
    });

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=openai',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      freshness: 'live',
      result: { checkedAt: '2026-08-18T12:00:00.000Z', status: 'verified' },
    });
    expect(verify).toHaveBeenCalledWith('openai');
  });

  it('rejects a request without a provider query parameter', async () => {
    const verify = vi.fn();
    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'missing_provider',
      message: 'Provider verification requires a provider query parameter.',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider id with 400', async () => {
    const { UnknownVerificationProviderError } = await import(
      '../../assistant-server/provider-verification'
    );
    const verify = vi.fn().mockRejectedValue(new UnknownVerificationProviderError());

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=not-a-provider',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'unknown_provider',
      message: 'Provider id is not a verifiable provider.',
    });
  });

  it('rejects a provider without a configured credential with 400', async () => {
    const { MissingProviderCredentialError } = await import(
      '../../assistant-server/provider-verification'
    );
    const verify = vi.fn().mockRejectedValue(new MissingProviderCredentialError('anthropic'));

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=anthropic',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'missing_api_key',
      message: 'No credential configured for provider "anthropic".',
    });
  });

  it('surfaces an unreadable stored credential as the classified secret error', async () => {
    const { SecretReadError } = await import('../../secrets');
    const verify = vi.fn().mockRejectedValue(new SecretReadError('decrypt_failed', 'openai'));

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=openai',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      provider: 'openai',
    });
  });

  it('never leaks the stored key into the response payload (real service, mocked fetch)', async () => {
    const { createProviderVerificationService } = await import(
      '../../assistant-server/provider-verification'
    );
    const fakeKey = 'sk-super-secret-endpoint-key';
    const service = createProviderVerificationService({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })),
      readCredential: () => Promise.resolve({ key: fakeKey, type: 'api_key' }),
    });

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=openai',
      },
      { providerVerificationService: service }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      freshness: 'live',
      result: { status: 'verified' },
    });
    expect(response.body).not.toContain(fakeKey);
  });

  it('reports unexpected verification failures as a bounded 500', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('probe wiring exploded'));

    const response = await runRequest(
      {
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/verify-provider?provider=openai',
      },
      { providerVerificationService: { verify } }
    );

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'verify_provider_failed',
      message: 'probe wiring exploded',
    });
  });
});
