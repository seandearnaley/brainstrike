import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mcpToolRegistry } from '@brainstrike/agent';
import { dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupMcpRuntimeForShutdown, registerMcpIpcHandlers } from '../../ipc-mcp';
import { disposeClients, initClients } from '../../mcp';
import {
  getMcpConfigPath,
  loadMcpConfig,
  readMcpConfigText,
  setCustomMcpConfigPath,
  watchMcpConfig,
  writeMcpConfigText,
} from '../../mcp-loader';
import { readOpenAIApiKey } from '../../openai-api-key';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type WatchCallback = (config: unknown) => void;
interface LoadResult {
  config?: { servers?: Array<{ name?: string }> };
}

function mockWatchImpl(setter: (cb: WatchCallback) => void, ret: { close: () => void }) {
  const mock = watchMcpConfig as unknown as import('vitest').Mock<
    [onChange: WatchCallback],
    { close: () => void }
  >;
  mock.mockImplementation((cb: WatchCallback) => {
    setter(cb);
    return ret;
  });
}

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

// Mock dependencies
vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{\n  "servers": []\n}'),
  loadMcpConfig: vi.fn(),
  watchMcpConfig: vi.fn(),
  getMcpConfigPath: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  readMcpConfigText: vi.fn(),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  initClients: vi.fn(),
  disposeClients: vi.fn(),
}));

vi.mock('../../openai-api-key', () => ({
  readOpenAIApiKey: vi.fn(),
}));

const mockSecretsService = {
  saveKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  deleteKey: vi.fn(),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
};

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => mockSecretsService),
}));

