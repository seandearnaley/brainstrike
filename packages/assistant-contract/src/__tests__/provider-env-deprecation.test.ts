import { describe, expect, it } from 'vitest';
import {
  detectDeprecatedProviderEnvVars,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
  providerOverrideEnvKey,
  providerVendorEnvKey,
} from '../provider-metadata.js';
import { getProviderDeprecatedEnvKeys, listProviders } from '../provider-registry.js';

/**
 * BST-1361: exactly two env names per provider — `BRAINSTRIKE_<PROVIDER>_API_KEY`
 * (app-scoped override, wins) then the vendor-standard name. Every historical
 * alias moves to `deprecatedEnvKeys`: still allow-listed and scrubbed, never
 * resolved, and visibly reported.
 */

const VENDOR_STANDARD_NAMES = {
  anthropic: 'ANTHROPIC_API_KEY',
  cohere: 'COHERE_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  voyage: 'VOYAGE_API_KEY',
} as const;

const EXPECTED_DEPRECATED_KEYS = {
  anthropic: ['AI_ANTHROPIC_API_KEY'],
  cohere: ['AI_COHERE_API_KEY'],
  google: ['GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
  openai: ['BS_OPENAI_API_KEY', 'AI_OPENAI_API_KEY', 'OPENAI_API_KEY_V1', 'OPENAI_API_KEY_V2'],
  openrouter: ['AI_OPENROUTER_API_KEY'],
  voyage: ['AI_VOYAGE_API_KEY'],
} as const;

// Registry-derived iteration (never a hand list); the maps above stay as
// explicit expectation pins and must cover exactly this set.
const API_KEY_PROVIDER_IDS = listProviders()
  .filter((provider) => provider.authType === 'api_key')
  .map((provider) => provider.id) as ReadonlyArray<keyof typeof VENDOR_STANDARD_NAMES>;

describe('canonical two-name env scheme', () => {
  it('the expectation pins cover exactly the registry api_key providers', () => {
    expect([...API_KEY_PROVIDER_IDS].sort()).toEqual(Object.keys(VENDOR_STANDARD_NAMES).sort());
    expect(Object.keys(EXPECTED_DEPRECATED_KEYS).sort()).toEqual(
      Object.keys(VENDOR_STANDARD_NAMES).sort()
    );
  });

  it('every api_key provider declares exactly BRAINSTRIKE_* then the vendor name', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'api_key') {
        continue;
      }
      const id = provider.id as keyof typeof VENDOR_STANDARD_NAMES;
      expect(provider.envKeys, `${provider.id} envKeys`).toEqual([
        `BRAINSTRIKE_${provider.id.toUpperCase()}_API_KEY`,
        VENDOR_STANDARD_NAMES[id],
      ]);
    }
  });

  it('named role accessors resolve the override and vendor names (BST-1361 review 6)', () => {
    for (const id of API_KEY_PROVIDER_IDS) {
      const envKeys = providerEnvKeys(id);
      expect(envKeys, `${id} must declare exactly two names`).toHaveLength(2);
      expect(providerOverrideEnvKey(id)).toBe(envKeys[0]);
      expect(providerOverrideEnvKey(id)).toBe(`BRAINSTRIKE_${id.toUpperCase()}_API_KEY`);
      expect(providerVendorEnvKey(id)).toBe(envKeys[1]);
      expect(providerVendorEnvKey(id)?.startsWith('BRAINSTRIKE_')).toBe(false);
    }
  });

  it('named role accessors return undefined for keyless providers', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'none') {
        continue;
      }
      expect(providerOverrideEnvKey(provider.id)).toBeUndefined();
      expect(providerVendorEnvKey(provider.id)).toBeUndefined();
    }
  });

  it('keyless providers declare no envKeys and no deprecatedEnvKeys', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'none') {
        continue;
      }
      expect(provider.envKeys ?? []).toEqual([]);
      expect(provider.deprecatedEnvKeys ?? []).toEqual([]);
    }
  });

  it.each(API_KEY_PROVIDER_IDS)('%s carries every dropped alias in deprecatedEnvKeys', (id) => {
    expect(getProviderDeprecatedEnvKeys(id)).toEqual(EXPECTED_DEPRECATED_KEYS[id]);
    expect(providerDeprecatedEnvKeys(id)).toEqual(EXPECTED_DEPRECATED_KEYS[id]);
  });

  it('no name appears in both envKeys and deprecatedEnvKeys, and no name repeats across providers', () => {
    const seen = new Set<string>();
    for (const provider of listProviders()) {
      const names = [...(provider.envKeys ?? []), ...(provider.deprecatedEnvKeys ?? [])];
      for (const name of names) {
        expect(seen.has(name), `duplicate env name ${name}`).toBe(false);
        seen.add(name);
      }
      const canonical = new Set(provider.envKeys ?? []);
      for (const name of provider.deprecatedEnvKeys ?? []) {
        expect(canonical.has(name), `${provider.id} declares ${name} as both`).toBe(false);
      }
    }
  });
});

