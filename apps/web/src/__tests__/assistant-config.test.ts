import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAssistantApiKey, resolveAssistantProviderConfig } from '../server/assistant-config';

const ENV_KEYS = ['BRAINSTRIKE_OPENAI_API_KEY', 'BS_OPENAI_API_KEY', 'OPENAI_API_KEY'] as const;

const clearApiKeys = (): void => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
};

const originalValues = new Map<(typeof ENV_KEYS)[number], string | undefined>();

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

  it('prefers BRAINSTRIKE_OPENAI_API_KEY over other keys', () => {
    process.env['OPENAI_API_KEY'] = 'openai';
    process.env['BS_OPENAI_API_KEY'] = 'bs';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'brainstrike';

    const result = resolveAssistantProviderConfig();
    expect(result).toEqual({
      apiKey: 'brainstrike',
      enabled: true,
      source: 'BRAINSTRIKE_OPENAI_API_KEY',
    });
    expect(getAssistantApiKey()).toBe('brainstrike');
  });

  it('trims env values and skips empty strings', () => {
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = '   ';
    process.env['BS_OPENAI_API_KEY'] = '  bs-key  ';

    const result = resolveAssistantProviderConfig();
    expect(result).toEqual({
      apiKey: 'bs-key',
      enabled: true,
      source: 'BS_OPENAI_API_KEY',
    });
  });

  it('returns disabled config when no key is available', () => {
    clearApiKeys();

    const result = resolveAssistantProviderConfig();
    expect(result).toEqual({
      disabledReason: 'missing_api_key',
      enabled: false,
    });
    expect(getAssistantApiKey()).toBeUndefined();
  });
});
