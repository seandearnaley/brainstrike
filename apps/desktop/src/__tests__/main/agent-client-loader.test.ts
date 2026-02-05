import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@brainstrike/agent/client', () => ({
  listProviders: () => [{ id: 'openai' }, { id: 'anthropic' }],
  providerEnvKeys: (provider: string) => [`${provider}-KEY`],
}));

describe('agent-client-loader', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('returns fallback providers when forced into fallback mode', async () => {
    process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '1';
    process.env['VITEST'] = 'false';

    const { clearCachedAgentClient, listAgentProviders, getAgentProviderEnvKeys } = await import(
      '../../agent-client-loader'
    );

    clearCachedAgentClient();

    const providers = listAgentProviders();
    expect(providers).toContain('openai');
    expect(providers).toContain('local');
    expect(getAgentProviderEnvKeys('openai')).toContain('OPENAI_API_KEY');
  });

  it('uses the exported agent client module when available', async () => {
    process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '0';
    process.env['VITEST'] = 'false';

    const { clearCachedAgentClient, listAgentProviders, getAgentProviderEnvKeys } = await import(
      '../../agent-client-loader'
    );

    clearCachedAgentClient();

    expect(listAgentProviders()).toEqual(['openai', 'anthropic']);
    expect(getAgentProviderEnvKeys('openai')).toEqual(['openai-KEY']);
  });
});
