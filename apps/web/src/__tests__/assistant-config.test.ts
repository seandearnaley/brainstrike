import { providerEnvKeys } from '@brainstrike/agent/hosted-web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAssistantApiKey,
  HOSTED_WEB_ASSISTANT_PROVIDERS,
  resolveAssistantProviderConfig,
  resolveAssistantProviderConfigs,
  resolveHostedWebAssistantStatus,
} from '../server/assistant-config';

const ENV_KEYS = [...new Set(HOSTED_WEB_ASSISTANT_PROVIDERS.flatMap(providerEnvKeys))];

const clearApiKeys = (): void => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
};

const originalValues = new Map<string, string | undefined>();

const snapshotApiKeys = (): void => {
  originalValues.clear();
  for (const key of ENV_KEYS) {
    originalValues.set(key, process.env[key]);
  }
};

const restoreApiKeys = (): void => {
  for (const key of ENV_KEYS) {
    const value = originalValues.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
};

describe('assistant-config', () => {
  beforeEach(() => {
    snapshotApiKeys();
    clearApiKeys();
  });

  afterEach(() => {
    restoreApiKeys();
  });

  it('uses the canonical registry precedence within a provider', () => {
    process.env['OPENAI_API_KEY'] = 'openai';
    process.env['BS_OPENAI_API_KEY'] = 'bs';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'brainstrike';

    const result = resolveAssistantProviderConfig('openai');
    expect(result).toEqual({
      apiKey: 'brainstrike',
      enabled: true,
      provider: 'openai',
      source: 'BRAINSTRIKE_OPENAI_API_KEY',
    });
    expect(getAssistantApiKey('openai')).toBe('brainstrike');
  });

  it('trims env values and skips empty strings', () => {
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '   ';
    process.env['BS_OPENAI_API_KEY'] = '  bs-key  ';

    const result = resolveAssistantProviderConfig('openai');
    expect(result).toEqual({
      apiKey: 'bs-key',
      enabled: true,
      provider: 'openai',
      source: 'BS_OPENAI_API_KEY',
    });
  });

  it('discovers all configured Hosted Web providers in stable picker order', () => {
    process.env['OPENROUTER_API_KEY'] = ' openrouter ';
    process.env['GOOGLE_API_KEY'] = 'google';
    process.env['ANTHROPIC_API_KEY'] = 'anthropic';
    process.env['OPENAI_API_KEY'] = 'openai';

    expect(HOSTED_WEB_ASSISTANT_PROVIDERS).toEqual(['openai', 'anthropic', 'google', 'openrouter']);
    expect(resolveAssistantProviderConfigs()).toEqual([
      {
        apiKey: 'openai',
        enabled: true,
        provider: 'openai',
        source: 'OPENAI_API_KEY',
      },
      {
        apiKey: 'anthropic',
        enabled: true,
        provider: 'anthropic',
        source: 'ANTHROPIC_API_KEY',
      },
      {
        apiKey: 'google',
        enabled: true,
        provider: 'google',
        source: 'GOOGLE_API_KEY',
      },
      {
        apiKey: 'openrouter',
        enabled: true,
        provider: 'openrouter',
        source: 'OPENROUTER_API_KEY',
      },
    ]);
    const status = resolveHostedWebAssistantStatus();
    expect(status).toEqual({
      enabled: true,
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providerKeySources: [
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic', source: 'env' },
        { envVar: 'GOOGLE_API_KEY', provider: 'google', source: 'env' },
        { envVar: 'OPENROUTER_API_KEY', provider: 'openrouter', source: 'env' },
      ],
      providers: ['openai', 'anthropic', 'google', 'openrouter'],
    });
    expect(JSON.stringify(status)).not.toContain('apiKey');
  });

  it('rejects a resolver result whose provider does not match the requested credential', () => {
    expect(() =>
      resolveAssistantProviderConfigs((provider) => ({
        apiKey: `${provider}-key`,
        enabled: true,
        provider: provider === 'openai' ? 'anthropic' : provider,
        source: provider === 'openai' ? 'ANTHROPIC_API_KEY' : `${provider.toUpperCase()}_API_KEY`,
      }))
    ).toThrowError('Hosted Web provider resolver returned anthropic for openai');
  });

  it('returns provider-specific disabled config when no key is available', () => {
    clearApiKeys();

    const result = resolveAssistantProviderConfig('anthropic');
    expect(result).toEqual({
      disabledReason: 'missing_api_key',
      enabled: false,
      provider: 'anthropic',
    });
    expect(getAssistantApiKey('anthropic')).toBeUndefined();
  });
});
