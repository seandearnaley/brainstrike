import { mcpToolRegistry } from '@brainstrike/agent';
import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  disposeClients: vi.fn(async () => undefined),
  loadMcpConfig: vi.fn(async () => ({ exists: false, path: '/tmp/mcp.config.json' })),
  watcherClose: vi.fn(),
}));

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

vi.mock('../../mcp', () => ({
  disposeClients: mocks.disposeClients,
}));

vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{"servers":[]}'),
  getMcpConfigPath: vi.fn(async () => '/tmp/mcp.config.json'),
  loadMcpConfig: mocks.loadMcpConfig,
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: vi.fn(),
  watchMcpConfig: vi.fn(async () => ({ close: mocks.watcherClose })),
  writeMcpConfigText: vi.fn(),
}));

const cleanCloseReport = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 0,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
};

describe('terminal MCP shutdown cleanup', () => {
  beforeEach(() => {
    mcpToolRegistry.clear();
    vi.clearAllMocks();
  });

  it('isolates terminal closure while directly proving watcher, host, and legacy cleanup', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (...args: unknown[]) => unknown);
    });
    const hostClose = vi.fn(async () => cleanCloseReport);
    const runtime = {
      host: {
        close: hostClose,
        invoke: vi.fn(),
        replaceConfig: vi.fn(),
        snapshot: vi.fn(() => ({ revision: 0, servers: [] })),
        watch: vi.fn(() => vi.fn()),
      },
      replaceResolvedConfig: vi.fn(async () => ({ revision: 0, servers: [] })),
    };
    const { cleanupMcpRuntimeForShutdown, registerMcpIpcHandlers } = await import('../../ipc-mcp');
    registerMcpIpcHandlers({ runtime });
    await handlers.get('mcp:status:get')?.();
    const registryClear = vi.mocked(mcpToolRegistry.clear);
    const registryClearsBeforeShutdown = registryClear.mock.calls.length;

    await cleanupMcpRuntimeForShutdown(runtime);

    expect(mocks.watcherClose).toHaveBeenCalledOnce();
    expect(hostClose).toHaveBeenCalledOnce();
    expect(mocks.disposeClients).toHaveBeenCalledOnce();
    expect(registryClear).toHaveBeenCalledTimes(registryClearsBeforeShutdown + 1);
  });

  it('preserves host close-report and legacy cleanup failures together', async () => {
    const hostFailure = { category: 'transport', code: 'child_alive', message: 'child alive' };
    const legacyFailure = new Error('legacy cleanup failed');
    mocks.disposeClients.mockRejectedValueOnce(legacyFailure);
    const runtime = {
      host: {
        close: vi.fn(async () => ({ ...cleanCloseReport, failures: [hostFailure] })),
      },
      replaceResolvedConfig: vi.fn(),
    };
    const { cleanupMcpRuntimeForShutdown } = await import('../../ipc-mcp');

    await expect(cleanupMcpRuntimeForShutdown(runtime as never)).rejects.toMatchObject({
      errors: [hostFailure, legacyFailure],
      message: 'MCP runtime shutdown cleanup failed',
    });
  });
});
