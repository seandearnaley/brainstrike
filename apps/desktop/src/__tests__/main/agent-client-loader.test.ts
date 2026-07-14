import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.fn();

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: loggerWarn,
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
    // SOURCE-backed truth (no hand-maintained duplicate): vi.importActual
    // bypasses the global setup.ts mock of '@brainstrike/agent/client' and
    // resolves through the vitest alias (browser-safe agent subpath map)
    // straight to packages/agent/src/client.ts, so it works with or without
    // agent's dist and always reflects the current provider metadata. It
    // anchors BOTH loader outcomes:
    //  - agent dist present: the loader requires dist (raw node require —
    //    aliases don't apply to it), whose values must match source;
    //  - agent dist absent (the normal CI state since B4 removed
    //    test.dependsOn ^build): the loader returns its static
    //    FALLBACK_PROVIDERS / FALLBACK_ENV_KEYS, which this assertion pins to
    //    the source truth — if a provider is added to the agent client and the
    //    loader's fallback is not updated, this test fails.
    const agentClientSource = (await vi.importActual('@brainstrike/agent/client')) as {
      listProviders: () => { id: string }[];
      providerEnvKeys: (provider: string) => string[];
    };
    const expectedProviders = agentClientSource.listProviders().map((provider) => provider.id);
    const expectedOpenAiKeys = agentClientSource.providerEnvKeys('openai');

    clearCachedAgentClient();

    expect(listAgentProviders()).toEqual(expectedProviders);
    expect(getAgentProviderEnvKeys('openai')).toEqual(expectedOpenAiKeys);
  });

  it('falls back to workspace dist when exports are unavailable', async () => {
    process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '0';
    process.env['VITEST'] = 'false';

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-'));
    const distDir = path.join(tempDir, 'packages/agent/dist');
    fs.mkdirSync(distDir, { recursive: true });
    const clientPath = path.join(distDir, 'client.js');
    fs.writeFileSync(
      clientPath,
      [
        "exports.listProviders = () => [{ id: 'openai' }];",
        "exports.providerEnvKeys = () => ['WORKSPACE_KEY'];",
      ].join('\n')
    );

    const moduleLoader = Module as unknown as {
      _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
    };
    const originalLoad = moduleLoader._load;
    const loadSpy = vi
      .spyOn(moduleLoader, '_load')
      .mockImplementation((request, parent, isMain) => {
        if (request === '@brainstrike/agent/client') {
          const error = Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
          throw error;
        }
        return originalLoad(request, parent, isMain);
      });

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    vi.resetModules();
    const { clearCachedAgentClient, listAgentProviders, getAgentProviderEnvKeys } = await import(
      '../../agent-client-loader'
    );
    clearCachedAgentClient();

    expect(listAgentProviders()).toEqual(['openai']);
    expect(getAgentProviderEnvKeys('openai')).toEqual(['WORKSPACE_KEY']);

    cwdSpy.mockRestore();
    loadSpy.mockRestore();
    fs.rmSync(tempDir, { force: true, recursive: true });
  });
});
