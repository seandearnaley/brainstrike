import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mcpToolRegistry } from '@brainstrike/agent';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import {
  getMcpConfigPath,
  loadMcpConfig,
  readMcpConfigText,
  setCustomMcpConfigPath,
  watchMcpConfig,
  writeMcpConfigText,
} from '../../mcp-loader';
import { readOpenAIApiKey } from '../../openai-api-key';
import { adaptMcpHandlerForVisibleUi } from '../helpers/mcp-authorized-handler-test-adapter';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type WatchCallback = (config: unknown) => Promise<void>;
interface LoadResult {
  servers?: Array<{ name?: string }>;
}
function mockWatchImpl(setter: (cb: WatchCallback) => void, ret: { close: () => void }) {
  const mock = watchMcpConfig as unknown as import('vitest').Mock<
    (onChange: WatchCallback) => { close: () => void }
  >;
  mock.mockImplementation((cb: WatchCallback) => {
    setter(cb);
    return ret;
  });
}

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

// Mock dependencies
vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{\n  "servers": []\n}'),
  getMcpConfigPath: vi.fn(),
  loadMcpConfig: vi.fn(),
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: vi.fn() })),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../openai-api-key', () => ({
  readOpenAIApiKey: vi.fn(),
}));

const mockSecretsService = {
  deleteKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
};

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => mockSecretsService),
}));

const authority = createMcpAuthorityTestRuntime();

