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
  loadToolPreferencesMock,
  saveToolPreferencesMock,
  loadMcpConfigMock,
  watchMcpConfigMock,
  getMcpConfigPathMock,
  setCustomMcpConfigPathMock,
  initClientsMock,
  getClientMock,
  disposeClientsMock,
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

  const listTools = vi.fn(async () => {
    order.push('list-tools');
    return {
      'mock-server.tool.disable': { description: 'Disabled tool' },
      'mock-server.tool.enable': { description: 'Enabled tool' },
    };
  });

  const discoveryClient = {
    callTool: vi.fn(),
    dispose: vi.fn(),
    listTools,
    name: 'mock-server',
    supportsTool: vi.fn(() => false),
    transport: 'stdio' as const,
  };

  const initClients = vi.fn(() => {
    order.push('init-clients');
  });
  const getClient = vi.fn((serverName: string) => {
    if (serverName === 'mock-server') {
      return discoveryClient;
    }
    return;
  });
  const disposeClients = vi.fn();

  const ipcHandle = vi.fn();
  const showOpenDialog = vi.fn();
  const getPath = vi.fn(() => 'mock-user-data');

  return {
    callOrder: order,
    disableServerToolsMock: disableServerTools,
    disableToolsMock: disable,
    disposeClientsMock: disposeClients,
    enableServerToolsMock: enableServerTools,
    enableToolsMock: enable,
    getAllToolsMock: getAllTools,
    getClientMock: getClient,
    getEnabledToolsMock: getEnabledTools,
    getMcpConfigPathMock: getConfigPath,
    getPathMock: getPath,
    getStatsMock: getStats,
    initClientsMock: initClients,
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

vi.mock('../../mcp', () => ({
  __esModule: true,
  disposeClients: disposeClientsMock,
  getClient: getClientMock,
  initClients: initClientsMock,
}));

vi.mock('electron', () => ({
  __esModule: true,
  app: { getPath: getPathMock },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: ipcHandleMock },
}));

import { loadToolPreferences, mcpToolRegistry } from '@brainstrike/agent';
import { registerMcpIpcHandlers } from '../../ipc-mcp';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

const authority = createMcpAuthorityTestRuntime(async (serverId) => {
  const client = getClientMock(serverId);
  const discovered = client ? await client.listTools() : {};
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

  afterEach(() => {
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
    getClientMock.mockReturnValueOnce({
      callTool: vi.fn(),
      dispose: vi.fn(),
      listTools: vi.fn(async () => ({
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
      })),
      name: 'filesystem',
      supportsTool: vi.fn(() => false),
      transport: 'stdio',
    } as unknown as ReturnType<typeof getClientMock>);

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
});
