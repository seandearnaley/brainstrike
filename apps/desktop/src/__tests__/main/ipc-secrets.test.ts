import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedAgentClient } from '../../agent-client-loader';

vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(),
    },
  };
});

type SecretsServiceMock = {
  saveKey: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  deleteKey: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
};

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];

describe('registerSecretsIpcHandlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clearCachedAgentClient();

    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
    process.env['ELECTRON_IS_E2E_TEST'] = ORIGINAL_ELECTRON_E2E;
  });

  afterEach(async () => {
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = undefined;
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = undefined;
    clearCachedAgentClient();

    // Clear test mode secrets to prevent state leakage between tests
    const { clearTestModeSecrets } = await import('../../ipc-secrets');
    clearTestModeSecrets();
  });

  async function bootstrap(secretsService: SecretsServiceMock) {
    const { registerSecretsIpcHandlers } = await import('../../ipc-secrets');
    const { ipcMain } = await import('electron');

    registerSecretsIpcHandlers(secretsService as unknown as import('../../secrets').SecretsService);

    const handleMock = ipcMain.handle as unknown as vi.Mock;
    const getHandler = (channel: string) => {
      const entry = handleMock.mock.calls.find(([name]) => name === channel);
      return entry?.[1] as ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
    };

    return { getHandler };
  }

  it('returns only stored providers (not environment variables)', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'sk-environment';

    const secretsService: SecretsServiceMock = {
      saveKey: vi.fn(),
      getKey: vi.fn(),
      deleteKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', ' custom ']),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:list');
    expect(listHandler).toBeDefined();

    const result = (await listHandler!({} as IpcMainInvokeEvent)) as string[];

    // Only stored providers should be returned, not env vars
    expect(result).toEqual(['anthropic', 'custom']);
    expect(result).not.toContain('openai'); // env var should NOT be in the list
    expect(secretsService.listProviders).toHaveBeenCalledTimes(1);
  });

  it('uses only in-memory secrets in test mode (ignores env vars)', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'sk-google';

    const secretsService: SecretsServiceMock = {
      saveKey: vi.fn(),
      getKey: vi.fn(),
      deleteKey: vi.fn(),
      listProviders: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const saveHandler = getHandler('secrets:save');
    const listHandler = getHandler('secrets:list');

    expect(saveHandler).toBeDefined();
    expect(listHandler).toBeDefined();

    await saveHandler!({} as IpcMainInvokeEvent, 'anthropic', 'sk-test-anthropic');
    const result = (await listHandler!({} as IpcMainInvokeEvent)) as string[];

    // Test mode should only include in-memory secrets, NOT env vars
    expect(result).toEqual(['anthropic']);
    expect(result).not.toContain('google');
    expect(secretsService.listProviders).not.toHaveBeenCalled();
  });
});
