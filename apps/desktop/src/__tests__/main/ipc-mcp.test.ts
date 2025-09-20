import { ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMcpIpcHandlers } from '../../ipc-mcp';
import { disposeClients, initClients } from '../../mcp-clients';
import { loadMcpConfig, watchMcpConfig } from '../../mcp-loader';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type WatchCallback = (config: unknown) => void;
type LoadResult = { config?: { servers?: Array<{ name?: string }> } };

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
  },
}));

// Mock dependencies
vi.mock('../../mcp-loader', () => ({
  loadMcpConfig: vi.fn(),
  watchMcpConfig: vi.fn(),
}));

vi.mock('../../mcp-clients', () => ({
  initClients: vi.fn(),
  disposeClients: vi.fn(),
}));

describe('ipc-mcp handlers', () => {
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers = new Map();

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
    if (unwatchHandler) await unwatchHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handler registration', () => {
    it('should register all MCP handlers', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:get', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:watch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('mcp:config:unwatch', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledTimes(3);
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
      if (!handler) throw new Error('handler not registered');
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
      if (!handler) throw new Error('handler not registered');
      const result = await handler();

      expect(loadMcpConfig).toHaveBeenCalled();
      expect(initClients).not.toHaveBeenCalled();
      expect(disposeClients).toHaveBeenCalled();
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
      if (!handler) throw new Error('handler not registered');

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
      mockedWatch.mockReturnValue(mockWatcher as never);

      const handler = handlers.get('mcp:config:watch');
      if (!handler) throw new Error('handler not registered');
      const result = await handler({});

      expect(watchMcpConfig).toHaveBeenCalledWith(expect.any(Function));
      expect(result).toEqual({ watching: true });
    });

    it('should not create duplicate watchers', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockReturnValue(mockWatcher as never);

      const handler = handlers.get('mcp:config:watch');

      if (!handler) throw new Error('handler not registered');
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
      if (!handler) throw new Error('handler not registered');
      await handler({});

      // Simulate config change
      const newConfig = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'updated', command: 'cmd' }] },
      };

      if (!watchCallback) throw new Error('watch callback not set');
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
      if (!handler) throw new Error('handler not registered');
      await handler({});

      // Simulate config removal
      const invalidConfig = {
        path: '/path/to/config',
        exists: false,
      };

      if (!watchCallback) throw new Error('watch callback not set');
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
      if (!watchHandler) throw new Error('watch handler not registered');
      await watchHandler({});

      const newConfig = {
        path: '/path/to/config',
        exists: true,
        config: { servers: [{ transport: 'stdio', name: 'watched', command: 'cmd' }] },
      };

      if (!watchCallback) throw new Error('watch callback not set');
      watchCallback(newConfig);

      // Now get config should return the watched version
      const mockedLoad = vi.mocked(loadMcpConfig);
      mockedLoad.mockResolvedValue(newConfig as never);
      const getHandler = handlers.get('mcp:config:get');
      if (!getHandler) throw new Error('get handler not registered');
      const result = await getHandler();

      expect(result).toEqual(newConfig);
    });
  });

  describe('mcp:config:unwatch', () => {
    it('should stop watching when active', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockReturnValue(mockWatcher as never);

      // Start watching first
      const watchHandler = handlers.get('mcp:config:watch');
      if (!watchHandler) throw new Error('watch handler not registered');
      await watchHandler({});

      // Then stop watching
      const unwatchHandler = handlers.get('mcp:config:unwatch');
      if (!unwatchHandler) throw new Error('unwatch handler not registered');
      const result = await unwatchHandler();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(result).toEqual({ watching: false });
    });

    it('should handle unwatch when not watching', async () => {
      const handler = handlers.get('mcp:config:unwatch');
      if (!handler) throw new Error('handler not registered');
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
      if (!watchHandler) throw new Error('watch handler not registered');
      await watchHandler({});
      expect(watchMcpConfig).toHaveBeenCalledTimes(1);

      // Unwatch
      if (!unwatchHandler) throw new Error('unwatch handler not registered');
      await unwatchHandler();
      expect(mockWatcher1.close).toHaveBeenCalled();

      // Watch again
      await watchHandler({});
      expect(watchMcpConfig).toHaveBeenCalledTimes(2);
    });

    it('should clear unwatch reference after stopping', async () => {
      const mockWatcher = { close: vi.fn() };
      const mockedWatch = vi.mocked(watchMcpConfig);
      mockedWatch.mockReturnValue(mockWatcher as never);

      const watchHandler = handlers.get('mcp:config:watch');
      const unwatchHandler = handlers.get('mcp:config:unwatch');

      if (!watchHandler || !unwatchHandler) throw new Error('handlers not registered');
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
      if (!watchHandler) throw new Error('watch handler not registered');
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

      if (!watchCallback) throw new Error('watch callback not set');
      watchCallback(config1);
      expect(initClients).toHaveBeenLastCalledWith(config1.config);

      watchCallback(config2);
      expect(disposeClients).toHaveBeenCalled();

      watchCallback(config3);
      expect(initClients).toHaveBeenLastCalledWith(config3.config);

      // Stop watching
      const unwatchHandler = handlers.get('mcp:config:unwatch');
      if (!unwatchHandler) throw new Error('unwatch handler not registered');
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
      if (!getHandler || !watchHandler) throw new Error('handlers not registered');

      const result1 = await getHandler();
      expect(result1).toEqual(mockConfig);

      await watchHandler({});

      const result2 = await getHandler();
      expect(result2).toEqual(mockConfig);

      expect(initClients).toHaveBeenCalledTimes(2);
    });
  });
});
