import { describe, expect, it } from 'vitest';
import { providerAuthType } from '../provider-metadata.js';
import { getProviderDefinition, listProviders } from '../provider-registry.js';

/**
 * BST-1349: auth metadata is REGISTRY facts, not per-provider UI branches.
 */
describe('provider auth metadata', () => {
  it('every provider declares an authType', () => {
    for (const provider of listProviders()) {
      expect(['api_key', 'aws', 'chatgpt_sign_in'], `${provider.id} authType`).toContain(
        provider.authType
      );
    }
  });

  it('the hosted/gateway providers all use api_key auth', () => {
    const apiKeyProviders = listProviders()
      .filter((provider) => provider.authType === 'api_key')
      .map((provider) => provider.id)
      .sort();
    expect(apiKeyProviders).toEqual(['anthropic', 'google', 'openai', 'openrouter']);
  });

  it('only the ChatGPT route signs in, and no environment variable authenticates it', () => {
    const signIn = listProviders().filter((provider) => provider.authType === 'chatgpt_sign_in');
    expect(signIn.map((provider) => provider.id)).toEqual(['chatgpt']);
    expect(getProviderDefinition('chatgpt').envKeys).toEqual([]);
  });

  it('every api_key provider carries an https docsUrl to its key page', () => {
    for (const provider of listProviders()) {
      if (provider.authType !== 'api_key') {
        continue;
      }
      expect(provider.docsUrl, `${provider.id} docsUrl`).toMatch(/^https:\/\//u);
    }
  });

  it('declares the vendor-documented stable key prefixes and no others', () => {
    // Only vendors with a stable documented prefix declare one — never guessed.
    expect(getProviderDefinition('openai').keyFormatHint).toBe('sk-...');
    expect(getProviderDefinition('anthropic').keyFormatHint).toBe('sk-ant-...');
    expect(getProviderDefinition('openrouter').keyFormatHint).toBe('sk-or-v1-...');
    expect(getProviderDefinition('google').keyFormatHint).toBeUndefined();
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
