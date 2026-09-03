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

  // Structural copy of ToolPreferencesLoadResult: vi.hoisted runs before imports,
  // so the real type is not reachable here.
  type LoadResult =
    | {
        status: 'loaded';
        path: string;
        preferences: {
          disabledTools: string[];
          enabledTools: string[];
          lastUpdated: number;
          version: number;
        };
      }
    | { status: 'absent'; path: string }
    | { status: 'invalid'; path: string; reason: string }
    | { status: 'unreadable'; path: string; reason: string };

  const loadPreferences = vi.fn(async (): Promise<LoadResult> => {
    order.push('load-preferences');
    return {
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable'],
        enabledTools: ['mock-server.tool.enable'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded',
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

function getIpcHandler<T extends unknown[]>(
  channel: string
): (event: unknown, ...args: T) => Promise<unknown> {
  const registration = ipcHandleMock.mock.calls.find(([name]) => name === channel);
  const handler = registration?.[1] as
    | ((event: unknown, ...args: T) => Promise<unknown>)
    | undefined;
  if (!handler) {
    throw new Error(`handler not registered for ${channel}`);
  }
  return handler;
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
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['filesystem_list_directory'],
        enabledTools: ['filesystem_read_file'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded' as const,
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
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable', 'filesystem_list_directory'],
        enabledTools: ['mock-server.tool.enable', 'filesystem_read_file'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded' as const,
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
   * BST-1615. Two halves of the same persistence path used to fail silently: a
   * failed write resolved the IPC successfully, and an unreadable preferences
   * file was indistinguishable from "first run", which re-enabled every tool
   * the user had turned off and then made that reset permanent on the next
   * toggle. These stay in this describe deliberately -- a second describe over
   * the same ipc-mcp singleton leaves in-flight config reloads running into the
   * next test.
   */

  it('rejects the toggle IPC when the preference write fails', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    saveToolPreferencesMock.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');

    await expect(disable({}, ['mock-server.tool.disable'])).rejects.toThrow(
      'ENOSPC: no space left on device'
    );
  });

  it('does not enable previously disabled tools when the preferences file is invalid', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    expect(enableToolsMock).not.toHaveBeenCalled();
    expect(disableToolsMock).toHaveBeenCalledWith(
      expect.arrayContaining(['mock-server.tool.disable', 'mock-server.tool.enable'])
    );
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('does not enable previously disabled tools when the preferences file is unreadable', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'EACCES: permission denied',
      status: 'unreadable' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    expect(enableToolsMock).not.toHaveBeenCalled();
    expect(disableToolsMock).toHaveBeenCalledWith(
      expect.arrayContaining(['mock-server.tool.disable', 'mock-server.tool.enable'])
    );
  });

  it('applies no projection but keeps tools enabled when the file is merely absent', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      status: 'absent' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    expect(enableToolsMock).not.toHaveBeenCalled();
    expect(disableToolsMock).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an unreadable preferences file on the next toggle', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'EACCES: permission denied',
      status: 'unreadable' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());
    saveToolPreferencesMock.mockClear();

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');

    await expect(disable({}, ['mock-server.tool.enable'])).rejects.toThrow(
      /tool-preferences\.json/
    );
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('keeps refusing preference writes across an abandoned factory reset', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'EACCES: permission denied',
      status: 'unreadable' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    await resetMcpRuntimeForFactoryReset(authority.runtime);
    // 'failed' is the abandoned reset: the projection is restored from the
    // snapshot rather than rebuilt, so the fault has to travel with it.
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime, 'failed');
    saveToolPreferencesMock.mockClear();

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');

    await expect(disable({}, ['mock-server.tool.enable'])).rejects.toThrow(
      /tool-preferences\.json/
    );
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('reports the preference fault through the tool stats payload', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    const stats = (await getIpcHandler('mcp:tools:getStats')({})) as {
      preferencesFault?: { kind: string; message: string; path: string };
    };

    expect(stats.preferencesFault).toMatchObject({
      kind: 'invalid',
      path: 'mock-user-data/mcp/tool-preferences.json',
    });
    expect(stats.preferencesFault?.message).toContain('tool-preferences.json');
  });

  it('reports no preference fault once the file loads cleanly', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    const stats = (await getIpcHandler('mcp:tools:getStats')({})) as {
      preferencesFault?: unknown;
    };

    expect(stats.preferencesFault).toBeUndefined();
  });
});
