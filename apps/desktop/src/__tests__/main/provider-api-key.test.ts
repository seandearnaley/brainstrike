import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockGetAgentProviderEnvKeys = vi.hoisted(() => vi.fn());
const mockListAgentProviders = vi.hoisted(() => vi.fn());
const mockGetSecretsService = vi.hoisted(() => vi.fn());
const mockIsSupportedProvider = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => logger,
}));

vi.mock('@brainstrike/agent', () => ({
  isSupportedProvider: (value: string) => mockIsSupportedProvider(value),
}));

vi.mock('../../agent-client-loader', () => ({
  getAgentProviderEnvKeys: (provider: string) => mockGetAgentProviderEnvKeys(provider),
  listAgentProviders: () => mockListAgentProviders(),
}));

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: () => mockGetSecretsService(),
  };
});

import {
  inspectProviderKeys,
  listConfiguredProviders,
  readProviderApiKey,
  readProviderSecretKey,
  resolveProviderEnvCredential,
  resolveProviderEnvKey,
} from '../../provider-api-key';

describe('provider-api-key', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves provider env keys in order', () => {
    mockGetAgentProviderEnvKeys.mockReturnValue(['KEY_ONE', 'KEY_TWO']);
    process.env['KEY_TWO'] = '  token  ';

    expect(resolveProviderEnvKey('openai')).toBe('token');
    expect(resolveProviderEnvCredential('openai')).toEqual({
      envVar: 'KEY_TWO',
      value: 'token',
    });
  });

  it('reads provider secret key and preserves read failures', async () => {
    const secrets = {
      getKey: vi.fn().mockResolvedValue('  secret  '),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(readProviderSecretKey('openai')).resolves.toBe('secret');

    const readError = new Error('boom');
    secrets.getKey.mockRejectedValueOnce(readError);
    await expect(readProviderSecretKey('openai')).rejects.toBe(readError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('prefers env key over secrets', async () => {
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
    process.env['OPENAI_KEY'] = 'env-key';

    const secrets = {
      getKey: vi.fn().mockResolvedValue('secret-key'),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(readProviderApiKey('openai')).resolves.toBe('env-key');
    expect(secrets.getKey).not.toHaveBeenCalled();
  });

  it('lists configured providers from env and secrets', async () => {
    mockListAgentProviders.mockReturnValue(['openai', 'anthropic']);
    mockGetAgentProviderEnvKeys.mockImplementation((provider: string) =>
      provider === 'openai' ? ['OPENAI_KEY'] : ['ANTHROPIC_KEY']
    );
    process.env['OPENAI_KEY'] = 'env-openai';

    const secrets = {
      getKey: vi.fn().mockResolvedValue(' secret '),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'unknown']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    mockIsSupportedProvider.mockImplementation((value: string) => value === 'anthropic');

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [
        { envVar: 'OPENAI_KEY', provider: 'openai', source: 'env' },
        { provider: 'anthropic', source: 'stored' },
      ],
      readFailures: [],
    });

    const providers = await listConfiguredProviders();
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });

  it('does not inspect a stale stored key when an env key is authoritative', async () => {
    mockListAgentProviders.mockReturnValue(['openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENAI_KEY']);
    process.env['OPENAI_KEY'] = 'env-openai';

    const secrets = {
      getKey: vi.fn().mockRejectedValue(new Error('stale stored key')),
      listProviders: vi.fn().mockResolvedValue(['openai']),
    };
    mockGetSecretsService.mockReturnValue(secrets);
    mockIsSupportedProvider.mockReturnValue(true);

    await expect(inspectProviderKeys()).resolves.toEqual({
      configuredProviders: [{ envVar: 'OPENAI_KEY', provider: 'openai', source: 'env' }],
      readFailures: [],
    });
    expect(secrets.getKey).not.toHaveBeenCalled();
  });

  it('degrades a stored typed (non-api_key) credential to a per-provider read failure', async () => {
    // Consequence (a) of getKey throwing SecretReadError(credential_type_unsupported)
    // instead of a plain Error: inspectProviderKeys must keep listing the
    // provider whose stored api_key IS readable and report the typed-credential
    // provider as a readFailure — never abort the whole inspection.
    mockListAgentProviders.mockReturnValue(['anthropic', 'openai']);
    mockGetAgentProviderEnvKeys.mockReturnValue([]);
    mockIsSupportedProvider.mockReturnValue(true);

    const { SecretReadError } = await import('../../secrets');
    const secrets = {
      getKey: vi.fn((provider: string) =>
        provider === 'anthropic'
          ? Promise.reject(new SecretReadError('credential_type_unsupported', 'anthropic'))
          : Promise.resolve('sk-openai')
      ),
      listProviders: vi.fn().mockResolvedValue(['anthropic', 'openai']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(inspectProviderKeys()).resolves.toMatchObject({
      configuredProviders: [{ provider: 'openai', source: 'stored' }],
      readFailures: [{ code: 'credential_type_unsupported', provider: 'anthropic' }],
    });
  });

  it('reports one unreadable-key failure for duplicate stored provider ids', async () => {
    mockListAgentProviders.mockReturnValue(['openrouter']);
    mockGetAgentProviderEnvKeys.mockReturnValue(['OPENROUTER_API_KEY']);
    mockIsSupportedProvider.mockReturnValue(true);

    const { SecretReadError } = await import('../../secrets');
    const secrets = {
      getKey: vi.fn().mockRejectedValue(new SecretReadError('decrypt_failed', 'openrouter')),
      listProviders: vi.fn().mockResolvedValue(['openrouter', 'openrouter']),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(inspectProviderKeys()).resolves.toMatchObject({
      configuredProviders: [],
      readFailures: [{ code: 'decrypt_failed', provider: 'openrouter' }],
    });
    expect(secrets.getKey).toHaveBeenCalledTimes(1);
  });
});
