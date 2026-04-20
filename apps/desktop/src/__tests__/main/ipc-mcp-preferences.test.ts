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

  const getStats = vi.fn(() => ({ total: 2, enabled: 1, disabled: 1, servers: 1 }));
  // Mock registered tools that match the preference IDs being tested
  const getAllTools = vi.fn(() => ({
    'mock-server': [
      { id: 'server.tool.enable', enabled: true },
      { id: 'server.tool.disable', enabled: false },
    ],
  }));
  const getEnabledTools = vi.fn(() => ({}));
  const enableServerTools = vi.fn();
  const disableServerTools = vi.fn();
  const reset = vi.fn();

  const loadPreferences = vi.fn(async () => {
    order.push('load-preferences');
    return {
      enabledTools: ['server.tool.enable'],
      disabledTools: ['server.tool.disable'],
      version: 1,
      lastUpdated: 0,
    };
  });

  const savePreferences = vi.fn();

  const loadConfig = vi.fn(async () => ({
    path: '/mock/config.json',
    exists: true,
    config: {
      servers: [
        {
          name: 'mock-server',
          transport: 'stdio',
          command: 'bin/mock',
        },
      ],
    },
  }));

  const watchConfig = vi.fn(async () => ({ close: vi.fn() }));
  const getConfigPath = vi.fn(async () => '/mock/path');
  const setCustomConfigPath = vi.fn(async () => {});

  const listTools = vi.fn(async () => {
    order.push('list-tools');
    return {
      'server.tool.enable': { description: 'Enabled tool' },
      'server.tool.disable': { description: 'Disabled tool' },
    };
  });

  const discoveryClient = {
    name: 'mock-server',
    transport: 'stdio' as const,
    dispose: vi.fn(),
    listTools,
    supportsTool: vi.fn(() => false),
    callTool: vi.fn(),
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
    registerToolsMock: register,
    disableToolsMock: disable,
    enableToolsMock: enable,
    getStatsMock: getStats,
    getAllToolsMock: getAllTools,
    getEnabledToolsMock: getEnabledTools,
    enableServerToolsMock: enableServerTools,
    disableServerToolsMock: disableServerTools,
    resetToolsMock: reset,
    loadToolPreferencesMock: loadPreferences,
    saveToolPreferencesMock: savePreferences,
    loadMcpConfigMock: loadConfig,
    watchMcpConfigMock: watchConfig,
    getMcpConfigPathMock: getConfigPath,
    setCustomMcpConfigPathMock: setCustomConfigPath,
    initClientsMock: initClients,
    getClientMock: getClient,
    listToolsMock: listTools,
    disposeClientsMock: disposeClients,
    ipcHandleMock: ipcHandle,
    showOpenDialogMock: showOpenDialog,
    getPathMock: getPath,
  };
});

vi.mock('@brainstrike/agent', () => ({
  __esModule: true,
  loadToolPreferences: loadToolPreferencesMock,
  saveToolPreferences: saveToolPreferencesMock,
  mcpToolRegistry: {
    register: registerToolsMock,
    getStats: getStatsMock,
    getAllTools: getAllToolsMock,
    getEnabledTools: getEnabledToolsMock,
    enableTools: enableToolsMock,
    disableTools: disableToolsMock,
    enableServerTools: enableServerToolsMock,
    disableServerTools: disableServerToolsMock,
    reset: resetToolsMock,
    clear: vi.fn(), // New method used for stale preferences fix
  },
}));

vi.mock('../../mcp-loader', () => ({
  __esModule: true,
  getDefaultMcpConfigTemplate: () => '{\n  "servers": []\n}',
  loadMcpConfig: loadMcpConfigMock,
  watchMcpConfig: watchMcpConfigMock,
  getMcpConfigPath: getMcpConfigPathMock,
  setCustomMcpConfigPath: setCustomMcpConfigPathMock,
  readMcpConfigText: vi.fn(),
  writeMcpConfigText: vi.fn(),
}));

vi.mock('../../mcp', () => ({
  __esModule: true,
  initClients: initClientsMock,
  getClient: getClientMock,
  disposeClients: disposeClientsMock,
}));

