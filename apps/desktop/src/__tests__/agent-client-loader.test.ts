import type { SupportedProvider } from '@brainstrike/agent/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORIGINAL_TEST_MODE = process.env['BRAINSTRIKE_AGENT_TEST_MODE'];
const ORIGINAL_VITEST = process.env['VITEST'];

describe('agent-client-loader', () => {
  beforeEach(() => {
    process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '1';
    process.env['VITEST'] = 'true';
  });

  afterEach(async () => {
    const module = await import('../agent-client-loader');
    module.clearCachedAgentClient();

    if (ORIGINAL_TEST_MODE === undefined) {
      process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = undefined;
    } else {
      process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = ORIGINAL_TEST_MODE;
    }

    if (ORIGINAL_VITEST === undefined) {
      process.env['VITEST'] = undefined;
    } else {
      process.env['VITEST'] = ORIGINAL_VITEST;
    }
  });

  it('returns fallback providers when forced to fallback', async () => {
    const module = await import('../agent-client-loader');
    const providers = module.listAgentProviders();

    expect(providers).toContain('openai');
    expect(providers).toContain('anthropic');
    expect(providers).toContain('local');
  });

  it('returns fallback env keys when forced to fallback', async () => {
    const module = await import('../agent-client-loader');
    const openaiKeys = module.getAgentProviderEnvKeys('openai');
    const localKeys = module.getAgentProviderEnvKeys('local');

    expect(openaiKeys.length).toBeGreaterThan(0);
    expect(localKeys).toEqual([]);
  });

  it('returns all known fallback providers in the expected order', async () => {
    const module = await import('../agent-client-loader');
    const providers = module.listAgentProviders();

    expect(providers).toEqual([
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'cohere',
      'voyage',
      'local',
      'ollama',
      'lmstudio',
    ]);
  });

  it('returns correct env keys for each fallback provider', async () => {
    const module = await import('../agent-client-loader');

    const anthropicKeys = module.getAgentProviderEnvKeys('anthropic');
    expect(anthropicKeys).toEqual(['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY']);

    const googleKeys = module.getAgentProviderEnvKeys('google');
    expect(googleKeys).toContain('GOOGLE_GENERATIVE_AI_API_KEY');

    const openrouterKeys = module.getAgentProviderEnvKeys('openrouter');
    expect(openrouterKeys).toContain('OPENROUTER_API_KEY');

    const cohereKeys = module.getAgentProviderEnvKeys('cohere');
    expect(cohereKeys).toContain('COHERE_API_KEY');

    const voyageKeys = module.getAgentProviderEnvKeys('voyage');
    expect(voyageKeys).toContain('VOYAGE_API_KEY');

    // Local runtime providers have no env keys
    const ollamaKeys = module.getAgentProviderEnvKeys('ollama');
    expect(ollamaKeys).toEqual([]);

    const lmstudioKeys = module.getAgentProviderEnvKeys('lmstudio');
    expect(lmstudioKeys).toEqual([]);
  });

  it('returns empty array for unknown provider env keys', async () => {
    const module = await import('../agent-client-loader');
    const keys = module.getAgentProviderEnvKeys('nonexistent-provider' as SupportedProvider);
    expect(keys).toEqual([]);
  });

  it('caches the fallback result across multiple calls', async () => {
    const module = await import('../agent-client-loader');

    const first = module.listAgentProviders();
    const second = module.listAgentProviders();

    // Both calls return the same fallback list
    expect(first).toEqual(second);
  });

  it('clearCachedAgentClient resets cache so a fresh lookup occurs', async () => {
    const module = await import('../agent-client-loader');

    // First call caches the result
    module.listAgentProviders();

    // Clear cache
    module.clearCachedAgentClient();

    // Second call still returns fallback (since env vars force it)
    const providers = module.listAgentProviders();
    expect(providers).toContain('openai');
  });

  it('getAgentProviderEnvKeys returns all openai key variants', async () => {
    const module = await import('../agent-client-loader');
    const openaiKeys = module.getAgentProviderEnvKeys('openai');

    expect(openaiKeys).toEqual([
      'BRAINSTRIKE_OPENAI_API_KEY',
      'BS_OPENAI_API_KEY',
      'OPENAI_API_KEY',
      'AI_OPENAI_API_KEY',
      'OPENAI_API_KEY_V1',
      'OPENAI_API_KEY_V2',
    ]);
  });

  describe('shouldForceFallback paths', () => {
    it('falls back when BRAINSTRIKE_AGENT_TEST_MODE=1 alone', async () => {
      process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '1';
      process.env['VITEST'] = undefined;

      const module = await import('../agent-client-loader');
      module.clearCachedAgentClient();

      const providers = module.listAgentProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('local');
    });

    it('falls back when VITEST=true alone', async () => {
      process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = undefined;
      process.env['VITEST'] = 'true';

      const module = await import('../agent-client-loader');
      module.clearCachedAgentClient();

      const providers = module.listAgentProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('local');
    });
  });
});
