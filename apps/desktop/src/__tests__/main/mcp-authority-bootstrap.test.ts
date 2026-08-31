import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadToolPreferences, mcpToolRegistry } from '@brainstrike/agent';
import {
  type McpHostCloseReport,
  type McpHostOperationResult,
  type McpHostSnapshot,
  type McpHostWatchEvent,
  type McpHostWatchFilter,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { BrowserWindow, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerMcpIpcHandlers,
  resetMcpRuntimeForFactoryReset,
  resumeMcpRuntimeAfterFactoryReset,
} from '../../ipc-mcp';
import type { LoadedMcpConfig, ResolvedMcpConfig } from '../../mcp-loader';

const mocks = vi.hoisted(() => ({
  disposeClients: vi.fn(async () => undefined),
  getClient: vi.fn(),
  getClientStatuses: vi.fn(() => []),
  getMcpConfigPath: vi.fn(async () => '/tmp/mcp.config.json'),
  hostInvoke: vi.fn(),
  initClients: vi.fn(),
  legacyListTools: vi.fn(),
  loadMcpConfig: vi.fn(),
  replaceResolvedConfig: vi.fn(),
  setCustomMcpConfigPath: vi.fn(async (): Promise<void> => undefined),
  watchMcpConfig: vi.fn(),
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

// Global registry and preference mocks come from src/__tests__/setup.ts.
vi.mock('../../mcp', () => ({
  disposeClients: mocks.disposeClients,
  getClient: mocks.getClient,
  getClientStatuses: mocks.getClientStatuses,
  initClients: mocks.initClients,
}));

vi.mock('../../mcp-loader', () => ({
  getDefaultMcpConfigTemplate: vi.fn(() => '{"servers":[]}'),
  getMcpConfigPath: mocks.getMcpConfigPath,
  loadMcpConfig: mocks.loadMcpConfig,
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: mocks.setCustomMcpConfigPath,
  watchMcpConfig: mocks.watchMcpConfig,
  writeMcpConfigText: vi.fn(),
}));

type RegisteredHandler = (...args: unknown[]) => unknown;
type WatchCallback = (config: LoadedMcpConfig) => Promise<void>;

const server = (name: string): ResolvedMcpConfig['servers'][number] => ({
  command: '/test/mcp-server',
  name: parseConfiguredMcpServerId(name),
  protocol: 'legacy',
  transport: 'stdio',
});

const loaded = (name: string): LoadedMcpConfig => ({
  config: { servers: [server(name)] },
  exists: true,
  path: '/tmp/mcp.config.json',
  servers: [server(name)],
});

const snapshot = (
  revision: number,
  servers: ResolvedMcpConfig['servers'] = []
): McpHostSnapshot => ({
  revision,
  servers: servers.map((configuredServer) => ({
    configuredProtocol: configuredServer.protocol,
    configuredServerId: parseConfiguredMcpServerId(configuredServer.name),
    generation: revision,
    state: 'disconnected',
    transport: configuredServer.transport,
  })),
});

const listResult = (
  name: string,
  toolNames: readonly string[] = ['inspect']
): McpHostOperationResult => ({
  result: {
    tools: toolNames.map((toolName) => ({
      description: `${name} tool`,
      inputSchema: { type: 'object' },
      name: toolName,
    })),
  },
  type: 'tools/list',
});

describe('MCP desktop authority bootstrap', () => {
  let handlers: Map<string, RegisteredHandler>;
  let sentEvents: Array<{ channel: string; payload: unknown }>;
  let watchCallback: WatchCallback | undefined;

  const closeReport: McpHostCloseReport = {
    callbacksClosed: 0,
    childProcessesClosed: 0,
    clientsClosed: 0,
    failures: [],
    loopbackPortsClosed: 0,
    probesClosed: 0,
    requestsSettled: 0,
    subscriptionsClosed: 0,
  };
  const runtime = {
    host: {
      close: vi.fn(async () => closeReport),
      invoke: mocks.hostInvoke,
      replaceConfig: vi.fn(),
      snapshot: vi.fn(() => snapshot(0)),
      watch: vi.fn((_filter: McpHostWatchFilter, _listener: (event: McpHostWatchEvent) => void) =>
        vi.fn()
      ),
    },
    replaceResolvedConfig: mocks.replaceResolvedConfig,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mcpToolRegistry.clear();
    handlers = new Map();
    sentEvents = [];
    watchCallback = undefined;
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentEvents.push({ channel, payload });
          },
        },
      },
    ] as never);
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as RegisteredHandler);
    });
    mocks.loadMcpConfig.mockResolvedValue({ exists: false, path: '/tmp/mcp.config.json' });
    vi.mocked(loadToolPreferences).mockResolvedValue({
      disabledTools: [],
      enabledTools: [],
      lastUpdated: 0,
      version: 1,
    });
    mocks.replaceResolvedConfig.mockImplementation(async (config: ResolvedMcpConfig) =>
      snapshot(config.servers.length, config.servers)
    );
    mocks.hostInvoke.mockImplementation(async (operation: { configuredServerId: string }) =>
      listResult(operation.configuredServerId)
    );
    mocks.legacyListTools.mockResolvedValue({
      'legacy.inspect': { description: 'legacy tool', inputSchema: { type: 'object' } },
    });
    mocks.getClient.mockReturnValue({ listTools: mocks.legacyListTools });
    mocks.watchMcpConfig.mockImplementation(async (callback: WatchCallback) => {
      watchCallback = callback;
      return { close: vi.fn() };
    });
  });

  afterEach(async () => {
    await resetMcpRuntimeForFactoryReset(runtime);
    await resumeMcpRuntimeAfterFactoryReset(runtime);
    mcpToolRegistry.clear();
  });

  async function register(startup: LoadedMcpConfig): Promise<void> {
    mocks.loadMcpConfig.mockResolvedValueOnce(startup);
    registerMcpIpcHandlers({ runtime });
    await handlers.get('mcp:status:get')?.();
  }

  it('injects the ready-scoped singleton runtime into MCP IPC', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');
    const readyStart = source.indexOf('app.whenReady()');

    expect(readyStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(readyStart)).toMatch(
      /registerMcpIpcHandlers\(\{\s*runtime:\s*getDesktopMcpHostRuntime\(\)\s*\}\)/
    );
  });

  it('projects the host snapshot and broadcasts revisioned host updates', async () => {
    const current = snapshot(7, [server('github'), server('linear')]);
    let listener: ((event: McpHostWatchEvent) => void) | undefined;
    const stopWatching = vi.fn();
    runtime.host.snapshot.mockReturnValue(current);
    runtime.host.watch.mockImplementationOnce((_filter, nextListener) => {
      listener = nextListener;
      return stopWatching;
    });

    const unregister = registerMcpIpcHandlers({ runtime });
    await expect(handlers.get('mcp:status:get')?.()).resolves.toEqual(current);
    const currentServer = current.servers[0];
    if (!currentServer) {
      throw new Error('Expected current MCP server');
    }

    const secondServer = current.servers[1];
    if (!secondServer) {
      throw new Error('Expected second current MCP server');
    }
    listener?.({
      revision: 8,
      servers: [{ ...currentServer, state: 'connecting' }, secondServer],
    });
    expect(sentEvents).toContainEqual({
      channel: 'mcp:status:updated',
      payload: {
        revision: 8,
        servers: [{ ...currentServer, state: 'connecting' }, secondServer],
      },
    });

    unregister();
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('awaits startup authority replacement before discovering through the host', async () => {
    const config = loaded('team.linear.prod');
    const replacement = Promise.withResolvers<McpHostSnapshot>();
    mocks.loadMcpConfig.mockResolvedValueOnce(config);
    mocks.replaceResolvedConfig.mockReturnValueOnce(replacement.promise);

    registerMcpIpcHandlers({ runtime });
    await vi.waitFor(() => expect(mocks.replaceResolvedConfig).toHaveBeenCalledWith(config.config));
    expect(mocks.hostInvoke).not.toHaveBeenCalled();

    replacement.resolve(snapshot(1, config.config?.servers));
    await handlers.get('mcp:status:get')?.();

    expect(mocks.hostInvoke).toHaveBeenCalledWith({
      configuredServerId: 'team.linear.prod',
      type: 'tools/list',
    });
    expect(mocks.initClients).not.toHaveBeenCalled();
    expect(mcpToolRegistry.register).toHaveBeenCalledWith(
      'team.linear.prod',
      expect.objectContaining({ 'team.linear.prod.inspect': expect.any(Object) }),
      undefined
    );
  });

  it('preserves committed host and tools when a watched config is malformed', async () => {
    await register(loaded('linear'));
    const replaceCalls = mocks.replaceResolvedConfig.mock.calls.length;
    const clearCalls = vi.mocked(mcpToolRegistry.clear).mock.calls.length;
    const registerCalls = vi.mocked(mcpToolRegistry.register).mock.calls.length;
    sentEvents = [];
    if (!watchCallback) {
      throw new Error('Expected config watcher callback');
    }

    await watchCallback({ error: 'invalid JSON', exists: true, path: '/tmp/mcp.config.json' });

    expect(mocks.replaceResolvedConfig).toHaveBeenCalledTimes(replaceCalls);
    expect(mcpToolRegistry.clear).toHaveBeenCalledTimes(clearCalls);
    expect(mcpToolRegistry.register).toHaveBeenCalledTimes(registerCalls);
    expect(sentEvents).not.toContainEqual(
      expect.objectContaining({ channel: 'mcp:tools:updated' })
    );
  });

  it('publishes explicit empty authority atomically only for an absent config', async () => {
    await register(loaded('linear'));
    vi.mocked(loadToolPreferences).mockClear();
    const replacement = Promise.withResolvers<McpHostSnapshot>();
    mocks.replaceResolvedConfig.mockReturnValueOnce(replacement.promise);
    const clearCalls = vi.mocked(mcpToolRegistry.clear).mock.calls.length;
    sentEvents = [];
    if (!watchCallback) {
      throw new Error('Expected config watcher callback');
    }

    const reload = watchCallback({ exists: false, path: '/tmp/mcp.config.json' });
    await vi.waitFor(() =>
      expect(mocks.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] })
    );
    expect(mcpToolRegistry.clear).toHaveBeenCalledTimes(clearCalls);
    expect(sentEvents).not.toContainEqual(
      expect.objectContaining({ channel: 'mcp:tools:updated' })
    );

    replacement.resolve(snapshot(2));
    await reload;

    expect(mcpToolRegistry.clear).toHaveBeenCalledTimes(clearCalls + 1);
    expect(loadToolPreferences).not.toHaveBeenCalled();
    expect(sentEvents.filter(({ channel }) => channel === 'mcp:tools:updated')).toHaveLength(1);
  });

  it('rejects duplicate tool names without publishing a partial registry', async () => {
    mocks.hostInvoke.mockResolvedValueOnce(listResult('duplicate', ['inspect', 'inspect']));

    await register(loaded('duplicate'));

    expect(mcpToolRegistry.register).not.toHaveBeenCalled();
  });

  it('discovers only servers present in the committed host snapshot', async () => {
    const config: LoadedMcpConfig = {
      config: { servers: [server('committed'), server('rejected')] },
      exists: true,
      path: '/tmp/mcp.config.json',
      servers: [server('committed'), server('rejected')],
    };
    mocks.replaceResolvedConfig.mockResolvedValueOnce(snapshot(1, [server('committed')]));

    await register(config);

    expect(mocks.hostInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.hostInvoke).toHaveBeenCalledWith({
      configuredServerId: 'committed',
      type: 'tools/list',
    });
    expect(mcpToolRegistry.register).toHaveBeenCalledTimes(1);
    expect(mcpToolRegistry.register).toHaveBeenCalledWith(
      'committed',
      expect.objectContaining({ 'committed.inspect': expect.any(Object) }),
      undefined
    );
  });

  it('drops stale discovery after a newer valid config commits', async () => {
    const firstDiscovery = Promise.withResolvers<McpHostOperationResult>();
    mocks.hostInvoke
      .mockImplementationOnce(async () => await firstDiscovery.promise)
      .mockResolvedValueOnce(listResult('new'));
    mocks.loadMcpConfig.mockResolvedValueOnce(loaded('old'));
    registerMcpIpcHandlers({ runtime });
    await vi.waitFor(() => expect(mocks.hostInvoke).toHaveBeenCalledOnce());
    if (!watchCallback) {
      throw new Error('Expected config watcher callback');
    }

    await watchCallback(loaded('new'));
    firstDiscovery.resolve(listResult('old'));
    await handlers.get('mcp:status:get')?.();

    expect(mcpToolRegistry.register).toHaveBeenCalledTimes(1);
    expect(mcpToolRegistry.register).toHaveBeenCalledWith(
      'new',
      expect.objectContaining({ 'new.inspect': expect.any(Object) }),
      undefined
    );
    const toolEvents = sentEvents.filter(({ channel }) => channel === 'mcp:tools:updated');
    expect(toolEvents).toHaveLength(1);
  });

  it('fences a complete path mutation before reset and restores one permanent watcher', async () => {
    await register(loaded('linear'));
    const pathMutation = Promise.withResolvers<void>();
    mocks.setCustomMcpConfigPath.mockImplementationOnce(async () => await pathMutation.promise);

    const mutation = handlers.get('mcp:config:setPath')?.({}, null);
    await vi.waitFor(() => expect(mocks.setCustomMcpConfigPath).toHaveBeenCalledOnce());
    const replacementsBeforeReset = mocks.replaceResolvedConfig.mock.calls.length;
    const reset = resetMcpRuntimeForFactoryReset(runtime);
    await Promise.resolve();
    expect(mocks.replaceResolvedConfig).toHaveBeenCalledTimes(replacementsBeforeReset);

    pathMutation.resolve();
    await mutation;
    await reset;
    expect(mocks.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });

    const watcherBeforeResume = watchCallback;
    await resumeMcpRuntimeAfterFactoryReset(runtime);
    expect(mocks.watchMcpConfig).toHaveBeenCalledTimes(3);
    expect(watchCallback).not.toBe(watcherBeforeResume);
  });

  it('pins mutation-sensitive shutdown ordering, reset wiring, and aggregate serialization', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');
    const assistantDrain = source.indexOf("runShutdownStep('assistant-server'");
    const mcpClose = source.indexOf("runShutdownStep('mcp-runtime'");
    expect(assistantDrain).toBeGreaterThanOrEqual(0);
    expect(mcpClose).toBeGreaterThan(assistantDrain);
    expect(source).toContain('if (assistantServerDrained)');
    expect(source).toContain('errors: error.errors.map(serializeDesktopError)');
    expect(source).toContain("typeof record['category'] === 'string'");
    expect(source).toContain("typeof record['code'] === 'string'");
    expect(source).toContain('await Promise.allSettled([stopServer()])');
    expect(source).toMatch(/resumeAfterReset:[\s\S]*resumeMcpRuntimeAfterFactoryReset/);
  });
});
