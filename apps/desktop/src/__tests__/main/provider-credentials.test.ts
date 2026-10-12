/**
 * Assistant-server credential resolution (BST-1352): the typed
 * `resolveProviderCredential` reader and the string `resolveProviderApiKey`
 * migration shim built on it. The string surface must keep the EXACT
 * pre-BST-1352 observable behavior: env/stored keys resolve to strings, and a
 * stored non-api_key credential surfaces as the SecretReadError-shaped
 * `credential_type_unsupported` failure (never a stringified credential,
 * never a silent "not configured").
 */
import { matchSecretReadError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockReadProviderCredential = vi.hoisted(() => vi.fn());

vi.mock('../../assistant-server/logger', () => ({
  desktopAssistantServerLogger: logger,
}));

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    isSupportedProvider: (value: string) => ['openai', 'anthropic', 'ollama'].includes(value),
  };
});

vi.mock('../../provider-api-key', () => ({
  inspectProviderKeys: vi.fn(),
  readProviderCredential: (provider: string) => mockReadProviderCredential(provider),
  readProviderSecretKey: vi.fn(),
  resolveProviderEnvKey: vi.fn(),
}));

import {
  resolveProviderApiKey,
  resolveProviderCredential,
} from '../../assistant-server/provider-credentials';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveProviderCredential (typed reader)', () => {
  it('returns undefined for unsupported providers without reading anything', async () => {
    await expect(resolveProviderCredential('not-a-provider')).resolves.toBeUndefined();
    expect(mockReadProviderCredential).not.toHaveBeenCalled();
  });

  it('passes through an env api_key credential and logs the env source line', async () => {
    mockReadProviderCredential.mockResolvedValue({
      key: 'env-key',
      source: 'env',
      type: 'api_key',
    });
    await expect(resolveProviderCredential('openai')).resolves.toEqual({
      key: 'env-key',
      source: 'env',
      type: 'api_key',
    });
    expect(logger.info).toHaveBeenCalledWith('Using environment API key for provider', {
      provider: 'openai',
    });
  });

  it('passes through a stored credential and logs the stored source line', async () => {
    mockReadProviderCredential.mockResolvedValue({
      key: 'stored-key',
      source: 'stored',
      type: 'api_key',
    });
    await expect(resolveProviderCredential('anthropic')).resolves.toEqual({
      key: 'stored-key',
      source: 'stored',
      type: 'api_key',
    });
    expect(logger.info).toHaveBeenCalledWith('Retrieved stored API key for provider', {
      provider: 'anthropic',
    });
  });

  it('returns undefined when nothing is configured', async () => {
    mockReadProviderCredential.mockResolvedValue(undefined);
    await expect(resolveProviderCredential('openai')).resolves.toBeUndefined();
  });
});

describe('resolveProviderApiKey (string migration shim over the typed reader)', () => {
  it('projects api_key credentials to the key string', async () => {
    mockReadProviderCredential.mockResolvedValue({
      key: 'the-key',
      source: 'env',
      type: 'api_key',
    });
    await expect(resolveProviderApiKey('openai')).resolves.toBe('the-key');
  });

  it('throws the credential_type_unsupported SecretReadError shape for a stored oauth credential', async () => {
    // Pre-BST-1352 this came from SecretsService.getKey; the shim must keep
    // the same structural classification (matchSecretReadError) so the HTTP
    // path still maps it to the api_key_unreadable 400.
    mockReadProviderCredential.mockResolvedValue({
      access: 'secret-access',
      expires: 1,
      refresh: 'secret-refresh',
      source: 'stored',
      type: 'oauth',
    });
    let thrown: unknown;
    try {
      await resolveProviderApiKey('anthropic');
    } catch (error) {
      thrown = error;
    }
    const match = matchSecretReadError(thrown);
    expect(match).toMatchObject({ code: 'credential_type_unsupported', provider: 'anthropic' });
    expect((thrown as Error).message).not.toContain('secret-access');
  });

  it('returns undefined when nothing is configured', async () => {
    mockReadProviderCredential.mockResolvedValue(undefined);
    await expect(resolveProviderApiKey('openai')).resolves.toBeUndefined();
  });
});
