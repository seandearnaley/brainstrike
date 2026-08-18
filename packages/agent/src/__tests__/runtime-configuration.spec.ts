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

describe('runtime configuration auth input (BST-1352)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('an api_key auth input is authoritative and lands on both apiKey and authInput', () => {
    const resolved = resolveRuntimeConfiguration(
      { provider: 'anthropic' },
      { apiKey: 'direct-key', kind: 'api_key' }
    );
    expect(resolved.apiKey).toBe('direct-key');
    expect(resolved.authInput).toEqual({ apiKey: 'direct-key', kind: 'api_key' });
  });

  it('an empty api_key auth input still fails as mastra_agent_missing_api_key (stable code)', () => {
    for (const envKey of providerEnvKeys('anthropic')) {
      vi.stubEnv(envKey, '');
    }
    expect(() =>
      resolveRuntimeConfiguration({ provider: 'anthropic' }, { apiKey: '', kind: 'api_key' })
    ).toThrowError(/missing_api_key/);
  });

  it('a custom_fetch auth input passes key resolution on its dummy key', () => {
    const fakeFetch: typeof globalThis.fetch = () => Promise.reject(new Error('unused'));
    const resolved = resolveRuntimeConfiguration(
      { provider: 'anthropic' },
      { apiKey: 'dummy', fetch: fakeFetch, kind: 'custom_fetch' }
    );
    expect(resolved.apiKey).toBe('dummy');
    expect(resolved.authInput?.kind).toBe('custom_fetch');
  });

  it('an aws auth input without a region fails typed, never missing_api_key', () => {
    expect(() =>
      resolveRuntimeConfiguration({ provider: 'anthropic' }, { kind: 'aws', region: ' ' })
    ).toThrowError(/region/);
  });

  it('an aws auth input with a region skips the bearer-key requirement', () => {
    for (const envKey of providerEnvKeys('anthropic')) {
      vi.stubEnv(envKey, '');
    }
    const auth: ProviderAuthInput = { apiKey: 'bedrock-bearer', kind: 'aws', region: 'us-east-1' };
    const resolved = resolveRuntimeConfiguration({ provider: 'anthropic' }, auth);
    // The threaded auth input is AUTHORITATIVE — no fallback into env
    // resolution, which the emptied env vars above would otherwise supply.
    expect(resolved.apiKey).toBe('bedrock-bearer');
    expect(resolved.authInput).toEqual(auth);
  });

  it('an aws CHAIN auth input carries no bearer and still skips the requirement (BST-1353)', () => {
    // The profile-chain form is the whole point: it is a fully configured
    // credential with NO api key, so `mastra_agent_missing_api_key` must not
    // fire and the closure must survive resolution by reference.
    for (const envKey of providerEnvKeys('anthropic')) {
      vi.stubEnv(envKey, '');
    }
    const credentialProvider = async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'sec' });
    const auth: ProviderAuthInput = { credentialProvider, kind: 'aws', region: 'us-east-1' };
    const resolved = resolveRuntimeConfiguration({ provider: 'anthropic' }, auth);
    expect(resolved.apiKey).toBe('');
    expect(resolved.authInput).toEqual(auth);
    // Identity, not a structural copy — a serialized round trip would drop it.
    expect(
      (resolved.authInput as Extract<ProviderAuthInput, { kind: 'aws' }>).credentialProvider
    ).toBe(credentialProvider);
  });

  it('without an auth input the legacy runtime/env resolution wraps into api_key kind', () => {
    const resolved = resolveRuntimeConfiguration({ apiKey: 'runtime-key', provider: 'anthropic' });
    expect(resolved.apiKey).toBe('runtime-key');
    expect(resolved.authInput).toEqual({ apiKey: 'runtime-key', kind: 'api_key' });
  });

  it('keyless providers resolve with no auth input by default', () => {
    const resolved = resolveRuntimeConfiguration({ provider: 'ollama' });
    expect(resolved.apiKey).toBe('');
    expect(resolved.authInput).toBeUndefined();
  });
});
