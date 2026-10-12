/**
 * Desktop credential resolution (BST-1352): the typed `resolveProviderCredential`
 * reader the persona availability handler uses.
 */
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

import { resolveProviderCredential } from '../../assistant-server/provider-credentials';

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
