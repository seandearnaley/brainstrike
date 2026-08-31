import { mcpToolRegistry } from '@brainstrike/agent';
import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { watchMcpConfig } from '../../mcp-loader';
import { readOpenAIApiKey } from '../../openai-api-key';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type WatchCallback = (config: unknown) => Promise<void>;

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{"servers":[]}'),
  getMcpConfigPath: vi.fn(),
  loadMcpConfig: vi.fn(),
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: vi.fn() })),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  disposeClients: vi.fn(),
  getClientStatuses: vi.fn(() => []),
  initClients: vi.fn(),
}));

vi.mock('../../openai-api-key', () => ({ readOpenAIApiKey: vi.fn() }));

const mockSecretsService = {
  deleteKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
};

vi.mock('../../secrets', () => ({ getSecretsService: vi.fn(() => mockSecretsService) }));

const authority = createMcpAuthorityTestRuntime();

describe('MCP lifecycle IPC', () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
    handlers = new Map();
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
    vi.mocked(readOpenAIApiKey).mockResolvedValue('env-openai-key');
    const mockHandle = ipcMain.handle as unknown as import('vitest').Mock<
      (channel: string, handler: RegisteredHandler) => void
    >;
    mockHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    mcpIpc.registerMcpIpcHandlers({ runtime: authority.runtime });
    await handlers.get('mcp:config:unwatch')?.();
    vi.mocked(watchMcpConfig).mockClear();
  });

  afterEach(async () => {
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime);
    await handlers.get('mcp:config:unwatch')?.();
    mcpToolRegistry.clear();
    vi.restoreAllMocks();
  });

  it('keeps explicit authentication startup responsive without invoking the server', async () => {
    let watchCallback: WatchCallback | undefined;
    vi.mocked(watchMcpConfig).mockImplementation(async (callback) => {
      watchCallback = callback as WatchCallback;
      return { close: vi.fn() };
    });
    await handlers.get('mcp:config:watch')?.();
    authority.invoke.mockClear();

    await watchCallback?.({
      config: {
        servers: [
          {
            args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
            command: 'npx',
            name: 'linear',
            protocol: 'legacy',
            startup: 'authentication-required',
            transport: 'stdio',
          },
        ],
      },
      exists: true,
      path: '/tmp/mcp.config.json',
    });

    expect(authority.invoke).not.toHaveBeenCalled();
    await expect(handlers.get('mcp:status:get')?.()).resolves.toMatchObject({
      servers: [{ configuredServerId: 'linear', state: 'authentication-required' }],
    });
  });

  it('strictly validates lifecycle controls before reaching the host', async () => {
    const control = vi.spyOn(authority.runtime.host, 'control');
    const handler = handlers.get('mcp:lifecycle:control');
    if (!handler) {
      throw new Error('lifecycle control handler not registered');
    }

    await expect(handler({}, { action: 'guess', configuredServerId: 'linear' })).rejects.toThrow();
    expect(control).not.toHaveBeenCalled();
  });
});