describe('ipc-mcp handlers', () => {
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
    mockHandle.mockImplementation((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, adaptMcpHandlerForVisibleUi(handler));
    });
    mcpIpc.registerMcpIpcHandlers({ runtime: authority.runtime });
    const unwatchHandler = handlers.get('mcp:config:unwatch');
    if (unwatchHandler) {
      await unwatchHandler();
    }
    vi.mocked(watchMcpConfig).mockClear();
  });

  afterEach(async () => {
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime);
    await handlers.get('mcp:config:unwatch')?.();
    mcpToolRegistry.clear();
    vi.restoreAllMocks();
  });

  describe('handler registration', () => {
    it('registers channels through the typed desktop IPC registry', () => {
      const source = readFileSync(path.resolve(process.cwd(), 'src/ipc-mcp.ts'), 'utf8');

      expect(source).toContain('createDesktopIpcRegistry');
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
      expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
    });

    it('should register all MCP handlers', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:get', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:getPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:setPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:readText', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:writeText', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:selectPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:watch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:unwatch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:lifecycle:control', expect.any(Function));
      // Tool handlers
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:list', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:enable', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:disable', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:enableServer', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:disableServer', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:reset', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:getStats', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:createSample', expect.any(Function));
      // Content handlers (BST-1585)
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:content:complete', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:content:getPrompt', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:content:readResource', expect.any(Function));
      // Apps shell handlers (BST-1572); the agent host admits app tool calls
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:apps:prepareShell', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:apps:releaseShell', expect.any(Function));
      // Durable Tasks handlers (BST-1566)
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:task:act', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:task:list', expect.any(Function));
      // Global registered-extension dials (BST-1604)
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:extensions:get', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:extensions:set', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledTimes(29);
    });

    it('returned cleanup unregisters handlers without tearing down MCP runtime state', async () => {
      const mockWatcher = { close: vi.fn() };
      vi.mocked(watchMcpConfig).mockResolvedValue(mockWatcher as never);
      const unregister = mcpIpc.registerMcpIpcHandlers({ runtime: authority.runtime });

      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});
      await handlers.get('mcp:status:get')?.();
      mockWatcher.close.mockClear();
      const hostClose = vi.mocked(authority.runtime.host.close);
      const closeCallsBeforeUnregister = hostClose.mock.calls.length;
      unregister();

      expect(mockWatcher.close).not.toHaveBeenCalled();
      expect(hostClose).toHaveBeenCalledTimes(closeCallsBeforeUnregister);
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('mcp:config:get');
    });
  });

  describe('mcp:tools:list serialization', () => {
    it('returns a structured-cloneable deep copy that does not alias registry metadata', async () => {
      const handler = handlers.get('mcp:tools:list');
      if (!handler) {
        throw new Error('tools:list handler not registered');
      }

      const registryTools = {
        filesystem: [
          {
            description: 'Read a file',
            discoveredAt: 1,
            enabled: true,
            id: 'filesystem.read_file',
            inputSchema: {
              properties: { path: { type: 'string' } },
              required: ['path'],
              type: 'object',
            },
            serverName: 'filesystem',
          },
        ],
      };
      const getAllToolsSpy = vi
        .spyOn(mcpToolRegistry, 'getAllTools')
        .mockReturnValue(registryTools);

      try {
        const listed = (await handler()) as typeof registryTools;

        expect(listed).toEqual(registryTools);
        expect(listed).not.toBe(registryTools);
        expect(listed.filesystem[0]).not.toBe(registryTools.filesystem[0]);
        expect(listed.filesystem[0]?.inputSchema).not.toBe(
          registryTools.filesystem[0]?.inputSchema
        );

        // Electron IPC uses the structured-clone algorithm; success here means the payload
        // is safe to send without JSON stripping.
        expect(() => structuredClone(listed)).not.toThrow();

        const listedTool = listed.filesystem[0];
        if (!listedTool) {
          throw new Error('expected filesystem tool in list payload');
        }
        listedTool.enabled = false;
        listedTool.description = 'mutated';
        listedTool.inputSchema.required.push('extra');

        expect(registryTools.filesystem[0]?.enabled).toBe(true);
        expect(registryTools.filesystem[0]?.description).toBe('Read a file');
        expect(registryTools.filesystem[0]?.inputSchema).toEqual({
          properties: { path: { type: 'string' } },
          required: ['path'],
          type: 'object',
        });
      } finally {
        getAllToolsSpy.mockRestore();
      }
    });
  });

  describe('mcp:config:get', () => {
    it('waits for startup discovery, then reads config without replacing live clients', async () => {
      const startup = Promise.withResolvers<unknown>();
      vi.mocked(loadMcpConfig).mockReturnValueOnce(startup.promise as never);
      mcpIpc.registerMcpIpcHandlers({ runtime: authority.runtime });
      const statusHandler = handlers.get('mcp:status:get');
      if (!statusHandler) {
        throw new Error('status handler not registered');
      }
      const snapshot = vi.spyOn(authority.runtime.host, 'snapshot');
      const statusSnapshot = statusHandler();
      await Promise.resolve();
      expect(snapshot).not.toHaveBeenCalled();
      startup.resolve({ exists: false, path: '/tmp/mcp.config.json' });
      await expect(statusSnapshot).resolves.toMatchObject({ servers: [] });
      const mockConfig = {
        config: {
          servers: [
            {
              command: 'cmd',
              env: { TOKEN: 'decrypted-secret' },
              name: 'test',
              protocol: 'legacy',
              transport: 'stdio',
            },
          ],
        },
        exists: true,
        loadedAt: Date.now(),
        path: '/path/to/config',
      };
      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(mockConfig as never);
      const handler = handlers.get('mcp:config:get');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const replacementsBefore = authority.replaceResolvedConfig.mock.calls.length;
      const result = await handler();
      expect(loadMcpConfig).toHaveBeenCalled();
      expect(authority.replaceResolvedConfig).toHaveBeenCalledTimes(replacementsBefore);
      expect(result).toEqual({
        exists: true,
        loadedAt: mockConfig.loadedAt,
        path: '/path/to/config',
        servers: [{ name: 'test', protocol: 'legacy', transport: 'stdio' }],
      });
      expect(JSON.stringify(result)).not.toContain('decrypted-secret');
    });

    it('should not mutate clients when config does not exist', async () => {
      const mockConfig = {
        exists: false,
        path: '/path/to/config',
      };

      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(mockConfig as never);

      const handler = handlers.get('mcp:config:get');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const replacementsBefore = authority.replaceResolvedConfig.mock.calls.length;
      const result = await handler();

      expect(loadMcpConfig).toHaveBeenCalled();
      expect(authority.replaceResolvedConfig).toHaveBeenCalledTimes(replacementsBefore);
      expect(result).toEqual(mockConfig);
    });

    it('should update last config reference', async () => {
      const mockConfig1 = {
        config: { servers: [{ command: 'cmd1', name: 'test1', transport: 'stdio' }] },
        exists: true,
        path: '/path/to/config',
      };

      const mockConfig2 = {
        config: { servers: [{ command: 'cmd2', name: 'test2', transport: 'stdio' }] },
        exists: true,
        path: '/path/to/config',
      };

      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad
        .mockResolvedValueOnce(mockConfig1 as never)
        .mockResolvedValueOnce(mockConfig2 as never);

      const handler = handlers.get('mcp:config:get');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result1 = (await handler()) as LoadResult;
      expect(result1.servers?.[0]?.name).toBe('test1');

      const result2 = (await handler()) as LoadResult;
      expect(result2.servers?.[0]?.name).toBe('test2');
    });
  });

  describe('mcp:config:watch', () => {
    it('should start watching when not already watching', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockResolvedValue(mockWatcher as never);

      const handler = handlers.get('mcp:config:watch');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler({});

      expect(watchMcpConfig).toHaveBeenCalledWith(expect.any(Function));
      expect(result).toEqual({ watching: true });
    });

    it('should not create duplicate watchers', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockResolvedValue(mockWatcher as never);

      const handler = handlers.get('mcp:config:watch');

      if (!handler) {
        throw new Error('handler not registered');
      }
      await handler({});
      await handler({});

      expect(watchMcpConfig).toHaveBeenCalledTimes(1);
    });

    it('should handle config changes with valid config', async () => {
      const mockWatcher = { close: vi.fn() };
      const send = vi.fn();
      let watchCallback: WatchCallback | undefined;

      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        {
          isDestroyed: () => false,
          webContents: { send },
        } as unknown as BrowserWindow,
      ]);

      mockWatchImpl((cb) => {
        watchCallback = cb;
      }, mockWatcher);

      const handler = handlers.get('mcp:config:watch');
      if (!handler) {
        throw new Error('handler not registered');
      }
      await handler({});

      // Simulate config change
      const newConfig = {
        config: {
          servers: [
            {
              command: 'cmd',
              env: { TOKEN: 'decrypted-secret' },
              name: 'updated',
              transport: 'stdio',
            },
          ],
        },
        exists: true,
        path: '/path/to/config',
        servers: [
          {
            command: 'cmd',
            env: { TOKEN: 'decrypted-secret' },
            name: 'updated',
            transport: 'stdio',
          },
        ],
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      await watchCallback(newConfig);

      expect(authority.replaceResolvedConfig).toHaveBeenCalledWith(newConfig.config);
      expect(send).toHaveBeenCalledWith('mcp:config:updated', {
        exists: true,
        path: '/path/to/config',
        servers: [{ name: 'updated', transport: 'stdio' }],
      });
      expect(JSON.stringify(send.mock.calls)).not.toContain('decrypted-secret');
    });

    it('should install empty authority when config is removed', async () => {
      const mockWatcher = { close: vi.fn() };
      let watchCallback: WatchCallback | undefined;

      mockWatchImpl((cb) => {
        watchCallback = cb;
      }, mockWatcher);

      const handler = handlers.get('mcp:config:watch');
      if (!handler) {
        throw new Error('handler not registered');
      }
      await handler({});

      // Simulate config removal
      const invalidConfig = {
        exists: false,
        path: '/path/to/config',
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      await watchCallback(invalidConfig);

      expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
    });

    it('should update last config reference on changes', async () => {
      const mockWatcher = { close: vi.fn() };
      let watchCallback: WatchCallback | undefined;

      mockWatchImpl((cb) => {
        watchCallback = cb;
      }, mockWatcher);

      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      const newConfig = {
        config: { servers: [{ command: 'cmd', name: 'watched', transport: 'stdio' }] },
        exists: true,
        path: '/path/to/config',
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      await watchCallback(newConfig);

      // Now get config should return the watched version
      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(newConfig as never);
      const getHandler = handlers.get('mcp:config:get');
      if (!getHandler) {
        throw new Error('get handler not registered');
      }
      const result = await getHandler();

      expect(result).toEqual({
        exists: true,
        path: '/path/to/config',
        servers: [{ name: 'watched', transport: 'stdio' }],
      });
    });
  });

  describe('mcp:config:unwatch', () => {
    it('should stop watching when active', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockResolvedValue(mockWatcher as never);

      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      const unwatchHandler = handlers.get('mcp:config:unwatch');
      if (!unwatchHandler) {
        throw new Error('unwatch handler not registered');
      }
      const result = await unwatchHandler();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(result).toEqual({ watching: false });
    });

    it('should handle unwatch when not watching', async () => {
      const handler = handlers.get('mcp:config:unwatch');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler();

      expect(result).toEqual({ watching: false });
    });

    it('should allow re-watching after unwatch', async () => {
      const mockWatcher1 = { close: vi.fn() };
      const mockWatcher2 = { close: vi.fn() };

      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch
        .mockReturnValueOnce(mockWatcher1 as never)
        .mockReturnValueOnce(mockWatcher2 as never);

      const watchHandler = handlers.get('mcp:config:watch');
      const unwatchHandler = handlers.get('mcp:config:unwatch');

      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});
      expect(watchMcpConfig).toHaveBeenCalledTimes(1);

      if (!unwatchHandler) {
        throw new Error('unwatch handler not registered');
      }
      await unwatchHandler();
      expect(mockWatcher1.close).toHaveBeenCalled();

      await watchHandler({});
      expect(watchMcpConfig).toHaveBeenCalledTimes(2);
    });

    it('should clear unwatch reference after stopping', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockResolvedValue(mockWatcher as never);

      const watchHandler = handlers.get('mcp:config:watch');
      const unwatchHandler = handlers.get('mcp:config:unwatch');

      if (!(watchHandler && unwatchHandler)) {
        throw new Error('handlers not registered');
      }
      await watchHandler({});
      await unwatchHandler();

      // Calling unwatch again should be safe
      const result = await unwatchHandler();
      expect(result).toEqual({ watching: false });
      expect(mockWatcher.close).toHaveBeenCalledTimes(1); // Only called once
    });
  });

  describe('integration scenarios', () => {
    it('should handle watch -> config change -> unwatch flow', async () => {
      const mockWatcher = { close: vi.fn() };
      let watchCallback: WatchCallback | undefined;

      mockWatchImpl((cb) => {
        watchCallback = cb;
      }, mockWatcher);

      // Start watching
      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      // Simulate multiple config changes
      const config1 = {
        config: { servers: [{ command: 'cmd1', name: 'server1', transport: 'stdio' }] },
        exists: true,
        path: '/path/to/config',
      };

      const config2 = {
        exists: false,
        path: '/path/to/config',
      };

      const config3 = {
        config: { servers: [{ command: 'cmd2', name: 'server2', transport: 'stdio' }] },
        exists: true,
        path: '/path/to/config',
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      await watchCallback(config1);
      expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith(config1.config);

      await watchCallback(config2);
      expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });

      await watchCallback(config3);
      expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith(config3.config);

      // Stop watching
      const unwatchHandler = handlers.get('mcp:config:unwatch');
      if (!unwatchHandler) {
        throw new Error('unwatch handler not registered');
      }
      await unwatchHandler();

      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should handle get -> watch -> get flow with same config', async () => {
      const mockConfig = {
        config: { servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }] },
        exists: true,
        loadedAt: Date.now(),
        path: '/path/to/config',
      };

      const mockedLoad = vi.mocked(loadMcpConfig);
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedLoad.mockResolvedValue(mockConfig as never);
      mockedWatch.mockReturnValue({ close: vi.fn() } as never);

      const getHandler = handlers.get('mcp:config:get');
      const watchHandler = handlers.get('mcp:config:watch');
      if (!(getHandler && watchHandler)) {
        throw new Error('handlers not registered');
      }

      const result1 = await getHandler();
      const publicConfig = {
        exists: true,
        loadedAt: mockConfig.loadedAt,
        path: '/path/to/config',
        servers: [{ name: 'test', transport: 'stdio' }],
      };
      expect(result1).toEqual(publicConfig);

      await watchHandler({});

      const result2 = await getHandler();
      expect(result2).toEqual(publicConfig);
    });
  });

  describe('mcp:config:selectPath', () => {
    it('does not hold the config queue while the native dialog is open', async () => {
      const selection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
      vi.mocked(dialog.showOpenDialog).mockReturnValueOnce(selection.promise as never);
      vi.mocked(loadMcpConfig).mockResolvedValueOnce({
        exists: false,
        path: '/tmp/mcp.config.json',
      } as never);
      const selectHandler = handlers.get('mcp:config:selectPath');
      const getHandler = handlers.get('mcp:config:get');
      if (!(selectHandler && getHandler)) {
        throw new Error('config handlers not registered');
      }

      const selected = selectHandler({ sender: { id: 1 } });
      await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalledOnce());
      await expect(getHandler()).resolves.toEqual({
        exists: false,
        path: '/tmp/mcp.config.json',
      });

      selection.resolve({ canceled: true, filePaths: [] });
      await expect(selected).resolves.toBeNull();
    });

    it('returns null when selection is canceled', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      } as never);

      const handler = handlers.get('mcp:config:selectPath');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler({ sender: { id: 1 } });

      expect(result).toBeNull();
    });

    it('returns the selected path when available', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/tmp/mcp.json'],
      } as never);

      const handler = handlers.get('mcp:config:selectPath');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler({ sender: { id: 1 } });

      expect(result).toBe(path.resolve('/tmp/mcp.json'));
    });
  });

  describe('mcp:config:setPath', () => {
    it('updates config path and restarts watcher', async () => {
      const mockWatcher = { close: vi.fn() };
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/tmp/new.json'],
      } as never);
      vi.mocked(watchMcpConfig).mockResolvedValue(mockWatcher as never);
      vi.mocked(loadMcpConfig).mockResolvedValue({
        config: { servers: [] },
        exists: true,
        path: '/tmp/new.json',
      } as never);
      vi.mocked(getMcpConfigPath).mockResolvedValue('/tmp/new.json' as never);

      const handler = handlers.get('mcp:config:setPath');
      const selectHandler = handlers.get('mcp:config:selectPath');
      if (!selectHandler) {
        throw new Error('select handler not registered');
      }
      if (!handler) {
        throw new Error('handler not registered');
      }
      await expect(selectHandler({ sender: { id: 1 } })).resolves.toBe(
        path.resolve('/tmp/new.json')
      );
      const result = await handler({} as never, '/tmp/new.json');

      expect(setCustomMcpConfigPath).toHaveBeenCalledWith(path.resolve('/tmp/new.json'));
      expect(loadMcpConfig).toHaveBeenCalled();
      expect(watchMcpConfig).toHaveBeenCalled();
      expect(result).toEqual({ path: '/tmp/new.json', success: true });
    });

    it('rejects arbitrary renderer-supplied paths that were not selected natively', async () => {
      const handler = handlers.get('mcp:config:setPath');
      if (!handler) {
        throw new Error('handler not registered');
      }

      await expect(handler({} as never, '/Users/test/.ssh/config')).rejects.toThrow(
        'MCP config path must be selected with the native file picker.'
      );
      expect(setCustomMcpConfigPath).not.toHaveBeenCalled();
    });
  });

  describe('mcp:config:readText', () => {
    it.each([undefined, 'invalid_mcp_config: servers.0.auth: unsupported SSE OAuth'])(
      'returns MCP config text with its validation diagnostic: %s',
      async (error) => {
        const document = {
          content: '{\n  "servers": []\n}',
          created: false,
          ...(error === undefined ? {} : { error }),
          exists: true,
          path: '/tmp/mcp.config.json',
        };
        vi.mocked(readMcpConfigText).mockResolvedValue(document);

        const handler = handlers.get('mcp:config:readText');
        if (!handler) {
          throw new Error('handler not registered');
        }

        const result = await handler();
        expect(readMcpConfigText).toHaveBeenCalledWith(true);
        expect(result).toEqual(document);
      }
    );
  });

  describe('mcp:config:writeText', () => {
    it('pauses the owned watcher while writing and reloading clients', async () => {
      vi.mocked(watchMcpConfig).mockResolvedValue({ close: vi.fn() } as never);
      await handlers.get('mcp:config:watch')?.();
      vi.mocked(writeMcpConfigText).mockResolvedValue({
        path: '/tmp/mcp.config.json',
        success: true,
      } as never);
      vi.mocked(loadMcpConfig).mockResolvedValue({
        config: { servers: [] },
        exists: true,
        path: '/tmp/mcp.config.json',
      } as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler({} as never, '{ "servers": [] }');
      expect(watchMcpConfig).toHaveBeenCalledTimes(2);
      expect(writeMcpConfigText).toHaveBeenCalledWith('{ "servers": [] }');
      expect(result).toEqual({ path: '/tmp/mcp.config.json', success: true });
    });

    it('returns validation failure without reloading clients', async () => {
      vi.mocked(writeMcpConfigText).mockResolvedValue({
        error: 'invalid_mcp_config',
        path: '/tmp/mcp.config.json',
        success: false,
      } as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const loadCallsBefore = vi.mocked(loadMcpConfig).mock.calls.length;
      const result = await handler({} as never, '{ invalid }');
      expect(vi.mocked(loadMcpConfig).mock.calls.length).toBe(loadCallsBefore);
      expect(result).toEqual({
        error: 'invalid_mcp_config',
        path: '/tmp/mcp.config.json',
        success: false,
      });
    });

    it('rejects oversized config payloads before validation/write', async () => {
      vi.mocked(getMcpConfigPath).mockResolvedValue('/tmp/mcp.config.json' as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const oversizedContent = 'x'.repeat(1_000_001);
      const result = await handler({} as never, oversizedContent);

      expect(writeMcpConfigText).not.toHaveBeenCalled();
      expect(result).toEqual({
        error: 'MCP config exceeds 1000000 bytes',
        path: '/tmp/mcp.config.json',
        success: false,
      });
    });

    it('rejects non-string config payloads before validation/write', async () => {
      vi.mocked(getMcpConfigPath).mockResolvedValue('/tmp/mcp.config.json' as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler({} as never, 42);

      expect(writeMcpConfigText).not.toHaveBeenCalled();
      expect(result).toEqual({
        error: 'MCP config content must be a string',
        path: '/tmp/mcp.config.json',
        success: false,
      });
    });

    it('rejects empty config payloads before validation/write', async () => {
      vi.mocked(getMcpConfigPath).mockResolvedValue('/tmp/mcp.config.json' as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler({} as never, '   ');

      expect(writeMcpConfigText).not.toHaveBeenCalled();
      expect(result).toEqual({
        error: 'MCP config content cannot be empty',
        path: '/tmp/mcp.config.json',
        success: false,
      });
    });
  });

  describe('mcp:config:createSample', () => {
    it('writes a sample config to disk', async () => {
      const fsp = await import('node:fs/promises');
      const tempDir = await fsp.mkdtemp('/tmp/mcp-sample-');
      const samplePath = `${tempDir}/mcp.config.json`;

      vi.mocked(getMcpConfigPath).mockResolvedValue(samplePath as never);
      vi.mocked(loadMcpConfig).mockResolvedValue({
        config: { servers: [] },
        exists: true,
        path: samplePath,
      } as never);

      const handler = handlers.get('mcp:config:createSample');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler();

      expect(result).toEqual({ path: samplePath, success: true });
      const content = await fsp.readFile(samplePath, 'utf8');
      expect(content).toContain('"servers"');
      expect(getMcpConfigPath).toHaveBeenCalled();

      await fsp.rm(tempDir, { force: true, recursive: true });
    });

    it('refuses to overwrite an existing config file', async () => {
      const fsp = await import('node:fs/promises');
      const tempDir = await fsp.mkdtemp('/tmp/mcp-sample-existing-');
      const samplePath = `${tempDir}/mcp.config.json`;
      const originalContent =
        '{"servers":[{"transport":"stdio","name":"existing","command":"node"}]}';

      await fsp.writeFile(samplePath, originalContent, 'utf8');
      vi.mocked(getMcpConfigPath).mockResolvedValue(samplePath as never);

      const handler = handlers.get('mcp:config:createSample');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler();

      expect(result).toEqual({
        error:
          'MCP config already exists. Select the existing file or reset the path before creating a sample.',
        path: samplePath,
        success: false,
      });
      expect(await fsp.readFile(samplePath, 'utf8')).toBe(originalContent);

      await fsp.rm(tempDir, { force: true, recursive: true });
    });

    it('restarts watcher after creating sample config', async () => {
      const fsp = await import('node:fs/promises');
      const tempDir = await fsp.mkdtemp('/tmp/mcp-sample-watch-');
      const samplePath = `${tempDir}/mcp.config.json`;
      const firstWatcher = { close: vi.fn() };
      const secondWatcher = { close: vi.fn() };

      vi.mocked(watchMcpConfig)
        .mockResolvedValueOnce(firstWatcher as never)
        .mockResolvedValueOnce(secondWatcher as never);
      vi.mocked(getMcpConfigPath).mockResolvedValue(samplePath as never);
      vi.mocked(loadMcpConfig).mockResolvedValue({
        config: { servers: [] },
        exists: true,
        path: samplePath,
      } as never);

      const watchHandler = handlers.get('mcp:config:watch');
      const createSampleHandler = handlers.get('mcp:config:createSample');
      if (!(watchHandler && createSampleHandler)) {
        throw new Error('handlers not registered');
      }

      await watchHandler({});
      const result = await createSampleHandler();

      expect(result).toEqual({ path: samplePath, success: true });
      expect(firstWatcher.close).toHaveBeenCalledTimes(1);
      expect(watchMcpConfig).toHaveBeenCalledTimes(2);

      await fsp.rm(tempDir, { force: true, recursive: true });
    });
  });
});