describe('detectDeprecatedProviderEnvVars', () => {
  it('returns an empty list for an env with no deprecated names', () => {
    expect(detectDeprecatedProviderEnvVars({})).toEqual([]);
    expect(
      detectDeprecatedProviderEnvVars({
        BRAINSTRIKE_OPENAI_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
        PATH: '/usr/bin',
      })
    ).toEqual([]);
  });

  it('reports a set deprecated name with its vendor-standard replacement', () => {
    expect(detectDeprecatedProviderEnvVars({ OPENAI_API_KEY_V2: 'x' })).toEqual([
      { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
    ]);
  });

  it('maps GOOGLE_API_KEY to the canonical Gemini name', () => {
    expect(detectDeprecatedProviderEnvVars({ GOOGLE_API_KEY: 'x' })).toEqual([
      { envVar: 'GOOGLE_API_KEY', provider: 'google', replacement: 'GOOGLE_GENERATIVE_AI_API_KEY' },
    ]);
  });

  it('ignores unset, empty, and whitespace-only values', () => {
    expect(
      detectDeprecatedProviderEnvVars({
        AI_ANTHROPIC_API_KEY: '   ',
        AI_COHERE_API_KEY: '',
        AI_VOYAGE_API_KEY: undefined,
      })
    ).toEqual([]);
  });

  it('reports multiple hits in registry order, then declaration order within a provider', () => {
    expect(
      detectDeprecatedProviderEnvVars({
        AI_GOOGLE_API_KEY: 'g2',
        AI_OPENROUTER_API_KEY: 'or',
        BS_OPENAI_API_KEY: 'o1',
        GOOGLE_API_KEY: 'g1',
        OPENAI_API_KEY_V1: 'o2',
      })
    ).toEqual([
      { envVar: 'BS_OPENAI_API_KEY', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      { envVar: 'OPENAI_API_KEY_V1', provider: 'openai', replacement: 'OPENAI_API_KEY' },
      { envVar: 'GOOGLE_API_KEY', provider: 'google', replacement: 'GOOGLE_GENERATIVE_AI_API_KEY' },
      {
        envVar: 'AI_GOOGLE_API_KEY',
        provider: 'google',
        replacement: 'GOOGLE_GENERATIVE_AI_API_KEY',
      },
      {
        envVar: 'AI_OPENROUTER_API_KEY',
        provider: 'openrouter',
        replacement: 'OPENROUTER_API_KEY',
      },
    ]);
  });

  it('matches deprecated names case-insensitively, reporting the canonical spelling', () => {
    // Windows environment names are case-insensitive; apply the same rule on
    // every platform, mirroring createCredentialIsolatedChildEnvironment.
    expect(detectDeprecatedProviderEnvVars({ ai_openai_api_key: 'x' })).toEqual([
      { envVar: 'AI_OPENAI_API_KEY', provider: 'openai', replacement: 'OPENAI_API_KEY' },
    ]);
  });

  it('a deprecated name never appears in any provider resolution list', () => {
    for (const provider of listProviders()) {
      const resolutionNames = new Set(providerEnvKeys(provider.id));
      for (const name of getProviderDeprecatedEnvKeys(provider.id)) {
        expect(resolutionNames.has(name), `${provider.id} still resolves ${name}`).toBe(false);
      }
    }
  });
});
