import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  callOrder,
  registerToolsMock,
  disableToolsMock,
  enableToolsMock,
  getStatsMock,
  getAllToolsMock,
  getEnabledToolsMock,
  enableServerToolsMock,
  disableServerToolsMock,
  resetToolsMock,
  listToolsMock,
  loadToolPreferencesMock,
  saveToolPreferencesMock,
  loadMcpConfigMock,
  watchMcpConfigMock,
  getMcpConfigPathMock,
  setCustomMcpConfigPathMock,
  ipcHandleMock,
  showOpenDialogMock,
  getPathMock,
} = vi.hoisted(() => {
  const order: string[] = [];

  const register = vi.fn(() => {
    order.push('register-tools');
  });

  const disable = vi.fn((toolIds: string[]) => {
    order.push('disable-tools');
    return toolIds;
  });

  const enable = vi.fn((toolIds: string[]) => {
    order.push('enable-tools');
    return toolIds;
  });

  const getStats = vi.fn(() => ({ disabled: 1, enabled: 1, servers: 1, total: 2 }));
  // Mock registered tools that match the preference IDs being tested
  const getAllTools = vi.fn(() => ({
    'mock-server': [
      { enabled: true, id: 'mock-server.tool.enable' },
      { enabled: false, id: 'mock-server.tool.disable' },
    ],
  }));
  const getEnabledTools = vi.fn(() => ({}));
  const enableServerTools = vi.fn();
  const disableServerTools = vi.fn();
  const reset = vi.fn();

  const loadPreferences = vi.fn(async () => {
    order.push('load-preferences');
    return {
      disabledTools: ['mock-server.tool.disable'],
      enabledTools: ['mock-server.tool.enable'],
      lastUpdated: 0,
      version: 1,
    };
  });

  const savePreferences = vi.fn();

  const loadConfig = vi.fn(async () => ({
    config: {
      servers: [
        {
          command: 'bin/mock',
          name: 'mock-server',
          transport: 'stdio',
        },
      ],
    },
    exists: true,
    path: '/mock/config.json',
  }));

  const watchConfig = vi.fn(async () => ({ close: vi.fn() }));
  const getConfigPath = vi.fn(async () => '/mock/path');
  const setCustomConfigPath = vi.fn(async () => {});

  const listTools = vi.fn(
    async (
      _serverName: string
    ): Promise<Record<string, { description: string; inputSchema?: unknown }>> => {
      order.push('list-tools');
      return {
        'mock-server.tool.disable': { description: 'Disabled tool' },
        'mock-server.tool.enable': { description: 'Enabled tool' },
      };
    }
  );

  const ipcHandle = vi.fn();
  const showOpenDialog = vi.fn();
  const getPath = vi.fn(() => 'mock-user-data');

  return {
    callOrder: order,
    disableServerToolsMock: disableServerTools,
    disableToolsMock: disable,
    enableServerToolsMock: enableServerTools,
    enableToolsMock: enable,
    getAllToolsMock: getAllTools,
    getEnabledToolsMock: getEnabledTools,
    getMcpConfigPathMock: getConfigPath,
    getPathMock: getPath,
    getStatsMock: getStats,
    ipcHandleMock: ipcHandle,
    listToolsMock: listTools,
    loadMcpConfigMock: loadConfig,
    loadToolPreferencesMock: loadPreferences,
    registerToolsMock: register,
    resetToolsMock: reset,
    saveToolPreferencesMock: savePreferences,
    setCustomMcpConfigPathMock: setCustomConfigPath,
    showOpenDialogMock: showOpenDialog,
    watchMcpConfigMock: watchConfig,
  };
});

vi.mock('@brainstrike/agent', () => ({
  __esModule: true,
  loadToolPreferences: loadToolPreferencesMock,
  mcpToolRegistry: {
    clear: vi.fn(), // New method used for stale preferences fix
    disableServerTools: disableServerToolsMock,
    disableTools: disableToolsMock,
    enableServerTools: enableServerToolsMock,
    enableTools: enableToolsMock,
    getAllTools: getAllToolsMock,
    getEnabledTools: getEnabledToolsMock,
    getStats: getStatsMock,
    register: registerToolsMock,
    reset: resetToolsMock,
  },
  saveToolPreferences: saveToolPreferencesMock,
}));

