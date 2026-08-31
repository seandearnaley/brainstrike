import { mcpToolRegistry } from '@brainstrike/agent';
import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { disposeClients } from '../../mcp';
import { loadMcpConfig, watchMcpConfig } from '../../mcp-loader';
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
  getDefaultMcpConfigTemplate: vi.fn(() => '{\n  "servers": []\n}'),
  getMcpConfigPath: vi.fn(async () => '/tmp/mcp.config.json'),
  loadMcpConfig: vi.fn(async () => ({ exists: false, path: '/tmp/mcp.config.json' })),
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: vi.fn() })),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  disposeClients: vi.fn(async () => undefined),
}));

describe('MCP reset review closure', () => {
  let authority: ReturnType<typeof createMcpAuthorityTestRuntime>;
  let handlers: Map<string, RegisteredHandler>;

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers = new Map();
    authority = createMcpAuthorityTestRuntime();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
    vi.mocked(loadMcpConfig).mockResolvedValue({
      exists: false,
      path: '/tmp/mcp.config.json',
    });
    vi.mocked(watchMcpConfig).mockResolvedValue({ close: vi.fn() });
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
  });

  function installWatchCallback(watcher: { close: () => void }): {
    readonly get: () => WatchCallback;
  } {
    let callback: WatchCallback | undefined;
    vi.mocked(watchMcpConfig).mockImplementationOnce(async (onChange) => {
      callback = onChange as WatchCallback;
      return watcher;
    });
    return {
      get: () => {
        if (!callback) {
          throw new Error('watch callback not set');
        }
        return callback;
      },
    };
  }

  it('cleans up the active watcher, MCP clients, and registry state on shutdown', async () => {
    const watcher = { close: vi.fn() };
    vi.mocked(watchMcpConfig).mockResolvedValueOnce(watcher);
    mcpToolRegistry.register('server', {
      'server.tool': { description: 'test tool' },
    });
    const watchHandler = handlers.get('mcp:config:watch');
    if (!watchHandler) {
      throw new Error('watch handler not registered');
    }
    await watchHandler({});

    await mcpIpc.cleanupMcpRuntimeForShutdown(authority.runtime);

    expect(watcher.close).toHaveBeenCalledOnce();
    expect(disposeClients).toHaveBeenCalledOnce();
    expect(mcpToolRegistry.getStats()).toEqual({
      disabled: 0,
      enabled: 0,
      servers: 0,
      total: 0,
    });
  });

  it('restores the newest committed authority when replacements settle out of order', async () => {
    const callback = installWatchCallback({ close: vi.fn() });
    const watchHandler = handlers.get('mcp:config:watch');
    if (!watchHandler) {
      throw new Error('watch handler not registered');
    }
    await watchHandler({});

    const olderConfig = {
      config: { servers: [{ command: 'older', name: 'older', transport: 'stdio' }] },
      exists: true,
      path: '/tmp/older.json',
    };
    const newerConfig = {
      config: { servers: [{ command: 'newer', name: 'newer', transport: 'stdio' }] },
      exists: true,
      path: '/tmp/newer.json',
    };
    const olderReplacement =
      Promise.withResolvers<ReturnType<typeof authority.runtime.host.snapshot>>();

    await authority.replaceResolvedConfig.withImplementation(
      async (config) => {
        if (config.servers[0]?.name === 'older') {
          return await olderReplacement.promise;
        }
        return { revision: 2, servers: [] };
      },
      async () => {
        const olderPending = callback.get()(olderConfig);
        const newerPending = callback.get()(newerConfig);
        await newerPending;
        olderReplacement.resolve({ revision: 1, servers: [] });
        await olderPending;

        await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
        await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');

        expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith(newerConfig.config);
      }
    );
  });

  it('restores authority committed before a newer malformed load', async () => {
    const callback = installWatchCallback({ close: vi.fn() });
    const watchHandler = handlers.get('mcp:config:watch');
    if (!watchHandler) {
      throw new Error('watch handler not registered');
    }
    await watchHandler({});

    const committedConfig = {
      config: { servers: [{ command: 'node', name: 'committed', transport: 'stdio' }] },
      exists: true,
      path: '/tmp/committed.json',
    };
    const replacement = Promise.withResolvers<ReturnType<typeof authority.runtime.host.snapshot>>();

    await authority.replaceResolvedConfig.withImplementation(
      async (config) => {
        if (config.servers[0]?.name === 'committed') {
          return await replacement.promise;
        }
        return { revision: 2, servers: [] };
      },
      async () => {
        const committedPending = callback.get()(committedConfig);
        await vi.waitFor(() =>
          expect(authority.replaceResolvedConfig).toHaveBeenCalledWith(committedConfig.config)
        );
        await callback.get()({
          error: 'invalid JSON',
          exists: true,
          path: '/tmp/malformed.json',
        });
        replacement.resolve({ revision: 1, servers: [] });
        await committedPending;

        await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
        await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');

        expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith(committedConfig.config);
      }
    );
  });

  it('preserves the original authority across a retry after reset already purged it', async () => {
    const callback = installWatchCallback({ close: vi.fn() });
    const watchHandler = handlers.get('mcp:config:watch');
    if (!watchHandler) {
      throw new Error('watch handler not registered');
    }
    await watchHandler({});
    await callback.get()({
      config: { servers: [{ command: 'node', name: 'before-reset', transport: 'stdio' }] },
      exists: true,
      path: '/tmp/before-reset.json',
    });

    await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
    await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');

    expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith({
      servers: [{ command: 'node', name: 'before-reset', transport: 'stdio' }],
    });
  });

  it('publishes a restored projection only after watcher installation and admission reopen', async () => {
    const callback = installWatchCallback({ close: vi.fn() });
    const watchHandler = handlers.get('mcp:config:watch');
    const getHandler = handlers.get('mcp:config:get');
    if (!(watchHandler && getHandler)) {
      throw new Error('config handlers not registered');
    }
    await watchHandler({});
    await callback.get()({
      config: { servers: [{ command: 'node', name: 'restored', transport: 'stdio' }] },
      exists: true,
      path: '/tmp/restored.json',
    });
    await mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime);

    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send },
      } as unknown as BrowserWindow,
    ]);
    const resumedWatcher = { close: vi.fn() };
    const watcherReady = Promise.withResolvers<typeof resumedWatcher>();
    vi.mocked(watchMcpConfig).mockClear();
    vi.mocked(watchMcpConfig).mockReturnValueOnce(watcherReady.promise);

    const resume = mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');
    await vi.waitFor(() => expect(watchMcpConfig).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    await expect(getHandler()).rejects.toThrow('MCP config lifecycle is closed for cleanup');

    watcherReady.resolve(resumedWatcher);
    await resume;

    expect(send).toHaveBeenCalledWith('mcp:config:updated', {
      exists: true,
      path: '/tmp/restored.json',
      servers: [{ name: 'restored', transport: 'stdio' }],
    });
    expect(send).toHaveBeenCalledWith('mcp:tools:updated', {});
  });

  it('does not retain a watcher whose close failed before reset resume', async () => {
    const closeFailure = new Error('old watcher close failed');
    const oldWatcher = {
      close: vi.fn(() => {
        throw closeFailure;
      }),
    };
    const resumedWatcher = { close: vi.fn() };
    vi.mocked(watchMcpConfig)
      .mockResolvedValueOnce(oldWatcher)
      .mockResolvedValueOnce(resumedWatcher);
    const watchHandler = handlers.get('mcp:config:watch');
    const unwatchHandler = handlers.get('mcp:config:unwatch');
    if (!(watchHandler && unwatchHandler)) {
      throw new Error('watch handlers not registered');
    }
    await watchHandler({});

    await expect(mcpIpc.resetMcpRuntimeForFactoryReset(authority.runtime)).rejects.toThrow(
      'MCP runtime reset cleanup failed'
    );
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');
    await unwatchHandler();

    expect(oldWatcher.close).toHaveBeenCalledOnce();
    expect(resumedWatcher.close).toHaveBeenCalledOnce();
  });
});
