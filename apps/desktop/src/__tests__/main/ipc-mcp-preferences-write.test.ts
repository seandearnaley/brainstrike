/**
 * BST-1623 write-path coverage for MCP tool preferences, split out of
 * `ipc-mcp-preferences.test.ts` to keep both files under the 1000-line cap
 * after BST-1621 landed. A separate FILE rather than a second `describe`:
 * the sibling file warns that a second describe over the same ipc-mcp
 * singleton leaves in-flight config reloads running into the next test, and
 * Vitest gives each file its own module registry.
 */
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
  getAllWindowsMock,
  sentToolEvents,
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

  // Signature mirrors the real `saveToolPreferences`: without the parameter
  // types `mock.calls` narrows to an empty tuple and every payload assertion
  // below stops type-checking.
  const savePreferences = vi.fn(
    async (
      _userDataDir: string,
      _preferences: {
        disabledTools: string[];
        enabledTools: string[];
        lastUpdated: number;
        version: number;
      }
    ): Promise<void> => {
      order.push('save-preferences');
    }
  );

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

  const watchConfig = vi.fn(async (_onChange: (config: unknown) => Promise<void> | void) => ({
    close: vi.fn(),
  }));
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

  const sentToolEvents: unknown[] = [];
  const getAllWindows = vi.fn(() => [
    {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          if (channel === 'mcp:tools:updated') {
            sentToolEvents.push(payload);
          }
        },
      },
    },
  ]);

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
    getAllWindowsMock: getAllWindows,
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
    sentToolEvents,
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
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: ipcHandleMock },
}));

vi.mock('../../window-role', () => ({
  getTrackedWindowsByRole: vi.fn(() => []),
  getWindowRoleByWebContentsId: vi.fn(() => 'visible-ui'),
}));

import { registerMcpIpcHandlers, resumeMcpRuntimeAfterFactoryReset } from '../../ipc-mcp';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import { createMcpAuthorityTestRuntime } from './mcp-authority-test-runtime';

const VISIBLE_UI_EVENT = { sender: { id: 1 }, senderFrame: createAllowlistedSenderFrame() };

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
  return (_event, ...args) => handler(VISIBLE_UI_EVENT, ...args);
}

/**
 * Assert the BST-1615 session fault is NOT latched, so a rejected toggle can
 * only have come from the guard under test rather than from
 * `requireToolPreferencesWritable`.
 */
async function expectNoLatchedPreferencesFault(): Promise<void> {
  const stats = (await getIpcHandler('mcp:tools:getStats')({})) as {
    preferencesFault?: unknown;
  };
  expect(stats.preferencesFault).toBeUndefined();
}

