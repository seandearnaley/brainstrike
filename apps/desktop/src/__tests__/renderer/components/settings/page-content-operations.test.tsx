import type { McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import {
  type McpExtensionEnablement,
  type McpHostControlRequest,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  type McpHostWatchEvent,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

/** The agent host's MCP settings over this window's client, as the renderer reaches them. */
interface FakeHostMcpSettings {
  readonly request: Mock<(method: string, params: unknown) => Promise<unknown>>;
  readonly subscribe: Mock<(listener: (event: McpSettingsEvent) => void) => () => void>;
}
const hostMcpSettings = vi.hoisted((): { current: FakeHostMcpSettings | null } => ({
  current: null,
}));
interface FakeHostMcpContent {
  readonly complete: Mock<(request: unknown) => Promise<unknown>>;
  readonly getPrompt: Mock<(request: unknown) => Promise<unknown>>;
  readonly readResource: Mock<(request: unknown) => Promise<unknown>>;
}
const hostMcpContent = vi.hoisted((): { current: FakeHostMcpContent | null } => ({
  current: null,
}));

const setToolsEnabledMock = vi.hoisted(() => vi.fn());
const resetToolsMock = vi.hoisted(() => vi.fn());
const createToolsSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createTokenCountingSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createHooksSettingsCategoryMock = vi.hoisted(() => vi.fn());
const createAssistantMemorySettingsCategoryMock = vi.hoisted(() => vi.fn());
const modelSelectionPageMock = vi.hoisted(() =>
  vi.fn(() => <div data-testid="model-selection-page" />)
);
const assistantAvailability = vi.hoisted(
  (): {
    current:
      | { state: 'loading' }
      | {
          providerKeySources: readonly [
            { envVar: 'OPENAI_API_KEY'; provider: 'openai'; source: 'env' },
          ];
          providers: readonly ['openai', 'local'];
          state: 'enabled';
        };
  } => ({
    current: { state: 'loading' },
  })
);

interface FileExplorerMockState {
  activeRootIds: string[];
  devInlineFixtureEnabled: boolean;
  rootDescriptors: Record<string, { displayName: string; path: string; rootId: string }>;
  setDevInlineFixtureEnabled: () => void;
}

const fileExplorerMockState = vi.hoisted((): { current: FileExplorerMockState } => ({
  current: {
    activeRootIds: [],
    devInlineFixtureEnabled: true,
    rootDescriptors: {},
    setDevInlineFixtureEnabled: () => {},
  },
}));

interface CapturedToolsOperations {
  completeMcpContent?: (request: unknown) => Promise<unknown>;
  controlMcpServer?: (request: McpHostControlRequest) => Promise<McpHostServerSnapshot>;
  createSampleConfig: () => Promise<{ error?: string; path: string; success: boolean }>;
  disableTools: (ids: string[]) => Promise<void>;
  enableTools: (ids: string[]) => Promise<void>;
  getMcpConfigInfo: () => Promise<{ error?: string; exists: boolean; path: string } | null>;
  getMcpConfigPath?: () => Promise<string>;
  getMcpExtensionPreferences?: () => Promise<McpExtensionEnablement>;
  getMcpPrompt?: (request: unknown) => Promise<unknown>;
  getMcpServerStatus?: () => Promise<McpHostSnapshot>;
  getStats: () => Promise<{
    byCategory: Record<string, number>;
    bySource: { mcp: number; native: number };
    disabled: number;
    enabled: number;
    mcpServers: number;
    total: number;
  }>;
  getTools: () => Promise<Array<{ id: string; source: string }>>;
  openMcpConfig: () => Promise<void>;
  readMcpConfigText?: () => Promise<{ content: string; path: string }>;
  readMcpResource?: (request: unknown) => Promise<unknown>;
  refreshMcpServers: () => Promise<void>;
  reloadToolPreferences?: () => Promise<void>;
  resetMcpConfig: () => Promise<void>;
  resetTools: () => Promise<void>;
  setMcpConfigPath?: (configPath: string | null) => Promise<void>;
  setMcpExtensionPreferences?: (
    preferences: McpExtensionEnablement
  ) => Promise<McpExtensionEnablement>;
  subscribeMcpConfig: (
    listener: (config: { error?: string; exists: boolean; path: string }) => void
  ) => () => void;
  subscribeMcpExtensionPreferences?: (
    listener: (preferences: McpExtensionEnablement) => void
  ) => () => void;
  subscribeMcpServerStatus?: (listener: (event: McpHostWatchEvent) => void) => () => void;
  subscribeMcpTools: (listener: () => void) => () => void;
  writeMcpConfigText?: (
    content: string
  ) => Promise<{ error?: string; path: string; success: boolean }>;
}

let capturedOperations: CapturedToolsOperations | null = null;

const hostSnapshot = {
  revision: 7,
  servers: [
    {
      configuredProtocol: 'auto',
      configuredServerId: parseConfiguredMcpServerId('local'),
      generation: 2,
      negotiated: {
        advertisedCapabilityIds: ['tools'],
        era: 'modern',
        revision: '2026-07-28',
        serverIdentity: { name: 'linear', title: 'Linear', version: '2.0.0' },
      },
      state: 'connected',
      transport: 'streamable-http',
    },
  ],
} as const satisfies McpHostSnapshot;

const extensionPreferences = {
  apps: true,
  tasks: true,
} as const satisfies McpExtensionEnablement;

vi.mock('@brainstrike/agent/tool-metadata', () => ({
  DESKTOP_NATIVE_TOOL_IDS: ['native-read'],
  getNativeToolDescription: (toolId: string) =>
    toolId === 'native-read' ? 'Read local files' : undefined,
  isNativeTool: (toolId: string) => toolId === 'native-read',
  NATIVE_TOOL_DEFAULTS: {
    'native-read': {
      category: 'retrieval',
      estimatedTokens: 25,
      loadingTier: 'always',
      requiresApproval: false,
    },
  },
}));

vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  createSystemDiagnosticsSettingsCategory: () => ({
    content: <div data-testid="diagnostics-category" />,
    id: 'diagnostics',
    title: 'Diagnostics',
  }),
}));

