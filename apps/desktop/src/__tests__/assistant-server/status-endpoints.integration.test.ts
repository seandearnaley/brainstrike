/**
 * Status, OpenRouter model metadata, and suspended-runs endpoints (moved
 * verbatim from the pre-split assistant-server.integration.test.ts,
 * BST-1028 slice 2). Deliberate deltas from the monolith, exactly:
 * - the dead `vi.mock('../openai-api-key')` and its two
 *   `readOpenAIApiKey.mockResolvedValueOnce` reads are gone — that module is
 *   imported only by ipc-agent.ts, outside this graph, so the reads primed a
 *   mock nothing consumed (the missing-key test passes via listProviders: []);
 * - ALL mock defaults prime in beforeEach (slice-1 review lesson), including
 *   the memory-family stubs, so every test is independently runnable via -t
 *   and a future non-Once override cannot bleed forward;
 * - the `@brainstrike/agent` mock is narrowed to the two members these routes
 *   touch (listSuspendedMastraRuns + the provider allow-list);
 * - `../assistant-server/http` is NOT mocked: these routes write via
 *   res.setHeader/res.end/respondJson and never reach http.ts (streamResponse
 *   is referenced only from stream-resume.ts), so the real module is safe —
 *   unlike the monolith, whose status tests ran with writeHeaders stubbed;
 * - `getSecretsService` is a plain arrow, not a vi.fn (nothing asserts on it).
 * Kept as one-line stubs purely to hold the import graph narrow (the real
 * assistant-tools barrel is ~800 lines / 32 imports evaluated at module load):
 * mcp-loader, assistant-tools, workspace-text-file-reader. db-main stays
 * mocked because mastra-memory.ts still imports getDatabase directly (its
 * injection is the MemoryFactory slice of BST-972).
 */
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { desktopAssistantServerLogger, handleAssistantRequest } from '../../assistant-server';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
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

const mockListSuspendedMastraRuns = vi.hoisted(() => vi.fn());
const mockCreatePgliteMastraMemory = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local', 'ollama'].includes(provider),
    listSuspendedMastraRuns: mockListSuspendedMastraRuns,
  };
});

const mockPgliteMastraMemory = { id: 'desktop-memory' };
const mockPgliteMastraStorage = { id: 'desktop-storage' };
const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(),
};