describe('ipc-mcp handlers', () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers = new Map();
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
    vi.mocked(readOpenAIApiKey).mockResolvedValue('env-openai-key');

    // Capture handlers when registered
    const mockHandle = ipcMain.handle as unknown as import('vitest').Mock<
      [channel: string, handler: RegisteredHandler],
      void
    >;
    mockHandle.mockImplementation((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    });

    registerMcpIpcHandlers();
    // Ensure clean state for module-level watcher
    const unwatchHandler = handlers.get('mcp:config:unwatch');
    if (unwatchHandler) {
      await unwatchHandler();
    }
  });

  afterEach(() => {
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
      // Config handlers
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:get', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:getPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:setPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:readText', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:writeText', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:selectPath', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:watch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:unwatch', expect.any(Function));

      // Tool handlers
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:list', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:enable', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:disable', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:enableServer', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:disableServer', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:reset', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:tools:getStats', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:createSample', expect.any(Function));

      expect(ipcMain.handle).toHaveBeenCalledTimes(16);
    });

    it('cleans up active watcher, MCP clients, and registry state on shutdown', async () => {
      const mockWatcher = { close: vi.fn() };
      vi.mocked(watchMcpConfig).mockResolvedValue(mockWatcher as never);
      mcpToolRegistry.register('server', {
        'server.tool': { description: 'test tool' },
      });

      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      await cleanupMcpRuntimeForShutdown();

      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      expect(disposeClients).toHaveBeenCalled();
      expect(mcpToolRegistry.getStats()).toEqual({
        disabled: 0,
        enabled: 0,
        servers: 0,
        total: 0,
      });
    });

    it('returned cleanup unregisters handlers and tears down MCP runtime state', async () => {
      const mockWatcher = { close: vi.fn() };
      vi.mocked(watchMcpConfig).mockResolvedValue(mockWatcher as never);
      const unregister = registerMcpIpcHandlers();

      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      unregister();

      expect(mockWatcher.close).toHaveBeenCalledTimes(1);
      expect(disposeClients).toHaveBeenCalled();
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('mcp:config:get');
    });
  });

  describe('mcp:config:get', () => {
    it('should load config and initialize clients when config exists', async () => {
      const mockConfig = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }] },
        loadedAt: Date.now(),
      };

      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(mockConfig as never);

      const handler = handlers.get('mcp:config:get');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler();

      expect(loadMcpConfig).toHaveBeenCalled();
      expect(initClients).toHaveBeenCalledWith(mockConfig.config);
      expect(disposeClients).not.toHaveBeenCalled();
      expect(result).toEqual(mockConfig);
    });

    it('should dispose clients when config does not exist', async () => {
      const mockConfig = {
        path: '/path/to/config',
        exists: false,
      };

      const mockedLoad = vi.mocked(loadMcpConfig);
      const mockedDispose = vi.mocked(disposeClients);
      mockedLoad.mockResolvedValue(mockConfig as never);
      mockedDispose.mockResolvedValue(undefined as never);

      const handler = handlers.get('mcp:config:get');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const initCallsBefore = vi.mocked(initClients).mock.calls.length;
      const disposeCallsBefore = vi.mocked(disposeClients).mock.calls.length;
      const result = await handler();

      expect(loadMcpConfig).toHaveBeenCalled();
      expect(vi.mocked(initClients).mock.calls.length).toBe(initCallsBefore);
      expect(vi.mocked(disposeClients).mock.calls.length).toBeGreaterThan(disposeCallsBefore);
      expect(result).toEqual(mockConfig);
    });

    it('should update last config reference', async () => {
      const mockConfig1 = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'test1', command: 'cmd1' }] },
      };

      const mockConfig2 = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'test2', command: 'cmd2' }] },
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
      expect(result1.config?.servers[0].name).toBe('test1');

      const result2 = (await handler()) as LoadResult;
      expect(result2.config?.servers[0].name).toBe('test2');
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
      let watchCallback: WatchCallback | undefined;

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
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'updated', command: 'cmd' }] },
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      watchCallback(newConfig);

      expect(initClients).toHaveBeenCalledWith(newConfig.config);
      expect(disposeClients).not.toHaveBeenCalled();
    });

    it('should dispose clients when config becomes invalid', async () => {
      const mockWatcher = { close: vi.fn() };
      let watchCallback: WatchCallback | undefined;

      mockWatchImpl((cb) => {
        watchCallback = cb;
      }, mockWatcher);
      const mockedDispose = vi.mocked(disposeClients);
      mockedDispose.mockResolvedValue(undefined as never);

      const handler = handlers.get('mcp:config:watch');
      if (!handler) {
        throw new Error('handler not registered');
      }
      await handler({});

      // Simulate config removal
      const invalidConfig = {
        path: '/path/to/config',
        exists: false,
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      watchCallback(invalidConfig);

      expect(initClients).not.toHaveBeenCalled();
      expect(disposeClients).toHaveBeenCalled();
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
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'watched', command: 'cmd' }] },
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      watchCallback(newConfig);

      // Now get config should return the watched version
      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(newConfig as never);
      const getHandler = handlers.get('mcp:config:get');
      if (!getHandler) {
        throw new Error('get handler not registered');
      }
      const result = await getHandler();

      expect(result).toEqual(newConfig);
    });
  });

  describe('mcp:config:unwatch', () => {
    it('should stop watching when active', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockResolvedValue(mockWatcher as never);

      // Start watching first
      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      // Then stop watching
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

      // First watch
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});
      expect(watchMcpConfig).toHaveBeenCalledTimes(1);

      // Unwatch
      if (!unwatchHandler) {
        throw new Error('unwatch handler not registered');
      }
      await unwatchHandler();
      expect(mockWatcher1.close).toHaveBeenCalled();

      // Watch again
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
      const mockedDispose = vi.mocked(disposeClients);
      mockedDispose.mockResolvedValue(undefined as never);

      // Start watching
      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) {
        throw new Error('watch handler not registered');
      }
      await watchHandler({});

      // Simulate multiple config changes
      const config1 = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'server1', command: 'cmd1' }] },
      };

      const config2 = {
        path: '/path/to/config',
        exists: false,
      };

      const config3 = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'server2', command: 'cmd2' }] },
      };

      if (!watchCallback) {
        throw new Error('watch callback not set');
      }
      watchCallback(config1);
      expect(initClients).toHaveBeenLastCalledWith(config1.config);

      watchCallback(config2);
      expect(disposeClients).toHaveBeenCalled();

      watchCallback(config3);
      expect(initClients).toHaveBeenLastCalledWith(config3.config);

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
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'test', command: 'cmd' }] },
        loadedAt: Date.now(),
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

      const initCallsBefore = vi.mocked(initClients).mock.calls.length;
      const result1 = await getHandler();
      expect(result1).toEqual(mockConfig);

      await watchHandler({});

      const result2 = await getHandler();
      expect(result2).toEqual(mockConfig);

      expect(vi.mocked(initClients).mock.calls.length - initCallsBefore).toBe(2);
    });
  });

  describe('mcp:config:selectPath', () => {
    it('returns null when selection is canceled', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      } as never);

      const handler = handlers.get('mcp:config:selectPath');
      if (!handler) {
        throw new Error('handler not registered');
      }
      const result = await handler();

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
      const result = await handler();

      expect(result).toBe('/tmp/mcp.json');
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
        path: '/tmp/new.json',
        exists: true,
        config: { servers: [] },
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
      await expect(selectHandler()).resolves.toBe('/tmp/new.json');
      const result = await handler({} as never, '/tmp/new.json');

      expect(setCustomMcpConfigPath).toHaveBeenCalledWith('/tmp/new.json');
      expect(loadMcpConfig).toHaveBeenCalled();
      expect(watchMcpConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true, path: '/tmp/new.json' });
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
    it('returns MCP config text document', async () => {
      vi.mocked(readMcpConfigText).mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      } as never);

      const handler = handlers.get('mcp:config:readText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler();
      expect(readMcpConfigText).toHaveBeenCalledWith(true);
      expect(result).toEqual({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
    });
  });

  describe('mcp:config:writeText', () => {
    it('writes valid config and reloads active clients', async () => {
      vi.mocked(writeMcpConfigText).mockResolvedValue({
        success: true,
        path: '/tmp/mcp.config.json',
      } as never);
      vi.mocked(loadMcpConfig).mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        config: { servers: [] },
      } as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler({} as never, '{ "servers": [] }');
      expect(writeMcpConfigText).toHaveBeenCalledWith('{ "servers": [] }');
      expect(loadMcpConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true, path: '/tmp/mcp.config.json' });
    });

    it('returns validation failure without reloading clients', async () => {
      vi.mocked(writeMcpConfigText).mockResolvedValue({
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'invalid_mcp_config',
      } as never);

      const handler = handlers.get('mcp:config:writeText');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const loadCallsBefore = vi.mocked(loadMcpConfig).mock.calls.length;
      const result = await handler({} as never, '{ invalid }');
      expect(vi.mocked(loadMcpConfig).mock.calls.length).toBe(loadCallsBefore);
      expect(result).toEqual({
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'invalid_mcp_config',
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
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'MCP config exceeds 1000000 bytes',
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
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'MCP config content must be a string',
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
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'MCP config content cannot be empty',
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
        path: samplePath,
        exists: true,
        config: { servers: [] },
      } as never);

      const handler = handlers.get('mcp:config:createSample');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const result = await handler();

      expect(result).toEqual({ success: true, path: samplePath });
      const content = await fsp.readFile(samplePath, 'utf8');
      expect(content).toContain('"servers"');
      expect(getMcpConfigPath).toHaveBeenCalled();

      await fsp.rm(tempDir, { recursive: true, force: true });
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
        success: false,
        path: samplePath,
        error:
          'MCP config already exists. Select the existing file or reset the path before creating a sample.',
      });
      expect(await fsp.readFile(samplePath, 'utf8')).toBe(originalContent);

      await fsp.rm(tempDir, { recursive: true, force: true });
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
        path: samplePath,
        exists: true,
        config: { servers: [] },
      } as never);

      const watchHandler = handlers.get('mcp:config:watch');
      const createSampleHandler = handlers.get('mcp:config:createSample');
      if (!(watchHandler && createSampleHandler)) {
        throw new Error('handlers not registered');
      }

      await watchHandler({});
      const result = await createSampleHandler();

      expect(result).toEqual({ success: true, path: samplePath });
      expect(firstWatcher.close).toHaveBeenCalledTimes(1);
      expect(watchMcpConfig).toHaveBeenCalledTimes(2);

      await fsp.rm(tempDir, { recursive: true, force: true });
    });
  });
});