vi.mock('electron', () => ({
  __esModule: true,
  ipcMain: { handle: ipcHandleMock },
  dialog: { showOpenDialog: showOpenDialogMock },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getPath: getPathMock },
}));

import { loadToolPreferences, mcpToolRegistry } from '@brainstrike/agent';
import { registerMcpIpcHandlers } from '../../ipc-mcp';

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
    registerMcpIpcHandlers();

    await waitForPreferencesCall();

    expect(loadToolPreferences).toHaveBeenCalledWith('mock-user-data');
    expect(mcpToolRegistry.disableTools).toHaveBeenCalledWith(['server.tool.disable']);
    expect(mcpToolRegistry.enableTools).toHaveBeenCalledWith(['server.tool.enable']);

    const registerIndex = callOrder.indexOf('register-tools');
    const initIndex = callOrder.indexOf('init-clients');
    const listIndex = callOrder.indexOf('list-tools');
    const loadIndex = callOrder.indexOf('load-preferences');

    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(registerIndex).toBeGreaterThanOrEqual(listIndex);
    expect(listIndex).toBeGreaterThanOrEqual(initIndex);
    expect(loadIndex).toBeGreaterThan(registerIndex);

    expect(callOrder).toContain('disable-tools');
    expect(callOrder).toContain('enable-tools');
  });

  it('discovers tools for the filesystem MCP server', async () => {
    loadMcpConfigMock.mockResolvedValueOnce({
      path: '/mock/config.json',
      exists: true,
      config: {
        servers: [
          {
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
          },
        ],
      },
    });
    getClientMock.mockReturnValueOnce({
      name: 'filesystem',
      transport: 'stdio',
      dispose: vi.fn(),
      supportsTool: vi.fn(() => false),
      callTool: vi.fn(),
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
    });

    registerMcpIpcHandlers();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(registerToolsMock).toHaveBeenCalledWith(
      'filesystem',
      expect.objectContaining({
        'filesystem.list_directory': expect.objectContaining({
          description: expect.stringContaining('listing'),
          inputSchema: { type: 'filesystem.list_directory.schema' },
        }),
        'filesystem.read_file': expect.objectContaining({
          description: expect.stringContaining('Read the complete contents'),
          inputSchema: { type: 'filesystem.read_file.schema' },
        }),
        'filesystem.search_files': expect.objectContaining({
          description: expect.stringContaining('search for files'),
          inputSchema: { type: 'filesystem.search_files.schema' },
        }),
      }),
      undefined
    );
    expect(loadToolPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('discards legacy sanitized preference ids instead of applying them', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      enabledTools: ['filesystem_read_file'],
      disabledTools: ['filesystem_list_directory'],
      version: 1,
      lastUpdated: 0,
    });
    getAllToolsMock.mockReturnValueOnce({
      filesystem: [
        { id: 'filesystem.read_file', enabled: true },
        { id: 'filesystem.list_directory', enabled: true },
      ],
    });

    registerMcpIpcHandlers();

    await waitForPreferencesCall();

    expect(mcpToolRegistry.enableTools).not.toHaveBeenCalled();
    expect(mcpToolRegistry.disableTools).not.toHaveBeenCalled();
    expect(saveToolPreferencesMock).toHaveBeenCalledWith(
      'mock-user-data',
      expect.objectContaining({
        enabledTools: [],
        disabledTools: [],
      })
    );
  });

  it('still applies valid preferences when persisting cleaned ids fails', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      enabledTools: ['server.tool.enable', 'filesystem_read_file'],
      disabledTools: ['server.tool.disable', 'filesystem_list_directory'],
      version: 1,
      lastUpdated: 0,
    });
    saveToolPreferencesMock.mockRejectedValueOnce(new Error('disk full'));
    getAllToolsMock.mockReturnValueOnce({
      'mock-server': [
        { id: 'server.tool.enable', enabled: true },
        { id: 'server.tool.disable', enabled: false },
      ],
    });

    registerMcpIpcHandlers();

    await waitForPreferencesCall();

    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
    expect(mcpToolRegistry.disableTools).toHaveBeenCalledWith(['server.tool.disable']);
    expect(mcpToolRegistry.enableTools).toHaveBeenCalledWith(['server.tool.enable']);
  });
});