vi.mock('@brainstrike/app-shell', () => ({
  useAssistantAvailability: () => assistantAvailability.current,
  useHostAssistantStatusFetcher: () => undefined,
  // The Provider Hub takes the probe as an injected plain FUNCTION — app-shell
  // depends on settings-ui, so it cannot be imported there, and a hook may not
  // be passed as a value.
  verifyProviderCredential: () => new Promise(() => undefined),
}));

vi.mock('@brainstrike/app-shell/cost-tracking-settings', () => ({
  createCostTrackingSettingsCategory: () => ({
    content: <div data-testid="cost-tracking-category" />,
    id: 'cost-tracking',
    title: 'Cost Tracking',
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => ({
    countingMode: 'accurate',
    isOperational: true,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: (selector: (state: FileExplorerMockState) => unknown) =>
    selector(fileExplorerMockState.current),
}));

vi.mock('@brainstrike/settings-ui/settings/models/model-runtime-services', () => ({
  configureModelRuntimeServices: vi.fn(),
}));

vi.mock('@brainstrike/settings-ui/settings/models/model-selection-page', () => ({
  ModelCatalogHeaderActions: vi.fn(() => null),
  ModelSelectionPage: modelSelectionPageMock,
}));

vi.mock('@brainstrike/settings-ui/settings/tools/index', () => ({
  createToolsSettingsCategory: createToolsSettingsCategoryMock.mockImplementation(
    ({ operations }: { operations: CapturedToolsOperations }) => {
      capturedOperations = operations;
      return {
        content: <div data-testid="tools-category" />,
        id: 'ai-tools',
        title: 'AI Tools',
      };
    }
  ),
}));

vi.mock('@brainstrike/settings-ui/settings/system/notification-settings-category', () => ({
  createNotificationSettingsCategory: () => ({
    content: <div data-testid="notifications-category" />,
    id: 'notifications',
    title: 'Notifications',
  }),
}));

vi.mock('@brainstrike/settings-ui/settings-page-content', () => ({
  SettingsPageContent: ({
    categories,
    defaultCategoryId,
  }: {
    categories: Array<{ content: React.ReactNode; id: string; title: string }>;
    defaultCategoryId: string;
  }) => (
    <div data-default-category-id={defaultCategoryId} data-testid="settings-layout">
      {categories.map((category) => (
        <span data-testid="settings-category-title" key={category.id}>
          {category.title}
        </span>
      ))}
      {categories.find(({ id }) => id === 'embedding-models')?.content}
    </div>
  ),
}));

vi.mock('@brainstrike/settings-ui/settings-category-factories', () => ({
  createAppearanceSettingsCategory: () => ({
    content: <div data-testid="appearance-category" />,
    id: 'appearance',
    title: 'Appearance',
  }),
  createAssistantMemorySettingsCategory:
    createAssistantMemorySettingsCategoryMock.mockImplementation(() => ({
      content: <div data-testid="assistant-memory-category" />,
      id: 'assistant-memory',
      title: 'Assistant Memory',
    })),
  createFactoryResetSettingsCategory: vi.fn((options: unknown) => ({
    content: <div data-options={JSON.stringify(options)} data-testid="factory-reset-category" />,
    id: 'factory-reset',
    title: 'Factory Reset',
  })),
  createHooksSettingsCategory: createHooksSettingsCategoryMock.mockImplementation(() => ({
    content: <div data-testid="hooks-category" />,
    id: 'hooks',
    title: 'Hooks',
  })),
  createLocalRuntimeSettingsCategory: () => ({
    content: <div data-testid="local-runtime-category" />,
    id: 'local-runtime',
    title: 'Local Runtime',
  }),
  createPermissionSettingsCategory: () => ({
    content: <div data-testid="permissions-category" />,
    id: 'permissions',
    title: 'Permissions',
  }),
  createSearchIndexingSettingsCategory: () => ({
    content: <div data-testid="search-indexing-category" />,
    id: 'search-indexing',
    title: 'Search & Indexing',
  }),
  createSubagentPersonasSettingsCategory: () => ({
    content: <div data-testid="subagents-category" />,
    id: 'subagents',
    title: 'Subagents',
  }),
  createTokenCountingSettingsCategoryWithRuntimeSupport:
    createTokenCountingSettingsCategoryMock.mockImplementation((options: unknown) => ({
      content: <div data-options={JSON.stringify(options)} data-testid="token-counting-category" />,
      id: 'token-counting',
      title: 'Token Counting',
    })),
  createWorkspaceSettingsCategory: vi.fn((options: unknown) => ({
    content: <div data-options={JSON.stringify(options)} data-testid="workspace-category" />,
    id: 'workspace',
    title: 'Workspace',
  })),
}));

vi.mock('@brainstrike/app-state/automation-overrides', () => ({
  getAccurateRuntimeAvailabilityTestOverride: () => undefined,
}));

vi.mock('@brainstrike/app-state/stores/native-tool-preferences-store', () => ({
  useNativeToolPreferencesStore: {
    getState: () => ({
      isToolEnabled: (toolId: string) => toolId === 'native-read',
      resetTools: resetToolsMock,
      setToolsEnabled: setToolsEnabledMock,
    }),
  },
}));

vi.mock('../../../../renderer/host-mcp-settings', () => ({
  resolveDesktopHostMcpSettings: () => hostMcpSettings.current,
  resolveDesktopMcpContent: () => hostMcpContent.current,
}));

vi.mock('../../../../renderer/components/settings/logging-settings', () => ({
  DesktopLoggingSettings: () => <div data-testid="logging-settings" />,
}));

interface DesktopTestWindow {
  assistant?: {
    url: string;
  };
  mcp?: {
    selectPath?: () => Promise<string | null>;
  };
}

const getDesktopWindow = (): DesktopTestWindow => window as unknown as DesktopTestWindow;

const MCP_TOOLS = {
  local: [
    {
      description: 'Search files',
      discoveredAt: 1,
      enabled: false,
      id: 'mcp-search',
      inputSchema: { type: 'object' },
      serverName: 'local',
    },
  ],
};

function createHostMcpSettings(): FakeHostMcpSettings {
  const responses: Record<string, (params: unknown) => unknown> = {
    'mcp/config/path': () => ({ path: '/tmp/mcp.json' }),
    'mcp/config/path/set': (params) => ({
      path: (params as { path: string | null }).path ?? '/tmp/default.json',
      success: true,
    }),
    'mcp/config/read': () => ({
      content: '{}',
      created: false,
      error: 'invalid_mcp_config: servers: required',
      exists: true,
      path: '/tmp/mcp.json',
    }),
    'mcp/config/sample': () => ({ path: '/tmp/sample.json', success: true }),
    'mcp/config/status': () => ({ exists: true, path: '/tmp/mcp.json' }),
    'mcp/config/write': () => ({ path: '/tmp/mcp.json', success: true }),
    'mcp/extensions/read': () => extensionPreferences,
    'mcp/extensions/set': (params) => params,
    'mcp/server/control': () => hostSnapshot.servers[0],
    'mcp/status/read': () => hostSnapshot,
    'mcp/tools/list': () => MCP_TOOLS,
    'mcp/tools/reload': () => ({ applied: true }),
    'mcp/tools/reset': () => ({ applied: true }),
    'mcp/tools/set': () => ({ applied: true }),
    'mcp/tools/stats': () => ({ disabled: 1, enabled: 1, servers: 1, total: 2 }),
  };
  return {
    request: vi.fn(async (method: string, params: unknown) => {
      const respond = responses[method];
      if (!respond) {
        throw new Error(`Unexpected MCP settings request ${method}`);
      }
      return respond(params);
    }),
    subscribe: vi.fn(() => vi.fn()),
  };
}

function requireSettings(): FakeHostMcpSettings {
  if (!hostMcpSettings.current) {
    throw new Error('Expected the host MCP settings capability');
  }
  return hostMcpSettings.current;
}

async function renderOperations(): Promise<CapturedToolsOperations> {
  const { default: SettingsPageContent } = await import(
    '../../../../renderer/components/settings/page-content'
  );
  render(<SettingsPageContent />);
  if (!capturedOperations) {
    throw new Error('Expected tools operations to be captured');
  }
  return capturedOperations;
}

describe('desktop SettingsPageContent tool operations', () => {
  beforeEach(() => {
    capturedOperations = null;
    vi.clearAllMocks();
    fileExplorerMockState.current = {
      activeRootIds: [],
      devInlineFixtureEnabled: true,
      rootDescriptors: {},
      setDevInlineFixtureEnabled: () => {},
    };
    assistantAvailability.current = { state: 'loading' };
    hostMcpSettings.current = createHostMcpSettings();

    const desktopWindow = getDesktopWindow();
    desktopWindow.assistant = undefined;
    // BST-1930 c5d: content browsing comes from the agent host.
    hostMcpContent.current = {
      complete: vi.fn(async () => ({
        result: { completion: { values: ['BST-1585'] } },
        type: 'completion/complete',
      })),
      getPrompt: vi.fn(async () => ({
        result: { messages: [{ content: { text: 'Summarize', type: 'text' }, role: 'user' }] },
        type: 'prompts/get',
      })),
      readResource: vi.fn(async () => ({
        result: { contents: [{ text: '# BST-1585', uri: 'linear://issue/BST-1585' }] },
        type: 'resources/read',
      })),
    };
    desktopWindow.mcp = { selectPath: vi.fn(async () => '/tmp/selected.json') };
  });

  it('forwards tool preference reload to the agent host', async () => {
    const operations = await renderOperations();
    if (!operations.reloadToolPreferences) {
      throw new Error('Expected reload operation');
    }
    await operations.reloadToolPreferences();
    expect(requireSettings().request).toHaveBeenCalledWith('mcp/tools/reload', {});
    expect(resetToolsMock).not.toHaveBeenCalled();
  });

  it('omits the host MCP settings operations where the window has no agent host', async () => {
    hostMcpSettings.current = null;
    const operations = await renderOperations();
    expect(operations.reloadToolPreferences).toBeUndefined();
    expect(operations).not.toHaveProperty('getMcpExtensionPreferences');
    expect(operations).not.toHaveProperty('readMcpConfigText');
    expect(operations).not.toHaveProperty('writeMcpConfigText');
    await expect(operations.createSampleConfig()).resolves.toEqual({
      error: 'MCP settings need the desktop agent host',
      path: '',
      success: false,
    });
  });

  it.each([
    ['enableTools', true],
    ['disableTools', false],
  ] as const)(
    'surfaces the host refusal of %s as the host wrote it',
    async (operation, enabled) => {
      const faultMessage = 'Preferences could not be loaded. Repair and Reload tool preferences.';
      requireSettings().request.mockImplementation(async (method) => {
        if (method === 'mcp/tools/set') {
          throw new Error(faultMessage);
        }
        return;
      });
      const operations = await renderOperations();

      await expect(operations[operation](['mcp-search'])).rejects.toThrow(faultMessage);
      expect(requireSettings().request).toHaveBeenCalledWith('mcp/tools/set', {
        enabled,
        toolIds: ['mcp-search'],
      });
    }
  );

  it('wires desktop MCP and native tool operations through the settings category', async () => {
    const operations = await renderOperations();

    expect(createToolsSettingsCategoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAvailable: true })
    );
    expect(createTokenCountingSettingsCategoryMock).toHaveBeenCalledWith({
      accurateRuntimeAvailable: true,
    });
    const settings = requireSettings();

    await expect(operations.getTools()).resolves.toEqual([
      expect.objectContaining({ enabled: true, id: 'native-read', source: 'native' }),
      expect.objectContaining({
        enabled: false,
        id: 'mcp-search',
        serverName: 'local',
        source: 'mcp',
      }),
    ]);
    await expect(operations.getStats()).resolves.toMatchObject({
      byCategory: expect.objectContaining({ action: 2, retrieval: 1 }),
      bySource: { mcp: 2, native: 1 },
      enabled: 2,
      total: 3,
    });

    await operations.enableTools(['native-read', 'mcp-search']);
    expect(setToolsEnabledMock).toHaveBeenCalledWith(['native-read'], true);
    expect(settings.request).toHaveBeenCalledWith('mcp/tools/set', {
      enabled: true,
      toolIds: ['mcp-search'],
    });

    await operations.disableTools(['native-read', 'mcp-search']);
    expect(setToolsEnabledMock).toHaveBeenCalledWith(['native-read'], false);
    expect(settings.request).toHaveBeenCalledWith('mcp/tools/set', {
      enabled: false,
      toolIds: ['mcp-search'],
    });

    await operations.resetTools();
    expect(resetToolsMock).toHaveBeenCalled();
    expect(settings.request).toHaveBeenCalledWith('mcp/tools/reset', {});

    await operations.refreshMcpServers();
    // Main's native picker hands the chosen file to the host, which selects it.
    await operations.openMcpConfig();
    expect(getDesktopWindow().mcp?.selectPath).toHaveBeenCalledOnce();
    expect(settings.request).not.toHaveBeenCalledWith('mcp/config/path/set', {
      path: '/tmp/selected.json',
    });
    await operations.resetMcpConfig();
    expect(settings.request).toHaveBeenCalledWith('mcp/config/path/set', { path: null });

    await expect(operations.getMcpConfigPath?.()).resolves.toBe('/tmp/mcp.json');
    await expect(operations.readMcpConfigText?.()).resolves.toEqual({
      content: '{}',
      created: false,
      error: 'invalid_mcp_config: servers: required',
      exists: true,
      path: '/tmp/mcp.json',
    });
    await expect(operations.writeMcpConfigText?.('{"servers":{}}')).resolves.toEqual({
      path: '/tmp/mcp.json',
      success: true,
    });
    expect(settings.request).toHaveBeenCalledWith('mcp/config/write', {
      content: '{"servers":{}}',
    });
    await expect(operations.getMcpConfigInfo()).resolves.toEqual({
      exists: true,
      path: '/tmp/mcp.json',
    });
    await expect(operations.createSampleConfig()).resolves.toEqual({
      path: '/tmp/sample.json',
      success: true,
    });

    expect(operations).not.toHaveProperty('executeToolTest');

    settings.request.mockRejectedValueOnce(
      new Error('MCP config path must be selected with the native file picker.')
    );
    await expect(operations.setMcpConfigPath?.('/tmp/bad.json')).rejects.toThrow(
      'MCP config path must be selected with the native file picker.'
    );
  });

  it('forwards user-initiated MCP content browsing to the agent host (BST-1585)', async () => {
    const operations = await renderOperations();
    const mcp = hostMcpContent.current;
    const authority = { configuredServerId: parseConfiguredMcpServerId('local'), generation: 1 };
    const readRequest = { authority, uri: 'linear://issue/BST-1585' };
    await expect(operations.readMcpResource?.(readRequest)).resolves.toMatchObject({
      type: 'resources/read',
    });
    expect(mcp?.readResource).toHaveBeenCalledWith(readRequest);
    const promptRequest = { arguments: { identifier: 'BST-1585' }, authority, name: 'summary' };
    await expect(operations.getMcpPrompt?.(promptRequest)).resolves.toMatchObject({
      type: 'prompts/get',
    });
    expect(mcp?.getPrompt).toHaveBeenCalledWith(promptRequest);
    const completeRequest = {
      argument: { name: 'identifier', value: 'BST' },
      authority,
      ref: { name: 'summary', type: 'ref/prompt' },
    };
    await expect(operations.completeMcpContent?.(completeRequest)).resolves.toMatchObject({
      type: 'completion/complete',
    });
    expect(mcp?.complete).toHaveBeenCalledWith(completeRequest);
  });

  it('omits MCP content browsing operations where the window has no agent host', async () => {
    hostMcpContent.current = null;
    const operations = await renderOperations();
    expect(operations).not.toHaveProperty('readMcpResource');
    expect(operations).not.toHaveProperty('getMcpPrompt');
    expect(operations).not.toHaveProperty('completeMcpContent');
    expect(operations).toHaveProperty('getMcpServerStatus');
  });

  it('reads server status from the agent host, hears its revisions, and runs control there', async () => {
    const operations = await renderOperations();
    const settings = requireSettings();
    const toolReads = settings.request.mock.calls.filter(([method]) => method === 'mcp/tools/list');
    if (
      !(
        operations.getMcpServerStatus &&
        operations.subscribeMcpServerStatus &&
        operations.controlMcpServer
      )
    ) {
      throw new Error('Expected the MCP server status operations');
    }
    await expect(operations.getMcpServerStatus()).resolves.toEqual(hostSnapshot);
    expect(settings.request).toHaveBeenCalledWith('mcp/status/read', {});
    expect(
      settings.request.mock.calls.filter(([method]) => method === 'mcp/tools/list')
    ).toHaveLength(toolReads.length);

    const disposer = vi.fn();
    settings.subscribe.mockReturnValueOnce(disposer);
    const listener = vi.fn();
    const unsubscribe = operations.subscribeMcpServerStatus(listener);
    const stream = settings.subscribe.mock.calls.at(-1)?.[0];
    stream?.({ status: hostSnapshot, type: 'status' });
    stream?.({ tools: {}, type: 'tools' });
    expect(listener.mock.calls).toEqual([[hostSnapshot]]);
    unsubscribe();
    expect(disposer).toHaveBeenCalledOnce();

    const request = {
      action: 'connect' as const,
      configuredServerId: hostSnapshot.servers[0].configuredServerId,
    };
    await expect(operations.controlMcpServer(request)).resolves.toEqual(hostSnapshot.servers[0]);
    expect(settings.request).toHaveBeenCalledWith('mcp/server/control', request);
  });

  it('hears config and tools changes from the host settings stream', async () => {
    const operations = await renderOperations();
    const settings = requireSettings();
    const unsubscribe = vi.fn();
    settings.subscribe.mockReturnValue(unsubscribe);

    const configListener = vi.fn();
    const stopConfig = operations.subscribeMcpConfig(configListener);
    const toolsListener = vi.fn();
    const stopTools = operations.subscribeMcpTools(toolsListener);
    const [configStream, toolsStream] = settings.subscribe.mock.calls.map(([listener]) => listener);
    const config = { exists: false, path: '/tmp/new-mcp.json' };
    configStream?.({ config, type: 'config' });
    configStream?.({ tools: {}, type: 'tools' });
    toolsStream?.({ tools: MCP_TOOLS, type: 'tools' });
    toolsStream?.({ config, type: 'config' });

    expect(configListener.mock.calls).toEqual([[config]]);
    expect(toolsListener).toHaveBeenCalledOnce();
    stopConfig();
    stopTools();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('exposes the global MCP extension dials backed by the agent host', async () => {
    const operations = await renderOperations();
    const settings = requireSettings();
    if (
      !(
        operations.getMcpExtensionPreferences &&
        operations.setMcpExtensionPreferences &&
        operations.subscribeMcpExtensionPreferences
      )
    ) {
      throw new Error('Expected the MCP extension dial operations');
    }

    await expect(operations.getMcpExtensionPreferences()).resolves.toEqual(extensionPreferences);
    expect(settings.request).toHaveBeenCalledWith('mcp/extensions/read', {});
    await expect(
      operations.setMcpExtensionPreferences({ apps: false, tasks: true })
    ).resolves.toEqual({ apps: false, tasks: true });
    expect(settings.request).toHaveBeenCalledWith('mcp/extensions/set', {
      apps: false,
      tasks: true,
    });

    const disposer = vi.fn();
    settings.subscribe.mockReturnValueOnce(disposer);
    const listener = vi.fn();
    const unsubscribe = operations.subscribeMcpExtensionPreferences(listener);
    const stream = settings.subscribe.mock.calls.at(-1)?.[0];
    stream?.({ extensions: { apps: false, tasks: false }, type: 'extensions' });
    stream?.({ tools: {}, type: 'tools' });
    expect(listener.mock.calls).toEqual([[{ apps: false, tasks: false }]]);
    unsubscribe();
    expect(disposer).toHaveBeenCalledOnce();
  });

  it('omits server status and control where the window has no agent host', async () => {
    hostMcpSettings.current = null;
    await renderOperations();

    expect(capturedOperations).not.toHaveProperty('getMcpServerStatus');
    expect(capturedOperations).not.toHaveProperty('subscribeMcpServerStatus');
    expect(capturedOperations).not.toHaveProperty('controlMcpServer');
  });

  it('rejects MCP tool projection identities that disagree with their group key', async () => {
    requireSettings().request.mockImplementation(async (method) =>
      method === 'mcp/tools/list'
        ? {
            local: [
              {
                discoveredAt: 1,
                enabled: true,
                id: 'local.search',
                serverName: 'different-server',
              },
            ],
          }
        : undefined
    );
    const operations = await renderOperations();

    await expect(operations.getTools()).rejects.toThrow(
      'MCP tool projection identity mismatch: group "local" contains server "different-server"'
    );
  });

  it('passes status provider key sources into the Assistant Memory category', async () => {
    getDesktopWindow().assistant = { url: 'http://127.0.0.1:4111' };
    assistantAvailability.current = {
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
      providers: ['openai', 'local'],
      state: 'enabled',
    };
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createAssistantMemorySettingsCategoryMock).toHaveBeenCalledWith({
      assistantMemoryBackendAvailable: true,
      providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
    });
    // The Model Catalog page no longer carries the memory settings.
    expect(modelSelectionPageMock).toHaveBeenCalledWith({}, undefined);
  });

  it('omits provider key sources from Assistant Memory while availability is loading', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createAssistantMemorySettingsCategoryMock).toHaveBeenLastCalledWith({
      assistantMemoryBackendAvailable: expect.any(Boolean),
    });
  });

  it('lists Assistant Memory right after Model Catalog', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    const { getAllByTestId } = render(<SettingsPageContent />);

    const titles = getAllByTestId('settings-category-title').map((node) => node.textContent);
    expect(titles.indexOf('Assistant Memory')).toBe(titles.indexOf('Model Catalog') + 1);
  });

  it('threads the live mounted workspace roots into the Hooks settings category', async () => {
    fileExplorerMockState.current = {
      activeRootIds: ['root-b', 'root-a'],
      devInlineFixtureEnabled: true,
      rootDescriptors: {
        'root-a': { displayName: 'Workspace A', path: '/ws/a', rootId: 'root-a' },
        'root-b': { displayName: 'Workspace B', path: '/ws/b', rootId: 'root-b' },
      },
      setDevInlineFixtureEnabled: () => {},
    };

    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    // Roots follow activeRootIds order (sidebar order), keyed by durable rootId.
    expect(createHooksSettingsCategoryMock).toHaveBeenCalledWith({
      roots: [
        { absPath: '/ws/b', displayName: 'Workspace B', rootId: 'root-b' },
        { absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a' },
      ],
    });
  });

  it('passes an empty roots list to the Hooks category when nothing is mounted', async () => {
    const { default: SettingsPageContent } = await import(
      '../../../../renderer/components/settings/page-content'
    );

    render(<SettingsPageContent />);

    expect(createHooksSettingsCategoryMock).toHaveBeenCalledWith({ roots: [] });
  });
});