vi.mock('../../mcp-loader', () => ({
  __esModule: true,
  getDefaultMcpConfigTemplate: () => '{\n  "servers": []\n}',
  getMcpConfigPath: getMcpConfigPathMock,
  loadMcpConfig: loadMcpConfigMock,
  readMcpConfigText: vi.fn(),
  setCustomMcpConfigPath: setCustomMcpConfigPathMock,
  watchMcpConfig: watchMcpConfigMock,
  writeMcpConfigText: vi.fn(),
}));

vi.mock('electron', () => ({
  __esModule: true,
  app: { getPath: getPathMock },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: ipcHandleMock },
}));

import { loadToolPreferences, mcpToolRegistry } from '@brainstrike/agent';
import {
  registerMcpIpcHandlers,
  resetMcpRuntimeForFactoryReset,
  resumeMcpRuntimeAfterFactoryReset,
} from '../../ipc-mcp';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

const authority = createMcpAuthorityTestRuntime(async (serverId) => {
  const discovered = await listToolsMock(serverId);
  return {
    tools: Object.entries(discovered).map(([toolId, tool]) => {
      if (!(typeof tool === 'object' && tool)) {
        throw new Error('Expected discovered tool metadata');
      }
      return {
        ...('description' in tool && typeof tool.description === 'string'
          ? { description: tool.description }
          : {}),
        inputSchema: { type: 'object' },
        name: toolId.includes('.') ? toolId.slice(toolId.indexOf('.') + 1) : toolId,
      };
    }),
  };
});

