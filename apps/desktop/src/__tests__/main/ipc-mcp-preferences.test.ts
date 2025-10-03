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
  createMastraAgentRuntimeMock,
  loadToolPreferencesMock,
  saveToolPreferencesMock,
  loadMcpConfigMock,
  watchMcpConfigMock,
  getMcpConfigPathMock,
  setCustomMcpConfigPathMock,
  initClientsMock,
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
  const getAllTools = vi.fn(() => ({}));
  const getEnabledTools = vi.fn(() => ({}));
  const enableServerTools = vi.fn();
  const disableServerTools = vi.fn();
  const reset = vi.fn();

  const runtimeDispose = vi.fn(async () => {
    order.push('dispose-runtime');
  });

  const createRuntime = vi.fn(async () => {
    order.push('create-runtime');
    register('mock-server', {
      'server.tool.enable': {} as never,
      'server.tool.disable': {} as never,
    });
    return {
      agent: {} as never,
      toolNameMap: new Map<string, string>(),
      dispose: runtimeDispose,
    };
  });

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

  const initClients = vi.fn();
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
    createMastraAgentRuntimeMock: createRuntime,
    loadToolPreferencesMock: loadPreferences,
    saveToolPreferencesMock: savePreferences,
    loadMcpConfigMock: loadConfig,
    watchMcpConfigMock: watchConfig,
    getMcpConfigPathMock: getConfigPath,
    setCustomMcpConfigPathMock: setCustomConfigPath,
    initClientsMock: initClients,
    disposeClientsMock: disposeClients,
    ipcHandleMock: ipcHandle,
    showOpenDialogMock: showOpenDialog,
    getPathMock: getPath,
  };
});

vi.mock('@brainstrike/agent', () => ({
  __esModule: true,
  createMastraAgentRuntime: createMastraAgentRuntimeMock,
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
  },
}));

vi.mock('../../mcp-loader', () => ({
  __esModule: true,
  loadMcpConfig: loadMcpConfigMock,
  watchMcpConfig: watchMcpConfigMock,
  getMcpConfigPath: getMcpConfigPathMock,
  setCustomMcpConfigPath: setCustomMcpConfigPathMock,
}));

vi.mock('../../mcp', () => ({
  __esModule: true,
  initClients: initClientsMock,
  disposeClients: disposeClientsMock,
}));

vi.mock('electron', () => ({
  __esModule: true,
  ipcMain: { handle: ipcHandleMock },
  dialog: { showOpenDialog: showOpenDialogMock },
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
    const createIndex = callOrder.indexOf('create-runtime');
    const disposeIndex = callOrder.indexOf('dispose-runtime');
    const loadIndex = callOrder.indexOf('load-preferences');

    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(registerIndex).toBeGreaterThanOrEqual(createIndex);
    expect(disposeIndex).toBeGreaterThan(registerIndex);
    expect(loadIndex).toBeGreaterThan(disposeIndex);

    expect(callOrder).toContain('disable-tools');
    expect(callOrder).toContain('enable-tools');
  });
});
