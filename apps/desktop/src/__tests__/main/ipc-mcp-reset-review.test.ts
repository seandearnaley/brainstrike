import { mcpToolRegistry } from '@brainstrike/agent';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import {
  getMcpConfigPath,
  loadMcpConfig,
  setCustomMcpConfigPath,
  watchMcpConfig,
} from '../../mcp-loader';
import { createRecordingWindow } from '../helpers/electron-main-test-harness';
import { adaptMcpHandlerForVisibleUi } from '../helpers/mcp-authorized-handler-test-adapter';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type WatchCallback = (config: unknown) => Promise<void>;

function ipcEvent(senderId: number): { sender: { id: number } } {
  return { sender: { id: senderId } };
}

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

  it('cleans up the active watcher, host, and registry state on shutdown', async () => {
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
    expect(authority.runtime.host.close).toHaveBeenCalledOnce();
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

    // A window has to be IN the listing for the assertions below to mean
    // anything: `notifyMcpConfigUpdated` broadcasts by iterating
    // `getAllWindows()`, so against the empty default this test's
    // `not.toHaveBeenCalled()` would hold no matter what resume published
    // (BST-1622).
    const rendererWindow = createRecordingWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      rendererWindow as unknown as BrowserWindow,
    ]);
    const send = rendererWindow.send;
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

  it('deduplicates concurrent native config selections without occupying the config queue', async () => {
    const selection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValue(selection.promise);
    const selectHandler = handlers.get('mcp:config:selectPath');
    if (!selectHandler) {
      throw new Error('select handler not registered');
    }

    const first = selectHandler(ipcEvent(1));
    const second = selectHandler(ipcEvent(1));
    await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalledOnce());
    selection.resolve({ canceled: false, filePaths: ['/tmp/selected.json'] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      '/tmp/selected.json',
      '/tmp/selected.json',
    ]);
  });

  it('rejects cross-window native config selection while coalescing same-window clicks', async () => {
    const selection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValue(selection.promise);
    const selectHandler = handlers.get('mcp:config:selectPath');
    if (!selectHandler) {
      throw new Error('select handler not registered');
    }

    const first = selectHandler(ipcEvent(1));
    const sameWindow = selectHandler(ipcEvent(1));
    const differentWindow = selectHandler(ipcEvent(2));
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();

    selection.resolve({ canceled: false, filePaths: ['/tmp/selected.json'] });
    await expect(differentWindow).rejects.toThrow(
      'MCP config path selection is already active for another window'
    );
    await expect(Promise.all([first, sameWindow])).resolves.toEqual([
      '/tmp/selected.json',
      '/tmp/selected.json',
    ]);
  });

  it('does not grant the working directory when the native picker returns an empty path', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [''],
    });
    const selectHandler = handlers.get('mcp:config:selectPath');
    const setPathHandler = handlers.get('mcp:config:setPath');
    if (!(selectHandler && setPathHandler)) {
      throw new Error('config path handlers not registered');
    }

    await expect(selectHandler(ipcEvent(1))).resolves.toBeNull();
    await expect(setPathHandler(ipcEvent(1), process.cwd())).rejects.toThrow(
      'MCP config path must be selected with the native file picker.'
    );
  });

  it('does not supersede a native selection when an invalid path mutation is rejected', async () => {
    const selection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValueOnce(selection.promise);
    const selectHandler = handlers.get('mcp:config:selectPath');
    const setPathHandler = handlers.get('mcp:config:setPath');
    if (!(selectHandler && setPathHandler)) {
      throw new Error('config path handlers not registered');
    }

    const pendingSelection = selectHandler(ipcEvent(1));
    await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalledOnce());
    await expect(setPathHandler(ipcEvent(1), '/Users/test/unselected.json')).rejects.toThrow(
      'MCP config path must be selected with the native file picker.'
    );
    selection.resolve({ canceled: false, filePaths: ['/tmp/selected-after-rejection.json'] });

    await expect(pendingSelection).resolves.toBe('/tmp/selected-after-rejection.json');
    expect(setCustomMcpConfigPath).not.toHaveBeenCalled();
  });

  it('rejects a native selection superseded by a later config-path mutation', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/current.json'],
    });
    const selectHandler = handlers.get('mcp:config:selectPath');
    const setPathHandler = handlers.get('mcp:config:setPath');
    if (!(selectHandler && setPathHandler)) {
      throw new Error('config path handlers not registered');
    }
    await selectHandler(ipcEvent(1));

    const laterSelection = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValueOnce(laterSelection.promise);
    vi.mocked(getMcpConfigPath).mockResolvedValue('/tmp/current.json');
    vi.mocked(loadMcpConfig).mockResolvedValue({
      config: { servers: [] },
      exists: true,
      path: '/tmp/current.json',
    });
    const pendingSelection = selectHandler(ipcEvent(1));
    await vi.waitFor(() => expect(dialog.showOpenDialog).toHaveBeenCalledTimes(2));
    await setPathHandler({}, '/tmp/current.json');
    laterSelection.resolve({ canceled: false, filePaths: ['/tmp/stale.json'] });

    await expect(pendingSelection).rejects.toThrow(
      'MCP config path selection was superseded before completion'
    );
    await expect(setPathHandler({}, '/tmp/stale.json')).rejects.toThrow(
      'MCP config path must be selected with the native file picker.'
    );
    expect(setCustomMcpConfigPath).toHaveBeenCalledOnce();
  });

  it('drains a queued watcher install before unwatch returns', async () => {
    const slowLoad = Promise.withResolvers<{ exists: boolean; path: string }>();
    const watcher = { close: vi.fn() };
    vi.mocked(loadMcpConfig).mockReturnValueOnce(slowLoad.promise);
    vi.mocked(watchMcpConfig).mockResolvedValueOnce(watcher);
    const getHandler = handlers.get('mcp:config:get');
    const watchHandler = handlers.get('mcp:config:watch');
    const unwatchHandler = handlers.get('mcp:config:unwatch');
    if (!(getHandler && watchHandler && unwatchHandler)) {
      throw new Error('config handlers not registered');
    }

    const getPending = getHandler();
    const watchPending = watchHandler({});
    const unwatchPending = unwatchHandler();
    expect(watcher.close).not.toHaveBeenCalled();
    slowLoad.resolve({ exists: false, path: '/tmp/mcp.config.json' });

    await expect(Promise.all([getPending, watchPending, unwatchPending])).resolves.toEqual([
      { exists: false, path: '/tmp/mcp.config.json' },
      { watching: true },
      { watching: false },
    ]);
    expect(watcher.close).toHaveBeenCalledOnce();
  });

  it('closes the watcher after a queued config operation rejects', async () => {
    const watcher = { close: vi.fn() };
    vi.mocked(watchMcpConfig).mockResolvedValueOnce(watcher);
    const watchHandler = handlers.get('mcp:config:watch');
    const getHandler = handlers.get('mcp:config:get');
    const unwatchHandler = handlers.get('mcp:config:unwatch');
    if (!(watchHandler && getHandler && unwatchHandler)) {
      throw new Error('config handlers not registered');
    }
    await watchHandler(ipcEvent(1));

    const load = Promise.withResolvers<{ exists: boolean; path: string }>();
    vi.mocked(loadMcpConfig).mockReturnValueOnce(load.promise);
    const getPending = getHandler(ipcEvent(1));
    const getRejected = expect(getPending).rejects.toThrow('queued load failed');
    const unwatchPending = unwatchHandler(ipcEvent(1));
    expect(watcher.close).not.toHaveBeenCalled();

    load.reject(new Error('queued load failed'));
    await getRejected;
    await expect(unwatchPending).resolves.toEqual({ watching: false });
    expect(watcher.close).toHaveBeenCalledOnce();
  });
});
