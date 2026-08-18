import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSONA_PIN_KEYLESS_PROVIDERS } from '../mastra/persona-pinned-model';
import { resolveRuntimeConfiguration } from '../mastra/runtime-configuration';
import { listProviders, providerAuthType, providerEnvKeys } from '../providers/types';

const KEYLESS_PROVIDERS = listProviders()
  .filter((provider) => provider.authType === 'none')
  .map((provider) => provider.id);

describe('runtime configuration keyless providers (BST-1349)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives exactly local, ollama, and lmstudio as keyless from the registry', () => {
    expect([...KEYLESS_PROVIDERS].sort()).toEqual(['lmstudio', 'local', 'ollama']);
  });

  it.each(KEYLESS_PROVIDERS)('%s resolves with an empty api key', (provider) => {
    const resolved = resolveRuntimeConfiguration({ provider });
    expect(resolved.apiKey).toBe('');
    expect(resolved.provider).toBe(provider);
  });

  it('still requires an api key for every api_key provider', () => {
    for (const provider of listProviders()) {
      if (providerAuthType(provider.id) !== 'api_key') {
        continue;
      }
      // Blank out env discovery so a developer machine's real keys cannot
      // turn this into a false green.
      for (const envKey of providerEnvKeys(provider.id)) {
        vi.stubEnv(envKey, '');
      }
      expect(
        () => resolveRuntimeConfiguration({ provider: provider.id }),
        `${provider.id} must throw without a key`
      ).toThrowError(/missing_api_key/);
      expect(
        resolveRuntimeConfiguration({ apiKey: 'runtime-key', provider: provider.id }).apiKey
      ).toBe('runtime-key');
    }
  });

  it('persona pin keyless providers derive from the registry authType', () => {
    expect([...PERSONA_PIN_KEYLESS_PROVIDERS].sort()).toEqual([...KEYLESS_PROVIDERS].sort());
  });
});
