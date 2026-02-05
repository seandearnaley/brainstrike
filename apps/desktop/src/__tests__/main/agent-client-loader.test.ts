import { createRequire } from 'node:module';
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
    const requireForTest = createRequire(import.meta.url);
    const fallbackProviders = [
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'cohere',
      'voyage',
      'local',
    ];
    const fallbackOpenAiKeys = [
      'BRAINSTRIKE_OPENAI_API_KEY',
      'BS_OPENAI_API_KEY',
      'OPENAI_API_KEY',
      'AI_OPENAI_API_KEY',
      'OPENAI_API_KEY_V1',
      'OPENAI_API_KEY_V2',
    ];

    clearCachedAgentClient();

    let expectedProviders = fallbackProviders;
    let expectedOpenAiKeys = fallbackOpenAiKeys;

    try {
      const agentClient = requireForTest('@brainstrike/agent/client') as {
        listProviders: () => { id: string }[];
        providerEnvKeys: (provider: string) => string[];
      };
      expectedProviders = agentClient.listProviders().map((provider) => provider.id);
      expectedOpenAiKeys = agentClient.providerEnvKeys('openai');
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (
        error.code &&
        error.code !== 'MODULE_NOT_FOUND' &&
        error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ) {
        throw err;
      }
    }

    expect(listAgentProviders()).toEqual(expectedProviders);
    expect(getAgentProviderEnvKeys('openai')).toEqual(expectedOpenAiKeys);
  });
});