async function waitForPreferencesCall(): Promise<void> {
  const deadline = Date.now() + 1000;
  while (loadToolPreferencesMock.mock.calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for loadToolPreferences call');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('ipc-mcp tool preference loading', () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime);
    callOrder.length = 0;
  });

  it('applies persisted tool preferences after discovery completes', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });

    await waitForPreferencesCall();

    expect(loadToolPreferences).toHaveBeenCalledWith('mock-user-data');
    expect(mcpToolRegistry.disableTools).toHaveBeenCalledWith(['mock-server.tool.disable']);
    expect(mcpToolRegistry.enableTools).toHaveBeenCalledWith(['mock-server.tool.enable']);

    const registerIndex = callOrder.indexOf('register-tools');
    const listIndex = callOrder.indexOf('list-tools');
    const loadIndex = callOrder.indexOf('load-preferences');

    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(loadIndex).toBeGreaterThan(listIndex);
    expect(registerIndex).toBeGreaterThan(loadIndex);

    expect(callOrder).toContain('disable-tools');
    expect(callOrder).toContain('enable-tools');
  });

  it('discovers tools for the filesystem MCP server', async () => {
    loadMcpConfigMock.mockResolvedValueOnce({
      config: {
        servers: [
          {
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            command: 'npx',
            name: 'filesystem',
            transport: 'stdio',
          },
        ],
      },
      exists: true,
      path: '/mock/config.json',
    } as unknown as Awaited<ReturnType<typeof loadMcpConfigMock>>);
    listToolsMock.mockResolvedValueOnce({
      'filesystem.list_directory': {
        description: 'Get a detailed listing of files and directories.',
        inputSchema: { type: 'filesystem.list_directory.schema' },
      },
      'filesystem.read_file': {
        description: 'Read the complete contents of a file from the file system.',
        inputSchema: { type: 'filesystem.read_file.schema' },
      },
      'filesystem.search_files': {
        description: 'Recursively search for files in a directory.',
        inputSchema: { type: 'filesystem.search_files.schema' },
      },
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(registerToolsMock).toHaveBeenCalledWith(
      'filesystem',
      expect.objectContaining({
        'filesystem.list_directory': expect.objectContaining({
          description: expect.stringContaining('listing'),
          inputSchema: { type: 'object' },
        }),
        'filesystem.read_file': expect.objectContaining({
          description: expect.stringContaining('Read the complete contents'),
          inputSchema: { type: 'object' },
        }),
        'filesystem.search_files': expect.objectContaining({
          description: expect.stringContaining('search for files'),
          inputSchema: { type: 'object' },
        }),
      }),
      undefined
    );
    expect(loadToolPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('discards legacy sanitized preference ids instead of applying them', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      disabledTools: ['filesystem_list_directory'],
      enabledTools: ['filesystem_read_file'],
      lastUpdated: 0,
      version: 1,
    });
    getAllToolsMock.mockReturnValueOnce({
      filesystem: [
        { enabled: true, id: 'filesystem.read_file' },
        { enabled: true, id: 'filesystem.list_directory' },
      ],
    } as unknown as ReturnType<typeof getAllToolsMock>);

    registerMcpIpcHandlers({ runtime: authority.runtime });

    await waitForPreferencesCall();

    expect(mcpToolRegistry.enableTools).not.toHaveBeenCalled();
    expect(mcpToolRegistry.disableTools).not.toHaveBeenCalled();
    expect(saveToolPreferencesMock).toHaveBeenCalledWith(
      'mock-user-data',
      expect.objectContaining({
        disabledTools: [],
        enabledTools: [],
      })
    );
  });

  it('still applies valid preferences when persisting cleaned ids fails', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      disabledTools: ['mock-server.tool.disable', 'filesystem_list_directory'],
      enabledTools: ['mock-server.tool.enable', 'filesystem_read_file'],
      lastUpdated: 0,
      version: 1,
    });
    saveToolPreferencesMock.mockRejectedValueOnce(new Error('disk full'));
    getAllToolsMock.mockReturnValueOnce({
      'mock-server': [
        { enabled: true, id: 'mock-server.tool.enable' },
        { enabled: false, id: 'mock-server.tool.disable' },
      ],
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });

    await waitForPreferencesCall();

    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
    expect(mcpToolRegistry.disableTools).toHaveBeenCalledWith(['mock-server.tool.disable']);
    expect(mcpToolRegistry.enableTools).toHaveBeenCalledWith(['mock-server.tool.enable']);
  });

  it('fences preference persistence before factory reset purges the runtime', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    const preferenceWrite = Promise.withResolvers<void>();
    saveToolPreferencesMock.mockReturnValueOnce(preferenceWrite.promise);
    const registration = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === 'mcp:tools:disable'
    );
    const disable = registration?.[1] as
      | ((event: unknown, toolIds: string[]) => Promise<void>)
      | undefined;
    if (!disable) {
      throw new Error('tools:disable handler not registered');
    }

    const mutation = disable({}, ['mock-server.tool.disable']);
    await vi.waitFor(() => expect(saveToolPreferencesMock).toHaveBeenCalledOnce());
    const replacementsBeforeReset = authority.replaceResolvedConfig.mock.calls.length;
    const reset = resetMcpRuntimeForFactoryReset(authority.runtime);
    await new Promise((resolve) => setImmediate(resolve));
    expect(authority.replaceResolvedConfig).toHaveBeenCalledTimes(replacementsBeforeReset);

    preferenceWrite.resolve();
    await mutation;
    await reset;
    expect(authority.replaceResolvedConfig).toHaveBeenCalledTimes(replacementsBeforeReset + 1);
    expect(authority.replaceResolvedConfig).toHaveBeenLastCalledWith({ servers: [] });
  });

  it('rejects a deferred tool mutation when a queued config reload rebuilds the registry', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    const configPathWrite = Promise.withResolvers<void>();
    setCustomMcpConfigPathMock.mockImplementationOnce(async () => await configPathWrite.promise);
    const setPath = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === 'mcp:config:setPath'
    )?.[1] as ((event: unknown, configPath: null) => Promise<unknown>) | undefined;
    const disable = ipcHandleMock.mock.calls.find(
      ([channel]) => channel === 'mcp:tools:disable'
    )?.[1] as ((event: unknown, toolIds: string[]) => Promise<void>) | undefined;
    if (!(setPath && disable)) {
      throw new Error('config and tool handlers not registered');
    }
    const configMutation = setPath({}, null);
    await vi.waitFor(() => expect(setCustomMcpConfigPathMock).toHaveBeenCalledOnce());
    const deferredMutation = disable({}, ['retired.tool']);
    configPathWrite.resolve();

    await configMutation;
    await expect(deferredMutation).rejects.toThrow(
      'MCP tool registry changed before the deferred mutation executed'
    );
    expect(disableToolsMock).not.toHaveBeenCalledWith(['retired.tool']);
  });

  /**
   * BST-1621. The projection pass used to prune every stored preference id that
   * was missing from *this run's* discovery and rewrite the file with the
   * survivors. A server that times out, fails `tools/list`, or is still
   * spawning under `npx` is missing from that set, so its saved preferences
   * were deleted -- and came back enabled on the next successful run, because
   * `ToolRegistry.register` treats an unseen tool as enabled. Retirement is now
   * keyed on the MCP config, which is the only authority that distinguishes
   * "the user removed this server" from "this server did not answer today".
   *
   * These stay in this describe deliberately: a second describe over the same
   * ipc-mcp singleton leaves in-flight config reloads running into the next
   * test.
   */

  function configureTwoServers(): void {
    loadMcpConfigMock.mockResolvedValueOnce({
      config: {
        servers: [
          { command: 'bin/mock', name: 'mock-server', transport: 'stdio' },
          { args: ['-y', 'slow'], command: 'npx', name: 'slow-server', transport: 'stdio' },
        ],
      },
      exists: true,
      path: '/mock/config.json',
    } as unknown as Awaited<ReturnType<typeof loadMcpConfigMock>>);
  }

  /** Discovery answers for `mock-server` and times out for `slow-server`. */
  function failSlowServerDiscovery(): void {
    const perServer = async (serverName: string) => {
      if (serverName === 'slow-server') {
        throw new Error('MCP request timed out after 5000ms');
      }
      return {
        'mock-server.tool.disable': { description: 'Disabled tool' },
        'mock-server.tool.enable': { description: 'Enabled tool' },
      };
    };
    listToolsMock.mockImplementationOnce(perServer).mockImplementationOnce(perServer);
  }

  it('keeps preferences for a configured server that failed discovery', async () => {
    configureTwoServers();
    failSlowServerDiscovery();
    loadToolPreferencesMock.mockResolvedValueOnce({
      disabledTools: ['mock-server.tool.disable', 'slow-server.dangerous_write'],
      enabledTools: ['mock-server.tool.enable'],
      lastUpdated: 0,
      version: 1,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    // Nothing was retired, so the file must not be rewritten at all.
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
    // The projection still only covers tools that actually exist this run.
    expect(disableToolsMock).toHaveBeenCalledWith(['mock-server.tool.disable']);
    expect(enableToolsMock).toHaveBeenCalledWith(['mock-server.tool.enable']);
  });

  it('does not rewrite the preferences file when every stored id is still configured', async () => {
    configureTwoServers();
    failSlowServerDiscovery();
    loadToolPreferencesMock.mockResolvedValueOnce({
      disabledTools: ['slow-server.a', 'slow-server.b'],
      enabledTools: ['slow-server.c'],
      lastUpdated: 0,
      version: 1,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('prunes preferences only for a server removed from the MCP config', async () => {
    configureTwoServers();
    failSlowServerDiscovery();
    loadToolPreferencesMock.mockResolvedValueOnce({
      disabledTools: ['slow-server.dangerous_write', 'retired-server.gone'],
      enabledTools: ['mock-server.tool.enable', 'retired-server.also_gone'],
      lastUpdated: 0,
      version: 1,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    await vi.waitFor(() => expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1));
    expect(saveToolPreferencesMock).toHaveBeenCalledWith('mock-user-data', {
      // The undiscovered but still-configured server keeps its preference.
      disabledTools: ['slow-server.dangerous_write'],
      enabledTools: ['mock-server.tool.enable'],
      lastUpdated: expect.any(Number),
      version: 1,
    });
  });
});
