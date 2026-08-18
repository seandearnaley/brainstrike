import { describe, expect, it } from 'vitest';
import { providerAuthType } from '../provider-metadata.js';
import { getProviderDefinition, listProviders } from '../provider-registry.js';

/**
 * BST-1349: auth metadata is REGISTRY facts, not per-provider UI branches.
 * Keyless-ness derives from `authType === 'none'` everywhere — no hand lists.
 */
describe('provider auth metadata', () => {
  it('every provider declares an authType', () => {
    for (const provider of listProviders()) {
      expect(['api_key', 'oauth_subscription', 'aws', 'none'], `${provider.id} authType`).toContain(
        provider.authType
      );
    }
  });

  it('exactly the local runtimes are keyless (authType none)', () => {
    const keyless = listProviders()
      .filter((provider) => provider.authType === 'none')
      .map((provider) => provider.id)
      .sort();
    expect(keyless).toEqual(['lmstudio', 'local', 'ollama']);
  });

  it('the hosted/gateway providers all use api_key auth', () => {
    const apiKeyProviders = listProviders()
      .filter((provider) => provider.authType === 'api_key')
      .map((provider) => provider.id)
      .sort();
    expect(apiKeyProviders).toEqual([
      'anthropic',
      'cohere',
      'google',
      'openai',
      'openrouter',
      'voyage',
    ]);
  });

  it('every api_key provider carries an https docsUrl to its key page', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'api_key') {
        continue;
      }
      expect(provider.docsUrl, `${provider.id} docsUrl`).toMatch(/^https:\/\//);
    }
  });

  it('keyless providers carry no key-entry metadata', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'none') {
        continue;
      }
      expect(provider.docsUrl, `${provider.id} docsUrl`).toBeUndefined();
      expect(provider.keyFormatHint, `${provider.id} keyFormatHint`).toBeUndefined();
      expect(provider.keyNotes, `${provider.id} keyNotes`).toBeUndefined();
    }
  });

  it('declares the vendor-documented stable key prefixes and no others', () => {
    // Only vendors with a stable documented prefix declare one — never guessed.
    expect(getProviderDefinition('openai').keyFormatHint).toBe('sk-...');
    expect(getProviderDefinition('anthropic').keyFormatHint).toBe('sk-ant-...');
    expect(getProviderDefinition('openrouter').keyFormatHint).toBe('sk-or-v1-...');
    for (const id of ['google', 'cohere', 'voyage'] as const) {
      expect(getProviderDefinition(id).keyFormatHint, `${id} keyFormatHint`).toBeUndefined();
    }
  });

  it('keeps the google Gemini-vs-Vertex guidance as registry keyNotes', () => {
    const notes = getProviderDefinition('google').keyNotes;
    expect(notes).toContain('Gemini API key');
    expect(notes).toContain('Vertex');
  });

  it('providerAuthType(id) reads the registry authType', () => {
    for (const provider of listProviders()) {
      expect(providerAuthType(provider.id)).toBe(provider.authType);
    }
  });
});
