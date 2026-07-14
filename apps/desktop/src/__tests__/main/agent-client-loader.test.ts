import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
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
    const requireForTest = createRequire(import.meta.url);
    // Mirror of FALLBACK_PROVIDERS in src/agent-client-loader.ts. Used when
    // @brainstrike/agent's dist is not built — the normal state since B4
    // removed test.dependsOn ^build (the raw createRequire below bypasses
    // vitest aliases, so it genuinely needs dist). Keep in sync with the
    // loader.
    const fallbackProviders = [
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'cohere',
      'voyage',
      'local',
      'ollama',
      'lmstudio',
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
