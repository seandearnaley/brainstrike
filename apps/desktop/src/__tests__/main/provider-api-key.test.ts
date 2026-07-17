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

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => logger,
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => logger,
}));

vi.mock('@brainstrike/agent', () => ({
  isSupportedProvider: (value: string) => mockIsSupportedProvider(value),
}));

vi.mock('../../agent-client-loader', () => ({
  getAgentProviderEnvKeys: (provider: string) => mockGetAgentProviderEnvKeys(provider),
  listAgentProviders: () => mockListAgentProviders(),
}));

vi.mock('../../secrets', () => ({
  getSecretsService: () => mockGetSecretsService(),
}));

import {
  listConfiguredProviders,
  readProviderApiKey,
  readProviderSecretKey,
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
  });

  it('reads provider secret key and logs errors on failure', async () => {
    const secrets = {
      getKey: vi.fn().mockResolvedValue('  secret  '),
    };
    mockGetSecretsService.mockReturnValue(secrets);

    await expect(readProviderSecretKey('openai')).resolves.toBe('secret');

    secrets.getKey.mockRejectedValueOnce(new Error('boom'));
    await expect(readProviderSecretKey('openai')).resolves.toBeUndefined();
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

    const providers = await listConfiguredProviders();
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });
});
