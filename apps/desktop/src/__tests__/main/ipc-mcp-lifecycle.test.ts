import { mcpToolRegistry } from '@brainstrike/agent';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { loadMcpConfig, watchMcpConfig } from '../../mcp-loader';
import { readOpenAIApiKey } from '../../openai-api-key';
import { adaptMcpHandlerForVisibleUi } from '../helpers/mcp-authorized-handler-test-adapter';
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
    vi.mocked(loadMcpConfig).mockResolvedValue({
      config: { servers: [] },
      exists: true,
      path: '/tmp/mcp.config.json',
    });
    vi.mocked(readOpenAIApiKey).mockResolvedValue('env-openai-key');
    const mockHandle = ipcMain.handle as unknown as import('vitest').Mock<
      (channel: string, handler: RegisteredHandler) => void
    >;
    mockHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, adaptMcpHandlerForVisibleUi(handler));
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

  it('dispatches cancellation without waiting for the connect lifecycle barrier', async () => {
    const handler = handlers.get('mcp:lifecycle:control');
    if (!handler) {
      throw new Error('lifecycle control handler not registered');
    }
    const connect = Promise.withResolvers<never>();
    const control = vi.spyOn(authority.runtime.host, 'control').mockImplementation((request) => {
      if (request.action === 'connect') {
        return connect.promise;
      }
      return Promise.resolve({
        configuredProtocol: '2026-07-28',
        configuredServerId: parseConfiguredMcpServerId('linear'),
        generation: 1,
        state: 'authentication-required',
        transport: 'streamable-http',
      });
    });

    const connecting = handler({}, { action: 'connect', configuredServerId: 'linear' });
    await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
    const cancelling = handler({}, { action: 'cancel', configuredServerId: 'linear' });
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    await expect(cancelling).resolves.toMatchObject({ state: 'authentication-required' });

    connect.reject(new Error('cancelled'));
    await expect(connecting).rejects.toThrow('cancelled');
  });

  it('reloads config after a failed destructive OAuth control', async () => {
    const handler = handlers.get('mcp:lifecycle:control');
    if (!handler) {
      throw new Error('lifecycle control handler not registered');
    }
    await handlers.get('mcp:status:get')?.();
    vi.mocked(loadMcpConfig).mockClear();
    await authority.replaceResolvedConfig({
      servers: [
        {
          auth: { type: 'oauth-user' },
          headers: undefined,
          name: parseConfiguredMcpServerId('linear'),
          protocol: 'auto',
          startup: 'authentication-required',
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
    });
    vi.mocked(authority.runtime.host.control).mockRejectedValueOnce(
      new Error('credential clear failed')
    );
    await expect(
      handler({}, { action: 'disconnect', configuredServerId: 'linear' })
    ).rejects.toThrow('credential clear failed');
    expect(loadMcpConfig).toHaveBeenCalledOnce();
    expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
  });

  it('preserves both destructive-control and reload failures', async () => {
    const handler = handlers.get('mcp:lifecycle:control');
    if (!handler) {
      throw new Error('lifecycle control handler not registered');
    }
    await handlers.get('mcp:status:get')?.();
    await authority.replaceResolvedConfig({
      servers: [
        {
          auth: { type: 'oauth-user' },
          headers: undefined,
          name: parseConfiguredMcpServerId('linear'),
          protocol: 'auto',
          startup: 'authentication-required',
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
    });
    vi.mocked(authority.runtime.host.control).mockRejectedValueOnce(
      new Error('credential clear failed')
    );
    vi.mocked(loadMcpConfig).mockRejectedValueOnce(new Error('config reload failed'));

    await expect(
      handler({}, { action: 'reauthorize', configuredServerId: 'linear' })
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'credential clear failed' }),
        expect.objectContaining({ message: 'config reload failed' }),
      ],
      message: 'MCP lifecycle control and config reload both failed',
    });
  });
});
