import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedAgentClient } from '../../agent-client-loader';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

interface SecretsServiceMock {
  clearAll: ReturnType<typeof vi.fn>;
  deleteKey: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  listProviders: ReturnType<typeof vi.fn>;
  saveKey: ReturnType<typeof vi.fn>;
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];
const SECRETS_CLEAR_CONFIRMATION_TOKEN = 'CONFIRM_CLEAR_SECRETS';

function restoreEnvVar(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
    return;
  }
  Reflect.deleteProperty(process.env, key);
}

function clearEnvVar(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

describe('registerSecretsIpcHandlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clearCachedAgentClient();

    restoreEnvVar('NODE_ENV', ORIGINAL_NODE_ENV);
    restoreEnvVar('ELECTRON_IS_E2E_TEST', ORIGINAL_ELECTRON_E2E);
    clearEnvVar('BRAINSTRIKE_OPENAI_API_KEY');
    clearEnvVar('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  afterEach(async () => {
    clearEnvVar('BRAINSTRIKE_OPENAI_API_KEY');
    clearEnvVar('GOOGLE_GENERATIVE_AI_API_KEY');
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

  it('registers channels through the typed desktop IPC registry', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/ipc-secrets.ts'), 'utf8');

    expect(source).toContain('createDesktopIpcRegistry');
    expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
    expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
  });

  it('merges env-configured providers with stored entries when listing', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'sk-environment';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', ' custom ']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:list');
    expect(listHandler).toBeDefined();

    const result = (await listHandler!({} as IpcMainInvokeEvent)) as string[];

    // Env + stored providers should be merged (with whitespace trimmed)
    expect(result).toEqual(['openai', 'anthropic', 'custom']);
    expect(result).toContain('openai');
    expect(secretsService.listProviders).toHaveBeenCalledTimes(1);
  });

  it('exposes stored providers-only list via secrets:listStored', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BRAINSTRIKE_OPENAI_API_KEY'] = 'sk-environment';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue(['anthropic', ' custom ']),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const listHandler = getHandler('secrets:listStored');
    expect(listHandler).toBeDefined();

    const result = (await listHandler!({} as IpcMainInvokeEvent)) as string[];

    expect(result).toEqual(['anthropic', 'custom']);
    expect(result).not.toContain('openai');
    expect(secretsService.listProviders).toHaveBeenCalledTimes(1);
  });

  it('uses only in-memory secrets in test mode (ignores env vars)', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['GOOGLE_GENERATIVE_AI_API_KEY'] = 'sk-google';

    const secretsService: SecretsServiceMock = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn(),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const saveHandler = getHandler('secrets:save');
    const listHandler = getHandler('secrets:list');
    const listStoredHandler = getHandler('secrets:listStored');

    expect(saveHandler).toBeDefined();
    expect(listHandler).toBeDefined();
    expect(listStoredHandler).toBeDefined();

    await saveHandler!({} as IpcMainInvokeEvent, 'anthropic', 'sk-test-anthropic');
    const result = (await listHandler!({} as IpcMainInvokeEvent)) as string[];
    const storedResult = (await listStoredHandler!({} as IpcMainInvokeEvent)) as string[];

    // Test mode should only include in-memory secrets, NOT env vars
    expect(result).toEqual(['anthropic']);
    expect(result).not.toContain('google');
    expect(storedResult).toEqual(['anthropic']);
    expect(storedResult).not.toContain('google');
    expect(secretsService.listProviders).not.toHaveBeenCalled();
  });

  it('requires confirmation token to clear secrets store', async () => {
    process.env['NODE_ENV'] = 'production';

    const secretsService: SecretsServiceMock = {
      clearAll: vi.fn().mockResolvedValue(true),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
      saveKey: vi.fn(),
    };

    const { getHandler } = await bootstrap(secretsService);
    const clearHandler = getHandler('secrets:clearAll');
    expect(clearHandler).toBeDefined();

    const unauthorized = (await clearHandler!({} as IpcMainInvokeEvent)) as {
      success: false;
      message: string;
    };

    expect(unauthorized).toEqual({
      message: 'Unauthorized: Invalid confirmation token',
      success: false,
    });
    expect(secretsService.clearAll).toHaveBeenCalledTimes(0);

    const success = (await clearHandler!(
      {} as IpcMainInvokeEvent,
      SECRETS_CLEAR_CONFIRMATION_TOKEN
    )) as { success: true };

    expect(success).toEqual({ success: true });
    expect(secretsService.clearAll).toHaveBeenCalledTimes(1);
  });
});