describe('ipc-mcp tool preference writes', () => {
  beforeEach(() => {
    callOrder.length = 0;
    sentToolEvents.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await resumeMcpRuntimeAfterFactoryReset(authority.runtime);
    callOrder.length = 0;
  });
  /**
   * BST-1623. The save path carried the same absence-vs-failure conflation the
   * load path did: it serialised `mcpToolRegistry.getAllTools()` -- only the
   * tools discovered on THIS run -- as the whole file, so one toggle dropped
   * the saved choices of every server that failed discovery. These pin the
   * write as a MERGE over the stored file, and pin the refusal when that file
   * cannot be read at write time -- which the latched BST-1615 fault does not
   * cover, because the projection pass read the file cleanly and only then did
   * it break.
   */

  it('preserves stored preferences for a configured server that failed discovery', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    saveToolPreferencesMock.mockClear();

    // The stored file still holds slow-server's choices. Discovery failed for
    // it this run, so it is absent from the registry -- absence of a server is
    // not evidence its preferences are stale. (Pruning it at LOAD time is
    // BST-1621's separate bug; this read is the one the toggle performs.)
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable', 'slow-server.dangerous_write'],
        enabledTools: ['mock-server.tool.enable', 'slow-server.safe_read'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded' as const,
    });

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');
    await disable({}, ['mock-server.tool.enable']);

    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
    const written = saveToolPreferencesMock.mock.calls[0]?.[1] as {
      disabledTools: string[];
      enabledTools: string[];
    };
    expect(written.disabledTools).toContain('slow-server.dangerous_write');
    expect(written.enabledTools).toContain('slow-server.safe_read');
    // This run's own tool states still win over the stored copy.
    expect(written.disabledTools).toContain('mock-server.tool.disable');
    expect(written.enabledTools).toContain('mock-server.tool.enable');
  });

  it('refuses to write when the stored preferences file has become invalid', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());
    saveToolPreferencesMock.mockClear();

    // The projection pass read the file cleanly, so no fault is latched; the
    // file broke afterwards. Merging into a file we cannot read would silently
    // replace the user's only copy with this run's tools alone. Pinning the
    // absent fault keeps this honest: without it, a latched BST-1615 fault
    // would throw the expected error and the save-path guard would go untested.
    await expectNoLatchedPreferencesFault();
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');

    await expect(disable({}, ['mock-server.tool.enable'])).rejects.toThrow(
      /tool-preferences\.json/
    );
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('refuses to write when the stored preferences file has become unreadable', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());
    saveToolPreferencesMock.mockClear();

    await expectNoLatchedPreferencesFault();
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'EACCES: permission denied',
      status: 'unreadable' as const,
    });

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');

    await expect(disable({}, ['mock-server.tool.enable'])).rejects.toThrow(
      /tool-preferences\.json/
    );
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('discards every stored id on reset, including undiscovered servers', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    saveToolPreferencesMock.mockClear();
    loadToolPreferencesMock.mockClear();

    // Reset replaces rather than merges. An earlier revision of this PR had it
    // preserve an undiscovered server's choices by symmetry with the toggle;
    // that was wrong. "Reset" is an explicit, labelled discard, not incidental
    // loss from an unrelated failure -- the thing BST-1621 protects against --
    // and a half-reset that silently leaves entries behind is the surprising
    // behaviour. It is also what makes reset a reliable remediation.
    await getIpcHandler<[]>('mcp:tools:reset')({});

    expect(loadToolPreferencesMock).not.toHaveBeenCalled();
    const written = saveToolPreferencesMock.mock.calls[0]?.[1] as {
      disabledTools: string[];
      enabledTools: string[];
    };
    // Only this run's registry reaches disk -- nothing is carried over.
    expect(written.enabledTools).toEqual(['mock-server.tool.enable']);
    expect(written.disabledTools).toEqual(['mock-server.tool.disable']);
  });

  /**
   * BST-1623 review round. Reset is the ONLY in-app remediation for a corrupt
   * preferences file, so the refusal must not cover it: refusing to overwrite a
   * file we cannot read is coherent for a toggle (we would be guessing at what
   * we preserve) and is precisely what a reset is asking for. Reset therefore
   * replaces rather than merges, never reads, and is not gated on the fault.
   */

  it('lets reset discard a corrupt preferences file instead of trapping the user', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());
    saveToolPreferencesMock.mockClear();
    loadToolPreferencesMock.mockClear();

    await getIpcHandler<[]>('mcp:tools:reset')({});

    // Replace, not merge: nothing is preserved, so nothing is read.
    expect(loadToolPreferencesMock).not.toHaveBeenCalled();
    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('clears the latched fault once reset has written a readable file', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());

    await getIpcHandler<[]>('mcp:tools:reset')({});

    // Recovery is only real if it also un-latches: otherwise the file is now
    // fine and every later toggle still throws until the app restarts.
    await expectNoLatchedPreferencesFault();
    saveToolPreferencesMock.mockClear();
    await getIpcHandler<[string[]]>('mcp:tools:disable')({}, ['mock-server.tool.enable']);
    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the live registry when the write is refused', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(registerToolsMock).toHaveBeenCalled());
    await expectNoLatchedPreferencesFault();
    saveToolPreferencesMock.mockClear();
    disableToolsMock.mockClear();

    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      reason: 'Unexpected end of JSON input',
      status: 'invalid' as const,
    });

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');
    await expect(disable({}, ['mock-server.tool.enable'])).rejects.toThrow(
      /tool-preferences\.json/
    );

    // An operation reported as unsaved must not still change live tool
    // availability -- `filterEnabledServerTools` reads this registry for
    // assistant runs, so a mutated-but-unpersisted registry is BST-1615's
    // "the UI says it worked" defect one layer up.
    expect(disableToolsMock).not.toHaveBeenCalled();
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('stamps the version this build writes, not the one it read', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    saveToolPreferencesMock.mockClear();

    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable'],
        enabledTools: ['mock-server.tool.enable'],
        lastUpdated: 0,
        version: 2,
      },
      status: 'loaded' as const,
    });

    await getIpcHandler<[string[]]>('mcp:tools:disable')({}, ['mock-server.tool.enable']);

    // The body serialised is always this build's shape. Echoing a newer stamp
    // would mark v1-shaped data as already migrated.
    const written = saveToolPreferencesMock.mock.calls[0]?.[1] as { version: number };
    expect(written.version).toBe(1);
  });

  it('serialises a toggle against the config-watch write path', async () => {
    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();

    // The watcher path runs under `trackConfigChange`, which only records into
    // `mcpLifecycleBarrier`; the toggle runs under `trackConfigOperation`,
    // which serialises on `mcpConfigOperationTail`. Different queues, so
    // without a lock over the file the two read-modify-writes interleave and
    // the toggle's write resurrects whatever the projection just pruned.
    const onConfigChange = watchMcpConfigMock.mock.calls[0]?.[0] as
      | ((config: unknown) => Promise<void> | void)
      | undefined;
    if (!onConfigChange) {
      throw new Error('config watcher callback not registered');
    }

    const discoveriesBefore = listToolsMock.mock.calls.length;
    const toggleRead = Promise.withResolvers<Awaited<ReturnType<typeof loadToolPreferencesMock>>>();
    loadToolPreferencesMock.mockClear();
    loadToolPreferencesMock.mockReturnValueOnce(toggleRead.promise);

    const toggle = getIpcHandler<[string[]]>('mcp:tools:disable')({}, ['mock-server.tool.enable']);
    await vi.waitFor(() => expect(loadToolPreferencesMock).toHaveBeenCalledTimes(1));

    const watched = onConfigChange({
      config: { servers: [{ command: 'bin/mock', name: 'mock-server', transport: 'stdio' }] },
      exists: true,
      path: '/mock/config.json',
    });

    // Wait until the watcher pass has finished discovery, so the only thing
    // left between it and the file is the lock. Unlocked, it reads here --
    // which is the interleaving that loses the toggle's update.
    await vi.waitFor(() =>
      expect(listToolsMock.mock.calls.length).toBeGreaterThan(discoveriesBefore)
    );
    expect(loadToolPreferencesMock).toHaveBeenCalledTimes(1);

    toggleRead.resolve({
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable', 'retired-server.tool'],
        enabledTools: ['mock-server.tool.enable'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded' as const,
    });
    await toggle;
    await watched;

    // ...and only once the toggle's write completes does the watcher read.
    expect(loadToolPreferencesMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not resurrect entries a retirement pass removed from the file', async () => {
    // retired-server is gone from the MCP config, so the retirement pass drops
    // its ids and rewrites the file. The merge reads the file as that pass left
    // it, so the toggle must not bring them back.
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: {
        disabledTools: ['mock-server.tool.disable', 'retired-server.tool'],
        enabledTools: ['mock-server.tool.enable'],
        lastUpdated: 0,
        version: 1,
      },
      status: 'loaded' as const,
    });

    registerMcpIpcHandlers({ runtime: authority.runtime });
    await waitForPreferencesCall();
    await vi.waitFor(() => expect(saveToolPreferencesMock).toHaveBeenCalled());

    const retiredWrite = saveToolPreferencesMock.mock.calls.at(-1)?.[1] as {
      disabledTools: string[];
      enabledTools: string[];
      lastUpdated: number;
      version: number;
    };
    expect(retiredWrite.disabledTools).not.toContain('retired-server.tool');
    saveToolPreferencesMock.mockClear();

    // Exactly what the retirement pass left on disk -- not a hand-fed fixture.
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: 'mock-user-data/mcp/tool-preferences.json',
      preferences: retiredWrite,
      status: 'loaded' as const,
    });

    const disable = getIpcHandler<[string[]]>('mcp:tools:disable');
    await disable({}, ['mock-server.tool.enable']);

    expect(saveToolPreferencesMock).toHaveBeenCalledTimes(1);
    const written = saveToolPreferencesMock.mock.calls[0]?.[1] as {
      disabledTools: string[];
      enabledTools: string[];
    };
    expect(written.disabledTools).not.toContain('retired-server.tool');
    expect(written.enabledTools).not.toContain('retired-server.tool');
  });
});