vi.mock('@brainstrike/agent/pglite-mastra-memory', () => ({
  createPgliteMastraMemory: mockCreatePgliteMastraMemory,
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

vi.mock('../../mcp-loader', () => ({
  loadMcpConfig: vi.fn(() => Promise.resolve({ config: undefined })),
}));

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

vi.mock('../../assistant-server/workspace-text-file-reader', () => ({
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
}));

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  mockDesktopDatabase.query.mockReset().mockResolvedValue({ rows: [] });
  mockListSuspendedMastraRuns.mockReset().mockResolvedValue({ approvals: [], suspends: [] });
  mockCreatePgliteMastraMemory.mockReset().mockResolvedValue({
    memory: mockPgliteMastraMemory,
    storage: mockPgliteMastraStorage,
    store: {},
    vector: {},
    workflows: {},
  });
  resetDesktopMastraMemoryCacheForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
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

describe('suspended-runs endpoint', () => {
  it('GET /assistant/suspended-runs returns rediscovered approvals with recomputed risk + staleness', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    // NAME-FORM CONTRACT: `listSuspendedMastraRuns` returns the ORIGINAL
    // dotted tool name (it maps Mastra's registered/sanitized id back via the
    // runtime toolNameMap + the static native map) — the SAME form
    // `buildNativeToolRiskMap()` is keyed by. The live proof is
    // packages/agent/src/__tests__/mastra-suspended-runs-discovery.integration.spec.ts;
    // this mock must mirror that contract, never a sanitized id.
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [
        {
          args: { command: 'echo hi' },
          runId: 'run-restart-1',
          suspendedAt: new Date().toISOString(),
          toolCallId: 'call-restart-1',
          toolName: 'brainstrike.executeCommand',
        },
      ],
      suspends: [],
    });

    const response = await runRequest({
      headers: { 'content-type': 'application/json' },
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    expect(listSuspendedMastraRuns).toHaveBeenCalledWith(
      { resourceId: 'workspace-a', threadId: 'thread-1' },
      expect.objectContaining({
        runtime: expect.objectContaining({ provider: 'ollama' }),
        storage: mockPgliteMastraStorage,
      })
    );
    expect(createPgliteMastraMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySettings: {
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: false,
            retrievalMode: 'off',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: false,
          },
        },
      })
    );
    expect(mockSecretsService.getKey).not.toHaveBeenCalled();
    expect((createPgliteMastraMemory as Mock).mock.calls[0]?.[0]).not.toHaveProperty(
      'observationalMemoryModel'
    );
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      approvals: [
        {
          args: { command: 'echo hi' },
          policyDecision: 'ask',
          riskCategory: 'execute',
          runId: 'run-restart-1',
          stale: false,
          suspendedAt: expect.any(String),
          toolCallId: 'call-restart-1',
          toolName: 'brainstrike.executeCommand',
        },
      ],
      // BST-1084: the response additionally carries rediscovered suspend() pauses.
      suspends: [],
    });
  });

  it('GET /assistant/suspended-runs flags a run older than the staleness threshold', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [
        {
          runId: 'run-old-1',
          // Two days ago — beyond the 24h default BRAINSTRIKE_APPROVAL_STALE_MS.
          suspendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          toolCallId: 'call-old-1',
          toolName: 'brainstrike.writeWorkspaceFile',
        },
      ],
      suspends: [],
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.approvals[0]).toMatchObject({
      riskCategory: 'edit',
      stale: true,
      toolName: 'brainstrike.writeWorkspaceFile',
    });
  });

  it('GET /assistant/suspended-runs recomputes executionContext for a rediscovered run_python approval (BST-1070)', async () => {
    // The live approval's executionContext is a transient stream field — it is
    // never persisted. Rediscovery must RECOMPUTE it from the durable args
    // (exactly where riskCategory is recomputed), or every reloaded run_python
    // approval would render the degraded no-fact-rows card.
    const { listSuspendedMastraRuns, resolveRunPythonExecutionContext } = await import(
      '@brainstrike/agent'
    );
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [
        {
          args: { code: 'print(1)', timeoutMs: 45_000 },
          runId: 'run-python-restart-1',
          suspendedAt: new Date().toISOString(),
          toolCallId: 'call-python-restart-1',
          toolName: 'brainstrike.runPython',
        },
      ],
      suspends: [],
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.approvals[0]).toMatchObject({
      riskCategory: 'execute',
      toolName: 'brainstrike.runPython',
    });
    // Byte-identical to the live derivation — the same helper, the same args.
    expect(body.approvals[0].executionContext).toEqual(
      JSON.parse(
        JSON.stringify(resolveRunPythonExecutionContext({ code: 'print(1)', timeoutMs: 45_000 }))
      )
    );
    expect(body.approvals[0].executionContext.timeoutMs).toBe(45_000);
  });

  it('GET /assistant/suspended-runs omits executionContext when rediscovered run_python args do not parse', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [
        {
          // A bare "*" fails the seam's policyDomainSchema — unrestricted
          // egress stays inexpressible even on the rediscovery recompute.
          args: { allowedDomains: ['*'], code: 'print(1)' },
          runId: 'run-python-restart-2',
          suspendedAt: new Date().toISOString(),
          toolCallId: 'call-python-restart-2',
          toolName: 'brainstrike.runPython',
        },
      ],
      suspends: [],
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.approvals[0]).toMatchObject({ toolName: 'brainstrike.runPython' });
    expect(body.approvals[0]).not.toHaveProperty('executionContext');
  });

  it('GET /assistant/suspended-runs returns rediscovered suspend() pauses with payload + staleness (BST-1084)', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [],
      suspends: [
        {
          runId: 'run-suspend-restart-1',
          suspendedAt: new Date().toISOString(),
          suspendPayload: { question: 'Which region?' },
          toolCallId: 'call-suspend-restart-1',
          toolName: 'brainstrike.askUser',
        },
        {
          runId: 'run-suspend-restart-2',
          // Two days ago — beyond the 24h default staleness threshold.
          suspendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          suspendPayload: { overview: 'plan', steps: [], title: 'Plan' },
          toolCallId: 'call-suspend-restart-2',
          toolName: 'brainstrike.submitPlan',
        },
      ],
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.suspends).toHaveLength(2);
    expect(body.suspends[0]).toMatchObject({
      runId: 'run-suspend-restart-1',
      stale: false,
      suspendPayload: { question: 'Which region?' },
      toolCallId: 'call-suspend-restart-1',
      toolName: 'brainstrike.askUser',
    });
    // Registered suspend UI => no resumeSupported flag (omitted means resumable).
    expect(body.suspends[0]).not.toHaveProperty('resumeSupported');
    expect(body.suspends[1]).toMatchObject({ stale: true, toolName: 'brainstrike.submitPlan' });
  });

  it('GET /assistant/suspended-runs caps suspends at the newest 10 with a logged truncation (#2223)', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    const suspends = Array.from({ length: 12 }, (_, index) => ({
      runId: `run-cap-${index}`,
      // Oldest-first, matching discovery's sort contract.
      suspendedAt: new Date(Date.now() - (12 - index) * 60_000).toISOString(),
      suspendPayload: { question: `q${index}` },
      toolCallId: `call-cap-${index}`,
      toolName: 'brainstrike.askUser',
    }));
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({ approvals: [], suspends });
    const warnSpy = vi.spyOn(desktopAssistantServerLogger, 'warn').mockImplementation(() => {
      // Silence expected warning output.
    });

    try {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      // Newest 10 kept: the two OLDEST are dropped.
      expect(body.suspends).toHaveLength(10);
      expect(body.suspends[0]).toMatchObject({ runId: 'run-cap-2' });
      expect(body.suspends[9]).toMatchObject({ runId: 'run-cap-11' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          code: 'assistant_suspended_pause_cap_applied',
          droppedCount: 2,
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('GET /assistant/suspended-runs flags an UNREGISTERED suspend as resumeSupported:false instead of dropping it', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [],
      suspends: [
        {
          runId: 'run-suspend-unreg-1',
          suspendedAt: new Date().toISOString(),
          suspendPayload: { question: 'why?' },
          toolCallId: 'call-suspend-unreg-1',
          toolName: 'brainstrike.someFutureSuspendingTool',
        },
      ],
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    // Same honesty contract as the LIVE path: the pause surfaces (the renderer
    // shows the dead-end notice), never a silent drop.
    expect(body.suspends).toHaveLength(1);
    expect(body.suspends[0]).toMatchObject({
      resumeSupported: false,
      toolName: 'brainstrike.someFutureSuspendingTool',
    });
  });

  it('GET /assistant/suspended-runs omits riskCategory for a tool absent from the risk map and warns LOUDLY', async () => {
    // An MCP (or no-longer-registered) tool has no entry in
    // buildNativeToolRiskMap(): the response must omit riskCategory /
    // policyDecision HONESTLY (the notice then renders no grant buttons) and
    // the degradation must be observable — never a silent metadata drop.
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
      approvals: [
        {
          args: { query: 'hello' },
          runId: 'run-mcp-1',
          suspendedAt: new Date().toISOString(),
          toolCallId: 'call-mcp-1',
          toolName: 'someServer.someTool',
        },
      ],
      suspends: [],
    });
    const warnSpy = vi.spyOn(desktopAssistantServerLogger, 'warn').mockImplementation(() => {
      // Silence expected warning output.
    });

    try {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.approvals[0]).toMatchObject({ toolName: 'someServer.someTool' });
      expect(body.approvals[0]).not.toHaveProperty('riskCategory');
      expect(body.approvals[0]).not.toHaveProperty('policyDecision');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          code: 'assistant_suspended_approval_risk_unresolved',
          toolName: 'someServer.someTool',
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('GET /assistant/suspended-runs returns 400 when thread context is missing', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?resourceId=workspace-a',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('missing_thread_context');
    expect(listSuspendedMastraRuns).not.toHaveBeenCalled();
  });

  it('GET /assistant/suspended-runs returns 503 when workflow storage is unavailable', async () => {
    const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    (createPgliteMastraMemory as Mock).mockResolvedValueOnce({
      memory: mockPgliteMastraMemory,
      store: {},
      vector: {},
      workflows: {},
    });

    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toBe('tool_approval_storage_unavailable');
    expect(listSuspendedMastraRuns).not.toHaveBeenCalled();
  });
});
