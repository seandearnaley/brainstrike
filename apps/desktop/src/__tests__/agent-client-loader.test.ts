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
});
